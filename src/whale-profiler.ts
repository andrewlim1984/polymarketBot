/**
 * Whale Profiler — analyzes whale trading behavior to classify trader types
 * and calculate conviction scores for smarter copy-trading decisions.
 *
 * Classification types:
 *   INSIDER       — Wins on low-probability bets in narrow categories
 *   QUANT         — Consistently profitable across many categories
 *   MARKET_MAKER  — High volume, balanced buy/sell, small margins
 *   DEGENERATE    — Low win rate, random categories, inconsistent sizing
 *   WALLET_FOLLOWER — Trades mirror another whale's trades with slight delay
 *   UNKNOWN       — Not enough data to classify
 */
import axios from "axios";
import { Logger } from "./logger";
import {
  WhaleProfile,
  WhaleTrade,
  WhaleProfileAnalysis,
  CategoryStats,
  TraderType,
} from "./whale-types";

const DATA_API_URL = "https://data-api.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

interface MarketOutcome {
  conditionId: string;
  resolved: boolean;
  winningOutcome: number; // -1 if unresolved
  outcomePrices: number[];
}

export class WhaleProfiler {
  private logger: Logger;
  /** Cache market resolution data */
  private marketCache: Map<string, MarketOutcome> = new Map();
  /** Minimum trades needed for reliable classification */
  private minTradesForClassification: number;

  constructor(logger: Logger, minTrades = 10) {
    this.logger = logger;
    this.minTradesForClassification = minTrades;
  }

  /**
   * Profile a whale by fetching their trade history and analyzing behavior.
   * @param whale - The whale profile from the leaderboard
   * @param existingTrades - Pre-fetched trades (optional, avoids re-fetching)
   * @param allWhales - All tracked whales (for wallet-follower detection)
   */
  async profileWhale(
    whale: WhaleProfile,
    existingTrades?: WhaleTrade[],
    allWhales?: WhaleProfile[]
  ): Promise<WhaleProfileAnalysis> {
    const trades = existingTrades || await this.fetchAllTrades(whale.proxyWallet);

    if (trades.length === 0) {
      return this.emptyProfile(whale);
    }

    // Sort trades by timestamp ascending
    trades.sort((a, b) => a.timestamp - b.timestamp);

    // 1. Wallet age
    const firstTradeTs = trades[0].timestamp;
    const walletAgeDays = Math.max(1, (Date.now() / 1000 - firstTradeTs) / 86400);

    // 2. Trade counts
    const buyTrades = trades.filter((t) => t.side === "BUY");
    const sellTrades = trades.filter((t) => t.side === "SELL");

    // 3. Resolve markets to determine wins/losses
    const tradeOutcomes = await this.resolveTradeOutcomes(trades);

    // 4. Win rate calculations
    const { rawWinRate, weightedWinRate } = this.calculateWinRates(tradeOutcomes);

    // 5. Bet sizing analysis
    const sizes = trades.map((t) => t.usdcValue);
    const avgTradeSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const tradeSizeStdDev = this.stdDev(sizes);
    const maxTradeSize = Math.max(...sizes);
    const sizingConsistency = avgTradeSize > 0
      ? Math.max(0, 1 - tradeSizeStdDev / avgTradeSize)
      : 0;

    // 6. Trade frequency
    const tradesPerDay = trades.length / walletAgeDays;

    // 7. Category analysis
    const categoryStats = this.analyzeCategoryPerformance(tradeOutcomes);
    const categoryCount = categoryStats.length;
    const categoryConcentration = this.herfindahlIndex(categoryStats);
    const primaryCategory = categoryStats.length > 0
      ? categoryStats.sort((a, b) => b.trades - a.trades)[0].category
      : "unknown";

    // 8. Classify trader type
    const { traderType, classificationConfidence, explanation } = this.classify({
      trades,
      buyTrades: buyTrades.length,
      sellTrades: sellTrades.length,
      rawWinRate,
      weightedWinRate,
      avgTradeSize,
      sizingConsistency,
      tradesPerDay,
      categoryStats,
      categoryCount,
      categoryConcentration,
      walletAgeDays,
      allWhales,
    });

    // 9. Conviction score (how much should we trust this whale for copy-trading?)
    const convictionScore = this.calculateConviction({
      traderType,
      classificationConfidence,
      weightedWinRate,
      walletAgeDays,
      totalTrades: trades.length,
      rawWinRate,
      categoryConcentration,
    });

    return {
      proxyWallet: whale.proxyWallet,
      userName: whale.userName,
      walletAgeDays: Math.round(walletAgeDays),
      firstTradeTimestamp: firstTradeTs,
      totalTrades: trades.length,
      buyTrades: buyTrades.length,
      sellTrades: sellTrades.length,
      rawWinRate,
      weightedWinRate,
      avgTradeSize,
      tradeSizeStdDev,
      maxTradeSize,
      sizingConsistency,
      tradesPerDay,
      categoryStats,
      categoryCount,
      categoryConcentration,
      primaryCategory,
      traderType,
      classificationConfidence,
      convictionScore,
      explanation,
    };
  }

  /**
   * Profile multiple whales in batch.
   */
  async profileAll(
    whales: WhaleProfile[],
    tradesByWallet?: Map<string, WhaleTrade[]>
  ): Promise<WhaleProfileAnalysis[]> {
    const profiles: WhaleProfileAnalysis[] = [];

    for (let i = 0; i < whales.length; i++) {
      const whale = whales[i];
      this.logger.info(
        `  Profiling ${i + 1}/${whales.length}: ${whale.userName} (${whale.proxyWallet.slice(0, 10)}...)`
      );

      const trades = tradesByWallet?.get(whale.proxyWallet);
      const profile = await this.profileWhale(whale, trades, whales);
      profiles.push(profile);

      await sleep(100);
    }

    return profiles;
  }

  /**
   * Fetch all trades for a wallet (BUY and SELL, up to 1000).
   */
  private async fetchAllTrades(wallet: string): Promise<WhaleTrade[]> {
    const allTrades: WhaleTrade[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      try {
        const response = await axios.get(`${DATA_API_URL}/trades`, {
          params: { user: wallet, limit, offset },
          timeout: 15000,
        });

        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) break;

        for (const t of response.data) {
          allTrades.push({
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
          });
        }

        if (response.data.length < limit) break;
        offset += response.data.length;
        await sleep(200);
      } catch (error) {
        this.logger.error(`Failed to fetch trades for ${wallet.slice(0, 10)}...: ${error}`);
        break;
      }
    }

    return allTrades;
  }

  /**
   * Resolve trade outcomes by checking market resolution status.
   * Returns trades annotated with win/loss status.
   */
  private async resolveTradeOutcomes(
    trades: WhaleTrade[]
  ): Promise<Array<WhaleTrade & { won: boolean | null; resolved: boolean }>> {
    const results: Array<WhaleTrade & { won: boolean | null; resolved: boolean }> = [];
    const seenConditions = new Set<string>();

    for (const trade of trades) {
      // Only resolve unique condition IDs (batch per market)
      if (!seenConditions.has(trade.conditionId)) {
        seenConditions.add(trade.conditionId);
        await this.resolveMarket(trade.conditionId);
      }

      const market = this.marketCache.get(trade.conditionId);
      if (market && market.resolved) {
        // For BUY trades: won if the outcome they bought resolved to $1
        // For SELL trades: won if the outcome they sold resolved to $0
        const isWinningOutcome = market.winningOutcome === trade.outcomeIndex;
        const won = trade.side === "BUY" ? isWinningOutcome : !isWinningOutcome;
        results.push({ ...trade, won, resolved: true });
      } else {
        results.push({ ...trade, won: null, resolved: false });
      }
    }

    return results;
  }

  /**
   * Fetch market resolution status from Gamma API.
   */
  private async resolveMarket(conditionId: string): Promise<void> {
    if (this.marketCache.has(conditionId)) return;

    try {
      const response = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { condition_id: conditionId },
        timeout: 10000,
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        this.marketCache.set(conditionId, {
          conditionId,
          resolved: false,
          winningOutcome: -1,
          outcomePrices: [],
        });
        return;
      }

      const m = response.data[0];
      const outcomePrices: number[] = JSON.parse(m.outcomePrices || "[]").map(Number);
      const resolved = m.closed === true || m.resolutionSource != null;

      // Determine winning outcome: the one with price = 1.0 (or closest to it)
      let winningOutcome = -1;
      if (resolved && outcomePrices.length > 0) {
        let maxPrice = 0;
        for (let i = 0; i < outcomePrices.length; i++) {
          if (outcomePrices[i] > maxPrice) {
            maxPrice = outcomePrices[i];
            winningOutcome = i;
          }
        }
        // Only count as resolved if one outcome is clearly the winner (>0.9)
        if (maxPrice < 0.9) {
          winningOutcome = -1;
        }
      }

      this.marketCache.set(conditionId, {
        conditionId,
        resolved: resolved && winningOutcome >= 0,
        winningOutcome,
        outcomePrices,
      });

      await sleep(100);
    } catch {
      this.marketCache.set(conditionId, {
        conditionId,
        resolved: false,
        winningOutcome: -1,
        outcomePrices: [],
      });
    }
  }

  /**
   * Calculate raw and weighted win rates.
   *
   * Weighted win rate: wins at low probability (e.g., 5%) are weighted much
   * more heavily than wins at high probability (e.g., 99%). This surfaces
   * wallets with genuine alpha / insider info.
   *
   * Weight formula: 1 / entryPrice (capped at 20x for very low prices)
   * - Win at $0.05: weight = 20 (max cap)
   * - Win at $0.10: weight = 10
   * - Win at $0.50: weight = 2
   * - Win at $0.90: weight = 1.11
   * - Win at $0.99: weight = 1.01
   */
  private calculateWinRates(
    trades: Array<WhaleTrade & { won: boolean | null; resolved: boolean }>
  ): { rawWinRate: number; weightedWinRate: number } {
    const resolvedTrades = trades.filter((t) => t.resolved && t.won !== null);
    if (resolvedTrades.length === 0) return { rawWinRate: 0, weightedWinRate: 0 };

    const wins = resolvedTrades.filter((t) => t.won === true);
    const rawWinRate = wins.length / resolvedTrades.length;

    // Weighted win rate
    let totalWeight = 0;
    let weightedWins = 0;

    for (const trade of resolvedTrades) {
      // Weight = inverse of entry price (how unlikely the bet was)
      const price = Math.max(0.05, trade.price); // Floor at 5% to cap weight at 20
      const weight = 1 / price;
      totalWeight += weight;
      if (trade.won) {
        weightedWins += weight;
      }
    }

    const weightedWinRate = totalWeight > 0 ? weightedWins / totalWeight : 0;

    return { rawWinRate, weightedWinRate };
  }

  /**
   * Analyze per-category performance.
   * Categories are derived from event slugs (e.g., "sports", "politics", "crypto").
   */
  private analyzeCategoryPerformance(
    trades: Array<WhaleTrade & { won: boolean | null; resolved: boolean }>
  ): CategoryStats[] {
    const categoryMap = new Map<string, {
      trades: number;
      wins: number;
      pnl: number;
      weightedWinSum: number;
      weightedTotal: number;
    }>();

    for (const trade of trades) {
      const category = this.inferCategory(trade);
      const existing = categoryMap.get(category) || {
        trades: 0, wins: 0, pnl: 0, weightedWinSum: 0, weightedTotal: 0,
      };

      existing.trades += 1;

      if (trade.resolved && trade.won !== null) {
        const price = Math.max(0.05, trade.price);
        const weight = 1 / price;
        existing.weightedTotal += weight;

        if (trade.won) {
          existing.wins += 1;
          existing.pnl += trade.usdcValue * (1 / trade.price - 1); // Approximate profit
          existing.weightedWinSum += weight;
        } else {
          existing.pnl -= trade.usdcValue;
        }
      }

      categoryMap.set(category, existing);
    }

    const stats: CategoryStats[] = [];
    for (const [category, data] of categoryMap.entries()) {
      stats.push({
        category,
        trades: data.trades,
        wins: data.wins,
        winRate: data.trades > 0 ? data.wins / data.trades : 0,
        pnl: data.pnl,
        weightedWinRate: data.weightedTotal > 0 ? data.weightedWinSum / data.weightedTotal : 0,
      });
    }

    // Sort by trade count descending
    stats.sort((a, b) => b.trades - a.trades);
    return stats;
  }

  /**
   * Infer category from event slug or title.
   * Uses common Polymarket category keywords.
   */
  inferCategory(trade: WhaleTrade): string {
    const slug = (trade.eventSlug || trade.slug || "").toLowerCase();
    const title = trade.title.toLowerCase();
    const text = `${slug} ${title}`;

    if (/trump|biden|election|congress|senate|democrat|republican|politic|vote|president|governor/.test(text)) {
      return "politics";
    }
    if (/nfl|nba|mlb|nhl|soccer|football|baseball|basketball|tennis|ufc|mma|win on 20|match|game|league|championship/.test(text)) {
      return "sports";
    }
    if (/bitcoin|ethereum|btc|eth|crypto|token|defi|solana|sol|blockchain/.test(text)) {
      return "crypto";
    }
    if (/openai|gpt|ai |artificial intelligence|model|llm|anthropic|google ai/.test(text)) {
      return "ai_tech";
    }
    if (/fed|interest rate|inflation|cpi|gdp|unemployment|economic|recession|tariff/.test(text)) {
      return "economics";
    }
    if (/movie|tv|oscar|grammy|album|celebrity|kardashian|music|entertainment/.test(text)) {
      return "pop_culture";
    }
    if (/weather|temperature|climate|hurricane|earthquake/.test(text)) {
      return "weather";
    }
    if (/spacex|nasa|mars|moon|launch|rocket|space/.test(text)) {
      return "space";
    }

    return "other";
  }

  /**
   * Calculate Herfindahl index for category concentration.
   * 0 = perfectly diversified, 1 = single category
   */
  private herfindahlIndex(categoryStats: CategoryStats[]): number {
    if (categoryStats.length === 0) return 0;
    const totalTrades = categoryStats.reduce((s, c) => s + c.trades, 0);
    if (totalTrades === 0) return 0;

    let hhi = 0;
    for (const cat of categoryStats) {
      const share = cat.trades / totalTrades;
      hhi += share * share;
    }

    return hhi;
  }

  /**
   * Classify the trader type based on all computed metrics.
   */
  private classify(params: {
    trades: WhaleTrade[];
    buyTrades: number;
    sellTrades: number;
    rawWinRate: number;
    weightedWinRate: number;
    avgTradeSize: number;
    sizingConsistency: number;
    tradesPerDay: number;
    categoryStats: CategoryStats[];
    categoryCount: number;
    categoryConcentration: number;
    walletAgeDays: number;
    allWhales?: WhaleProfile[];
  }): { traderType: TraderType; classificationConfidence: number; explanation: string } {
    const {
      trades, buyTrades, sellTrades, rawWinRate, weightedWinRate,
      tradesPerDay, categoryStats, categoryCount,
      categoryConcentration, walletAgeDays,
    } = params;

    // Not enough data to classify
    if (trades.length < this.minTradesForClassification) {
      return {
        traderType: "UNKNOWN",
        classificationConfidence: 0,
        explanation: `Only ${trades.length} trades — need at least ${this.minTradesForClassification} for classification.`,
      };
    }

    // Score each type and pick the highest
    const scores: Array<{ type: TraderType; score: number; explanation: string }> = [];

    // --- INSIDER detection ---
    // High weighted win rate + concentrated in 1-2 categories + wins on low-probability bets
    {
      let score = 0;
      const reasons: string[] = [];

      // Strong signal: weighted win rate much higher than raw (winning unlikely bets)
      const weightedVsRaw = rawWinRate > 0 ? weightedWinRate / rawWinRate : 0;
      if (weightedVsRaw > 1.5) {
        score += 0.3;
        reasons.push(`weighted win rate ${(weightedVsRaw).toFixed(1)}x higher than raw (winning unlikely bets)`);
      }

      // Concentrated in few categories
      if (categoryConcentration > 0.5 && categoryCount <= 3) {
        score += 0.25;
        reasons.push(`concentrated in ${categoryCount} category(s) (HHI=${categoryConcentration.toFixed(2)})`);
      }

      // Has a standout category with very high weighted win rate
      const standoutCats = categoryStats.filter((c) => c.weightedWinRate > 0.6 && c.trades >= 5);
      if (standoutCats.length > 0) {
        score += 0.25;
        reasons.push(`standout in ${standoutCats.map((c) => c.category).join(", ")} (weighted WR > 60%)`);
      }

      // High overall weighted win rate
      if (weightedWinRate > 0.5) {
        score += 0.2;
        reasons.push(`high weighted win rate (${(weightedWinRate * 100).toFixed(0)}%)`);
      }

      scores.push({
        type: "INSIDER",
        score,
        explanation: reasons.length > 0 ? reasons.join("; ") : "no insider signals",
      });
    }

    // --- QUANT detection ---
    // Profitable across many categories, consistent sizing, high trade frequency
    {
      let score = 0;
      const reasons: string[] = [];

      // Profitable in multiple categories
      const profitableCats = categoryStats.filter((c) => c.pnl > 0 && c.trades >= 3);
      if (profitableCats.length >= 3) {
        score += 0.3;
        reasons.push(`profitable in ${profitableCats.length} categories`);
      }

      // Diversified (low concentration)
      if (categoryConcentration < 0.4 && categoryCount >= 3) {
        score += 0.2;
        reasons.push(`diversified across ${categoryCount} categories (HHI=${categoryConcentration.toFixed(2)})`);
      }

      // Good raw win rate across the board
      if (rawWinRate > 0.55) {
        score += 0.2;
        reasons.push(`solid win rate (${(rawWinRate * 100).toFixed(0)}%)`);
      }

      // Consistent sizing (suggests systematic approach)
      if (params.sizingConsistency > 0.5) {
        score += 0.15;
        reasons.push(`consistent bet sizing (${(params.sizingConsistency * 100).toFixed(0)}%)`);
      }

      // High volume
      if (tradesPerDay > 5) {
        score += 0.15;
        reasons.push(`high frequency (${tradesPerDay.toFixed(1)} trades/day)`);
      }

      scores.push({
        type: "QUANT",
        score,
        explanation: reasons.length > 0 ? reasons.join("; ") : "no quant signals",
      });
    }

    // --- MARKET_MAKER detection ---
    // Balanced buy/sell, very high frequency, small margins
    {
      let score = 0;
      const reasons: string[] = [];

      const totalTrades = buyTrades + sellTrades;
      const buyRatio = totalTrades > 0 ? buyTrades / totalTrades : 0;

      // Balanced buy/sell (close to 50/50)
      if (buyRatio > 0.35 && buyRatio < 0.65) {
        score += 0.3;
        reasons.push(`balanced buy/sell ratio (${(buyRatio * 100).toFixed(0)}% buys)`);
      }

      // Very high frequency
      if (tradesPerDay > 20) {
        score += 0.3;
        reasons.push(`very high frequency (${tradesPerDay.toFixed(0)} trades/day)`);
      } else if (tradesPerDay > 10) {
        score += 0.15;
        reasons.push(`high frequency (${tradesPerDay.toFixed(0)} trades/day)`);
      }

      // Win rate close to 50% (market making is near break-even per trade)
      if (rawWinRate > 0.4 && rawWinRate < 0.6) {
        score += 0.2;
        reasons.push(`near-50% win rate (${(rawWinRate * 100).toFixed(0)}%) — typical for MM`);
      }

      // Consistent sizing
      if (params.sizingConsistency > 0.6) {
        score += 0.2;
        reasons.push("highly consistent bet sizing");
      }

      scores.push({
        type: "MARKET_MAKER",
        score,
        explanation: reasons.length > 0 ? reasons.join("; ") : "no market maker signals",
      });
    }

    // --- DEGENERATE detection ---
    // Low win rate, random categories, inconsistent sizing, bets on long shots
    {
      let score = 0;
      const reasons: string[] = [];

      // Low win rate
      if (rawWinRate < 0.35) {
        score += 0.3;
        reasons.push(`low win rate (${(rawWinRate * 100).toFixed(0)}%)`);
      }

      // Inconsistent sizing
      if (params.sizingConsistency < 0.3) {
        score += 0.2;
        reasons.push(`inconsistent bet sizing (${(params.sizingConsistency * 100).toFixed(0)}%)`);
      }

      // Spread across random categories
      if (categoryConcentration < 0.3 && categoryCount >= 4) {
        score += 0.15;
        reasons.push(`scattered across ${categoryCount} categories`);
      }

      // Low weighted win rate (bad at picking long shots)
      if (weightedWinRate < 0.3) {
        score += 0.2;
        reasons.push(`low weighted win rate (${(weightedWinRate * 100).toFixed(0)}%)`);
      }

      // Short wallet age
      if (walletAgeDays < 14) {
        score += 0.15;
        reasons.push(`new wallet (${Math.round(walletAgeDays)} days old)`);
      }

      scores.push({
        type: "DEGENERATE",
        score,
        explanation: reasons.length > 0 ? reasons.join("; ") : "no degenerate signals",
      });
    }

    // --- WALLET_FOLLOWER detection ---
    // Trades mirror another whale's trades with a slight delay
    {
      let score = 0;
      const reasons: string[] = [];

      // This requires comparing against other whales' trades
      // For now, use heuristics: mostly buys, same markets as top whales
      if (buyTrades > 0 && sellTrades === 0) {
        score += 0.1;
        reasons.push("only BUY trades (no selling, just following)");
      }

      // Very high buy ratio with moderate frequency
      const totalTrades = buyTrades + sellTrades;
      const buyRatio = totalTrades > 0 ? buyTrades / totalTrades : 0;
      if (buyRatio > 0.9 && tradesPerDay > 3) {
        score += 0.15;
        reasons.push(`${(buyRatio * 100).toFixed(0)}% buy ratio with ${tradesPerDay.toFixed(1)} trades/day`);
      }

      // Win rate similar to top whales (if they're just copying)
      if (rawWinRate > 0.45 && rawWinRate < 0.65 && categoryConcentration < 0.5) {
        score += 0.1;
        reasons.push("moderate win rate across diverse categories (consistent with following)");
      }

      scores.push({
        type: "WALLET_FOLLOWER",
        score,
        explanation: reasons.length > 0 ? reasons.join("; ") : "no follower signals",
      });
    }

    // Pick the highest-scoring type
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const secondBest = scores[1];

    // Confidence is based on how much the top type leads the second
    const confidence = best.score > 0
      ? Math.min(1, best.score * (1 + (best.score - secondBest.score)))
      : 0;

    return {
      traderType: best.score >= 0.2 ? best.type : "UNKNOWN",
      classificationConfidence: confidence,
      explanation: best.explanation,
    };
  }

  /**
   * Calculate conviction score for copy-trading.
   * Higher = more worth following.
   *
   * Weights:
   *   - INSIDER with high confidence → highest conviction (they have edge)
   *   - QUANT → high conviction (systematic edge)
   *   - MARKET_MAKER → low conviction (no directional edge)
   *   - DEGENERATE → very low conviction
   *   - WALLET_FOLLOWER → moderate conviction (they're copying someone good)
   */
  private calculateConviction(params: {
    traderType: TraderType;
    classificationConfidence: number;
    weightedWinRate: number;
    walletAgeDays: number;
    totalTrades: number;
    rawWinRate: number;
    categoryConcentration: number;
  }): number {
    const {
      traderType, classificationConfidence, weightedWinRate,
      walletAgeDays, totalTrades, rawWinRate,
    } = params;

    // Base score by trader type
    let base: number;
    switch (traderType) {
      case "INSIDER":
        base = 0.85;
        break;
      case "QUANT":
        base = 0.75;
        break;
      case "WALLET_FOLLOWER":
        base = 0.45;
        break;
      case "MARKET_MAKER":
        base = 0.20;
        break;
      case "DEGENERATE":
        base = 0.10;
        break;
      case "UNKNOWN":
      default:
        base = 0.30;
        break;
    }

    // Modifiers
    let modifier = 0;

    // Weighted win rate bonus (max +0.15)
    modifier += Math.min(0.15, weightedWinRate * 0.2);

    // Wallet age bonus (older = more trustworthy, max +0.05)
    modifier += Math.min(0.05, walletAgeDays / 365 * 0.05);

    // Trade count bonus (more data = more reliable, max +0.05)
    modifier += Math.min(0.05, totalTrades / 200 * 0.05);

    // Classification confidence multiplier
    const score = (base + modifier) * (0.5 + 0.5 * classificationConfidence);

    return Math.min(1, Math.max(0, score));
  }

  /**
   * Print a formatted profile report for a single whale.
   */
  printProfile(profile: WhaleProfileAnalysis): void {
    const typeEmoji: Record<TraderType, string> = {
      INSIDER: "[INSIDER]",
      QUANT: "[QUANT]",
      MARKET_MAKER: "[MM]",
      DEGENERATE: "[DEGEN]",
      WALLET_FOLLOWER: "[FOLLOWER]",
      UNKNOWN: "[???]",
    };

    console.log(
      `  ${typeEmoji[profile.traderType]} ${profile.userName} ` +
      `(${profile.proxyWallet.slice(0, 10)}...) — ` +
      `Conviction: ${(profile.convictionScore * 100).toFixed(0)}%`
    );
    console.log(
      `    Age: ${profile.walletAgeDays}d | ` +
      `Trades: ${profile.totalTrades} (${profile.tradesPerDay.toFixed(1)}/day) | ` +
      `Win: ${(profile.rawWinRate * 100).toFixed(0)}% raw, ${(profile.weightedWinRate * 100).toFixed(0)}% weighted`
    );
    console.log(
      `    Avg Size: $${profile.avgTradeSize.toFixed(0)} | ` +
      `Max: $${profile.maxTradeSize.toFixed(0)} | ` +
      `Consistency: ${(profile.sizingConsistency * 100).toFixed(0)}%`
    );
    console.log(
      `    Categories: ${profile.categoryCount} (${profile.primaryCategory}) | ` +
      `Concentration: ${(profile.categoryConcentration * 100).toFixed(0)}% HHI`
    );
    console.log(
      `    Classification: ${profile.traderType} ` +
      `(${(profile.classificationConfidence * 100).toFixed(0)}% confidence)`
    );
    console.log(`    Reason: ${profile.explanation}`);

    // Per-category breakdown (top 3)
    if (profile.categoryStats.length > 0) {
      const top3 = profile.categoryStats.slice(0, 3);
      for (const cat of top3) {
        console.log(
          `      ${cat.category}: ${cat.trades} trades, ` +
          `${(cat.winRate * 100).toFixed(0)}% WR, ` +
          `${(cat.weightedWinRate * 100).toFixed(0)}% weighted WR, ` +
          `$${cat.pnl.toFixed(0)} PnL`
        );
      }
    }
  }

  /**
   * Print a summary table of all profiled whales.
   */
  printSummary(profiles: WhaleProfileAnalysis[]): void {
    console.log("\n--- Whale Profiles ---");
    console.log(
      "  " +
      "Type".padEnd(12) +
      "Wallet".padEnd(14) +
      "Conv".padEnd(7) +
      "Win%".padEnd(7) +
      "wWin%".padEnd(7) +
      "Trades".padEnd(8) +
      "Age".padEnd(6) +
      "Primary Cat".padEnd(14) +
      "HHI"
    );
    console.log("  " + "-".repeat(82));

    // Sort by conviction descending
    const sorted = [...profiles].sort((a, b) => b.convictionScore - a.convictionScore);

    for (const p of sorted) {
      console.log(
        "  " +
        p.traderType.padEnd(12) +
        `${p.proxyWallet.slice(0, 10)}...`.padEnd(14) +
        `${(p.convictionScore * 100).toFixed(0)}%`.padEnd(7) +
        `${(p.rawWinRate * 100).toFixed(0)}%`.padEnd(7) +
        `${(p.weightedWinRate * 100).toFixed(0)}%`.padEnd(7) +
        `${p.totalTrades}`.padEnd(8) +
        `${p.walletAgeDays}d`.padEnd(6) +
        p.primaryCategory.padEnd(14) +
        `${(p.categoryConcentration * 100).toFixed(0)}%`
      );
    }
    console.log();
  }

  private emptyProfile(whale: WhaleProfile): WhaleProfileAnalysis {
    return {
      proxyWallet: whale.proxyWallet,
      userName: whale.userName,
      walletAgeDays: 0,
      firstTradeTimestamp: 0,
      totalTrades: 0,
      buyTrades: 0,
      sellTrades: 0,
      rawWinRate: 0,
      weightedWinRate: 0,
      avgTradeSize: 0,
      tradeSizeStdDev: 0,
      maxTradeSize: 0,
      sizingConsistency: 0,
      tradesPerDay: 0,
      categoryStats: [],
      categoryCount: 0,
      categoryConcentration: 0,
      primaryCategory: "unknown",
      traderType: "UNKNOWN",
      classificationConfidence: 0,
      convictionScore: 0,
      explanation: "No trade data available.",
    };
  }

  private stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
