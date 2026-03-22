/**
 * Whale Monitor — polls the Data API for new trades from tracked whales
 * and emits copy signals when they enter new positions.
 */
import axios from "axios";
import { Logger } from "./logger";
import { WhaleConfig, WhaleProfile, WhaleTrade, CopySignal, WhaleProfileAnalysis } from "./whale-types";
import { WhaleProfiler } from "./whale-profiler";

const DATA_API_URL = "https://data-api.polymarket.com";

export class WhaleMonitor {
  private config: WhaleConfig;
  private logger: Logger;
  /** Last seen trade timestamp per wallet (to detect new trades) */
  private lastSeenTimestamp: Map<string, number> = new Map();
  /** Callbacks for copy signals */
  private signalHandlers: Array<(signal: CopySignal) => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;
  /** Whale profile analyses (for conviction-weighted confidence) */
  private whaleAnalyses: Map<string, WhaleProfileAnalysis> = new Map();
  /** Profiler instance for category inference */
  private profiler: WhaleProfiler;

  constructor(config: WhaleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.profiler = new WhaleProfiler(logger);
  }

  /**
   * Fetch recent trades for a specific wallet.
   */
  async fetchWhaleTrades(wallet: string, limit = 100): Promise<WhaleTrade[]> {
    try {
      const response = await axios.get(`${DATA_API_URL}/trades`, {
        params: {
          user: wallet,
          limit,
          takerOnly: true,
        },
        timeout: 15000,
      });

      if (!response.data || !Array.isArray(response.data)) return [];

      return response.data.map((t: Record<string, unknown>) => ({
        proxyWallet: (String(t.proxyWallet) || wallet).toLowerCase(),
        side: t.side as "BUY" | "SELL",
        conditionId: String(t.conditionId) || "",
        asset: String(t.asset) || "",
        size: Number(t.size) || 0,
        price: Number(t.price) || 0,
        timestamp: Number(t.timestamp) || 0,
        title: String(t.title) || "",
        slug: String(t.slug) || "",
        eventSlug: String(t.eventSlug) || "",
        outcome: String(t.outcome) || "",
        outcomeIndex: Number(t.outcomeIndex) || 0,
        transactionHash: t.transactionHash ? String(t.transactionHash) : undefined,
        usdcValue: (Number(t.size) || 0) * (Number(t.price) || 0),
      }));
    } catch (error) {
      this.logger.error(`Failed to fetch trades for ${wallet.slice(0, 10)}...: ${error}`);
      return [];
    }
  }

  /**
   * Check a single whale for new trades and emit copy signals.
   */
  async checkWhale(whale: WhaleProfile): Promise<CopySignal[]> {
    const trades = await this.fetchWhaleTrades(whale.proxyWallet);
    if (trades.length === 0) return [];

    const lastSeen = this.lastSeenTimestamp.get(whale.proxyWallet) || 0;
    const newTrades = trades.filter((t) => t.timestamp > lastSeen);

    if (newTrades.length > 0) {
      // Update last seen timestamp
      const maxTs = Math.max(...newTrades.map((t) => t.timestamp));
      this.lastSeenTimestamp.set(whale.proxyWallet, maxTs);
    }

    // Skip DEGENERATE profiles — no edge to copy
    const analysis = this.whaleAnalyses.get(whale.proxyWallet.toLowerCase());
    if (analysis && analysis.traderType === "DEGENERATE") {
      return [];
    }

    // Only generate signals for BUY trades (we follow their entries)
    // Also filter out excluded categories (e.g. sports)
    const buyTrades = newTrades.filter((t) => {
      if (t.side !== "BUY") return false;
      if (this.config.excludeCategories.length > 0) {
        const category = this.profiler.inferCategory(t);
        if (this.config.excludeCategories.includes(category)) return false;
      }
      return true;
    });
    const signals: CopySignal[] = [];

    for (const trade of buyTrades) {
      const now = Date.now();
      const tradeAgeMs = now - trade.timestamp * 1000;

      // Skip trades that are too old to copy
      if (tradeAgeMs > this.config.maxCopyDelayMs) continue;

      // Calculate confidence based on whale's rank, PnL, and profiler conviction
      const confidence = this.calculateConfidence(whale);

      if (confidence < this.config.minConfidence) continue;

      // Calculate suggested copy size
      const whaleUsdcValue = trade.usdcValue;
      const copySize = Math.min(
        whaleUsdcValue * this.config.copySizeFraction,
        this.config.maxCopySizeUsdc
      );

      if (copySize < 1) continue; // Skip dust trades

      const signal: CopySignal = {
        whaleTrade: trade,
        whaleProfile: whale,
        confidence,
        suggestedSizeUsdc: copySize,
        delayMs: tradeAgeMs,
        generatedAt: now,
      };

      signals.push(signal);

      this.logger.info(
        `Copy signal: ${whale.userName} (#${whale.rank}) bought ${trade.outcome} ` +
        `on "${trade.title}" — $${whaleUsdcValue.toFixed(2)} @ $${trade.price.toFixed(4)} ` +
        `(confidence: ${(confidence * 100).toFixed(0)}%, copy size: $${copySize.toFixed(2)})`
      );

      // Emit to handlers
      for (const handler of this.signalHandlers) {
        handler(signal);
      }
    }

    return signals;
  }

  /**
   * Poll all tracked whales for new trades.
   */
  async pollAll(whales: WhaleProfile[]): Promise<CopySignal[]> {
    const allSignals: CopySignal[] = [];

    for (const whale of whales) {
      if (!whale.isActive) continue;

      const signals = await this.checkWhale(whale);
      for (const s of signals) {
        allSignals.push(s);
      }

      // Rate limit: small delay between wallets
      await sleep(100);
    }

    return allSignals;
  }

  /**
   * Start continuous polling loop.
   */
  startPolling(getWhales: () => WhaleProfile[]): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      try {
        const whales = getWhales();
        const signals = await this.pollAll(whales);
        if (signals.length > 0) {
          this.logger.success(`Detected ${signals.length} copy signal(s) this cycle.`);
        }
      } catch (error) {
        this.logger.error(`Polling cycle error: ${error}`);
      }
    }, this.config.tradePollingMs);
  }

  /** Stop polling. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Register a handler for copy signals. */
  onSignal(handler: (signal: CopySignal) => void): void {
    this.signalHandlers.push(handler);
  }

  /**
   * Initialize last-seen timestamps so we don't re-emit old trades.
   * Call this after discovering whales but before starting the poll loop.
   */
  async initializeTimestamps(whales: WhaleProfile[]): Promise<void> {
    this.logger.info("Initializing trade timestamps for tracked whales...");

    for (const whale of whales) {
      const trades = await this.fetchWhaleTrades(whale.proxyWallet, 1);
      if (trades.length > 0) {
        this.lastSeenTimestamp.set(whale.proxyWallet, trades[0].timestamp);
      }
      await sleep(100);
    }

    this.logger.success(`Initialized timestamps for ${whales.length} whales.`);
  }

  /**
   * Set whale profile analyses for conviction-weighted confidence.
   */
  setWhaleAnalyses(analyses: WhaleProfileAnalysis[]): void {
    this.whaleAnalyses.clear();
    for (const a of analyses) {
      this.whaleAnalyses.set(a.proxyWallet.toLowerCase(), a);
    }
  }

  /**
   * Calculate confidence score for a whale (0-1).
   * Combines rank/PnL signals with profiler conviction score.
   */
  private calculateConfidence(whale: WhaleProfile): number {
    // Rank-based score (top 10 = high confidence)
    const rankScore = Math.max(0, 1 - (whale.rank - 1) / 100);

    // PnL-based score (higher PnL = higher confidence)
    const pnlScore = Math.min(1, whale.pnl / 100000); // Cap at $100K

    // Base confidence from rank + PnL
    const baseConfidence = rankScore * 0.6 + pnlScore * 0.4;

    // If we have a profiler analysis, blend in the conviction score
    const analysis = this.whaleAnalyses.get(whale.proxyWallet.toLowerCase());
    if (analysis && analysis.convictionScore > 0) {
      // 60% base confidence, 40% profiler conviction
      return baseConfidence * 0.6 + analysis.convictionScore * 0.4;
    }

    return baseConfidence;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
