/**
 * Whale Backtest Engine — simulates the whale copy-trading strategy on historical data.
 *
 * Uses the Polymarket Data API to:
 * 1. Identify historically profitable wallets from the leaderboard
 * 2. Fetch their trade history
 * 3. Simulate copying each trade with a configurable delay
 * 4. Track PnL based on market resolution or current prices
 */
import axios from "axios";
import { Logger } from "./logger";
import {
  WhaleBacktestConfig,
  WhaleBacktestTrade,
  WhaleBacktestResults,
  WhaleBacktestStats,
  WhaleTrade,
} from "./whale-types";

const DATA_API_URL = "https://data-api.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";

interface MarketResolution {
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  resolved: boolean;
  closed: boolean;
}

export class WhaleBacktestEngine {
  private config: WhaleBacktestConfig;
  private logger: Logger;
  /** Cache market resolution data */
  private marketCache: Map<string, MarketResolution> = new Map();
  /** Cache price history for markets */
  private priceCache: Map<string, Array<{ t: number; p: number }>> = new Map();

  constructor(config: WhaleBacktestConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Run the full whale copy-trading backtest.
   */
  async run(): Promise<WhaleBacktestResults> {
    // Step 1: Discover top whales from leaderboard
    this.logger.info("Step 1: Discovering top whale wallets...");
    const whaleWallets = await this.fetchTopWhales();
    this.logger.info(`Found ${whaleWallets.length} whale wallets to backtest.`);

    if (whaleWallets.length === 0) {
      return this.emptyResults();
    }

    // Step 2: Fetch trade history for each whale
    this.logger.info("Step 2: Fetching whale trade histories...");
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - this.config.lookbackDays * 86400;
    const allWhaleTrades: Map<string, WhaleTrade[]> = new Map();

    for (const wallet of whaleWallets) {
      const trades = await this.fetchWalletTrades(wallet, cutoffTimestamp);
      if (trades.length > 0) {
        allWhaleTrades.set(wallet, trades);
        this.logger.info(
          `  ${wallet.slice(0, 10)}...: ${trades.length} trades in lookback period`
        );
      }
      await sleep(200);
    }

    const totalWhaleTrades = Array.from(allWhaleTrades.values()).reduce((s, t) => s + t.length, 0);
    this.logger.info(`Total whale trades to simulate: ${totalWhaleTrades}`);

    // Step 3: Simulate copying trades
    this.logger.info("Step 3: Simulating copy trades...");
    const backtestTrades = await this.simulateCopyTrades(allWhaleTrades);

    // Step 4: Calculate statistics
    this.logger.info("Step 4: Calculating statistics...");
    const stats = this.calculateStats(backtestTrades, allWhaleTrades);

    return {
      config: this.config,
      trades: backtestTrades,
      whalesTracked: allWhaleTrades.size,
      stats,
    };
  }

  /**
   * Fetch top wallets from the leaderboard.
   */
  private async fetchTopWhales(): Promise<string[]> {
    const wallets: string[] = [];
    let offset = 0;
    const limit = 50;

    while (wallets.length < this.config.topWalletsCount) {
      try {
        const response = await axios.get(`${DATA_API_URL}/v1/leaderboard`, {
          params: {
            category: "OVERALL",
            timePeriod: "MONTH",
            orderBy: "PNL",
            limit: Math.min(limit, this.config.topWalletsCount - wallets.length),
            offset,
          },
          timeout: 15000,
        });

        if (!response.data || response.data.length === 0) break;

        for (const entry of response.data) {
          wallets.push(String(entry.proxyWallet).toLowerCase());
        }

        offset += response.data.length;
        await sleep(200);
      } catch (error) {
        this.logger.error(`Failed to fetch leaderboard (offset=${offset}): ${error}`);
        break;
      }
    }

    return wallets;
  }

  /**
   * Fetch trade history for a wallet, filtered to the lookback period.
   * Only fetches BUY trades (entries we want to copy).
   */
  private async fetchWalletTrades(wallet: string, cutoffTimestamp: number): Promise<WhaleTrade[]> {
    const allTrades: WhaleTrade[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      try {
        const response = await axios.get(`${DATA_API_URL}/trades`, {
          params: {
            user: wallet,
            limit,
            offset,
            takerOnly: true,
            side: "BUY",
          },
          timeout: 15000,
        });

        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) break;

        for (const t of response.data) {
          const timestamp = Number(t.timestamp) || 0;
          if (timestamp < cutoffTimestamp) continue;

          allTrades.push({
            proxyWallet: (String(t.proxyWallet) || wallet).toLowerCase(),
            side: "BUY",
            conditionId: String(t.conditionId) || "",
            asset: String(t.asset) || "",
            size: Number(t.size) || 0,
            price: Number(t.price) || 0,
            timestamp,
            title: String(t.title) || "",
            slug: String(t.slug) || "",
            eventSlug: String(t.eventSlug) || "",
            outcome: String(t.outcome) || "",
            outcomeIndex: Number(t.outcomeIndex) || 0,
            transactionHash: t.transactionHash ? String(t.transactionHash) : undefined,
            usdcValue: (Number(t.size) || 0) * (Number(t.price) || 0),
          });
        }

        // If we got fewer than limit, we're done
        if (response.data.length < limit) break;

        offset += response.data.length;
        await sleep(200);
      } catch (error) {
        this.logger.error(`Failed to fetch trades for ${wallet.slice(0, 10)}...: ${error}`);
        break;
      }
    }

    // Sort by timestamp ascending
    allTrades.sort((a, b) => a.timestamp - b.timestamp);
    return allTrades;
  }

  /**
   * Simulate copying whale trades. For each whale BUY trade:
   * 1. Calculate what price we'd get after the copy delay
   * 2. Check if the market has resolved and determine PnL
   */
  private async simulateCopyTrades(
    allWhaleTrades: Map<string, WhaleTrade[]>
  ): Promise<WhaleBacktestTrade[]> {
    const backtestTrades: WhaleBacktestTrade[] = [];
    let capital = this.config.startingCapital;
    let exposure = 0;
    const dailyPnlMap = new Map<string, number>();
    let skippedExposure = 0;
    let skippedDailyLoss = 0;
    let skippedCapital = 0;

    // Collect all trades across whales and sort by timestamp
    const allTrades: Array<{ wallet: string; trade: WhaleTrade }> = [];
    for (const [wallet, trades] of allWhaleTrades.entries()) {
      for (const trade of trades) {
        allTrades.push({ wallet, trade });
      }
    }
    allTrades.sort((a, b) => a.trade.timestamp - b.trade.timestamp);

    let processed = 0;
    for (const { wallet, trade } of allTrades) {
      processed++;
      if (processed % 100 === 0) {
        this.logger.info(`  Processing trade ${processed}/${allTrades.length}...`);
      }

      // Determine copy timestamp (whale trade + delay)
      const copyDelaySeconds = this.config.copyDelayMs / 1000;
      const copyTimestamp = trade.timestamp + copyDelaySeconds;

      // Calculate copy size
      const whaleUsdcValue = trade.usdcValue;
      const copySize = Math.min(
        whaleUsdcValue * this.config.copySizeFraction,
        this.config.maxCopySizeUsdc
      );

      if (copySize < 1) continue;

      // Capital depletion check
      if (capital < copySize) {
        skippedCapital++;
        continue;
      }

      // Exposure check
      if (this.config.maxExposureUsdc > 0 && exposure + copySize > this.config.maxExposureUsdc) {
        skippedExposure++;
        continue;
      }

      // Daily loss check
      const tradeDate = new Date(trade.timestamp * 1000).toISOString().split("T")[0];
      if (this.config.dailyLossLimitUsdc > 0) {
        const dayPnl = dailyPnlMap.get(tradeDate) || 0;
        if (dayPnl < 0 && Math.abs(dayPnl) >= this.config.dailyLossLimitUsdc) {
          skippedDailyLoss++;
          continue;
        }
      }

      // Get the price we'd enter at (after delay) using price history
      const copyPrice = await this.getPriceAtTime(trade, copyTimestamp);

      // Determine exit price based on market resolution
      const resolution = await this.getMarketResolution(trade.conditionId);
      let exitPrice: number;
      let resolved: boolean;

      if (resolution && resolution.resolved) {
        // Market resolved — check if the whale's outcome won
        const outcomeIdx = trade.outcomeIndex;
        exitPrice = resolution.outcomePrices[outcomeIdx] || 0;
        resolved = true;
      } else {
        // Market not yet resolved — use current price as exit
        if (resolution) {
          exitPrice = resolution.outcomePrices[trade.outcomeIndex] || copyPrice;
        } else {
          exitPrice = copyPrice; // No data, assume break-even
        }
        resolved = false;
      }

      // Calculate PnL
      const shares = copySize / copyPrice;
      const exitValue = shares * exitPrice;
      const grossPnl = exitValue - copySize;
      const fees = exitValue * this.config.feeRate + this.config.gasCostPerTx;
      const netPnl = grossPnl - fees;

      const backtestTrade: WhaleBacktestTrade = {
        whaleTimestamp: trade.timestamp,
        copyTimestamp,
        whaleWallet: wallet,
        conditionId: trade.conditionId,
        title: trade.title,
        side: trade.side,
        outcome: trade.outcome,
        whalePrice: trade.price,
        copyPrice,
        sizeUsdc: copySize,
        exitPrice,
        resolved,
        netPnlUsdc: netPnl,
        feesUsdc: fees,
      };

      backtestTrades.push(backtestTrade);

      // Update tracking
      capital += netPnl;
      exposure += copySize;
      exposure = Math.max(0, exposure - exitValue);

      const currentDayPnl = dailyPnlMap.get(tradeDate) || 0;
      dailyPnlMap.set(tradeDate, currentDayPnl + netPnl);
    }

    // Store skip counts on the object for stats
    (this as unknown as Record<string, number>)._skippedExposure = skippedExposure;
    (this as unknown as Record<string, number>)._skippedDailyLoss = skippedDailyLoss;
    (this as unknown as Record<string, number>)._skippedCapital = skippedCapital;

    return backtestTrades;
  }

  /**
   * Get the price at a specific timestamp using CLOB price history.
   * Falls back to the whale's entry price if no history available.
   */
  private async getPriceAtTime(trade: WhaleTrade, targetTs: number): Promise<number> {
    const cacheKey = `${trade.conditionId}-${trade.outcomeIndex}`;

    if (!this.priceCache.has(cacheKey)) {
      try {
        // Use the CLOB API's price history
        const response = await axios.get(`${CLOB_API_URL}/prices-history`, {
          params: {
            market: trade.conditionId,
            interval: "1h",
            fidelity: 500,
          },
          timeout: 15000,
        });

        if (response.data?.history) {
          const history = response.data.history.map((p: { t: number; p: number }) => ({
            t: p.t,
            p: p.p,
          }));
          this.priceCache.set(cacheKey, history);
        } else {
          this.priceCache.set(cacheKey, []);
        }

        await sleep(100);
      } catch {
        this.priceCache.set(cacheKey, []);
      }
    }

    const history = this.priceCache.get(cacheKey) || [];
    if (history.length === 0) return trade.price;

    // Find closest point to target timestamp
    let closest = history[0];
    let minDiff = Math.abs(closest.t - targetTs);
    for (const point of history) {
      const diff = Math.abs(point.t - targetTs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = point;
      }
    }

    return closest.p || trade.price;
  }

  /**
   * Get market resolution data (or current prices for unresolved markets).
   */
  private async getMarketResolution(conditionId: string): Promise<MarketResolution | null> {
    if (this.marketCache.has(conditionId)) {
      return this.marketCache.get(conditionId)!;
    }

    try {
      const response = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { condition_id: conditionId },
        timeout: 10000,
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        return null;
      }

      const m = response.data[0];
      const resolution: MarketResolution = {
        conditionId,
        question: m.question || "",
        outcomes: JSON.parse(m.outcomes || "[]"),
        outcomePrices: JSON.parse(m.outcomePrices || "[]").map(Number),
        resolved: m.closed === true || m.resolutionSource != null,
        closed: m.closed === true,
      };

      this.marketCache.set(conditionId, resolution);
      await sleep(100);
      return resolution;
    } catch {
      return null;
    }
  }

  /**
   * Calculate comprehensive backtest statistics.
   */
  private calculateStats(
    trades: WhaleBacktestTrade[],
    allWhaleTrades: Map<string, WhaleTrade[]>
  ): WhaleBacktestStats {
    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => t.netPnlUsdc > 0).length;
    const losingTrades = trades.filter((t) => t.netPnlUsdc <= 0).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    const totalGrossProfit = trades.reduce((s, t) => s + t.netPnlUsdc + t.feesUsdc, 0);
    const totalFees = trades.reduce((s, t) => s + t.feesUsdc, 0);
    const totalNetProfit = trades.reduce((s, t) => s + t.netPnlUsdc, 0);
    const avgProfitPerTrade = totalTrades > 0 ? totalNetProfit / totalTrades : 0;

    const endingCapital = this.config.startingCapital + totalNetProfit;
    const totalReturn = this.config.startingCapital > 0
      ? totalNetProfit / this.config.startingCapital
      : 0;

    // Annualized return
    const timestamps = trades.map((t) => t.whaleTimestamp);
    const minTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;
    const durationDays = Math.max(1, (maxTs - minTs) / 86400);
    const annualizedReturn = Math.pow(1 + totalReturn, 365 / durationDays) - 1;

    // Drawdown
    let capital = this.config.startingCapital;
    let peak = capital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    for (const trade of trades) {
      capital += trade.netPnlUsdc;
      if (capital > peak) peak = capital;
      const drawdown = peak - capital;
      const drawdownPct = peak > 0 ? drawdown / peak : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercent = drawdownPct;
      }
    }

    // Daily returns for Sharpe/Sortino
    const dailyPnlMap = new Map<string, number>();
    for (const trade of trades) {
      const date = new Date(trade.whaleTimestamp * 1000).toISOString().split("T")[0];
      const current = dailyPnlMap.get(date) || 0;
      dailyPnlMap.set(date, current + trade.netPnlUsdc);
    }
    const dailyPnls = Array.from(dailyPnlMap.values());

    const sharpeRatio = this.calculateSharpe(dailyPnls);
    const sortinoRatio = this.calculateSortino(dailyPnls);

    // Profit factor
    const grossWins = trades.filter((t) => t.netPnlUsdc > 0).reduce((s, t) => s + t.netPnlUsdc, 0);
    const grossLosses = Math.abs(
      trades.filter((t) => t.netPnlUsdc < 0).reduce((s, t) => s + t.netPnlUsdc, 0)
    );
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : 0;

    // Per-whale stats
    const whaleStats = new Map<string, { pnl: number; trades: number }>();
    for (const trade of trades) {
      const current = whaleStats.get(trade.whaleWallet) || { pnl: 0, trades: 0 };
      current.pnl += trade.netPnlUsdc;
      current.trades += 1;
      whaleStats.set(trade.whaleWallet, current);
    }

    let bestWhale = { wallet: "", pnl: -Infinity, trades: 0 };
    let worstWhale = { wallet: "", pnl: Infinity, trades: 0 };
    for (const [wallet, stats] of whaleStats.entries()) {
      if (stats.pnl > bestWhale.pnl) bestWhale = { wallet, ...stats };
      if (stats.pnl < worstWhale.pnl) worstWhale = { wallet, ...stats };
    }
    if (bestWhale.wallet === "") bestWhale = { wallet: "N/A", pnl: 0, trades: 0 };
    if (worstWhale.wallet === "") worstWhale = { wallet: "N/A", pnl: 0, trades: 0 };

    const skippedExposure = (this as unknown as Record<string, number>)._skippedExposure || 0;
    const skippedDailyLoss = (this as unknown as Record<string, number>)._skippedDailyLoss || 0;
    const skippedCapital = (this as unknown as Record<string, number>)._skippedCapital || 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      totalGrossProfit,
      totalFees,
      totalNetProfit,
      avgProfitPerTrade,
      startingCapital: this.config.startingCapital,
      endingCapital,
      totalReturn,
      annualizedReturn,
      maxDrawdown,
      maxDrawdownPercent,
      sharpeRatio,
      sortinoRatio,
      profitFactor,
      bestWhale,
      worstWhale,
      tradesSkippedExposure: skippedExposure,
      tradesSkippedDailyLoss: skippedDailyLoss,
      tradesSkippedCapital: skippedCapital,
    };
  }

  private calculateSharpe(dailyPnls: number[]): number {
    if (dailyPnls.length < 2) return 0;
    const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
    const variance = dailyPnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / (dailyPnls.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    const dailyRf = Math.pow(1.05, 1 / 365) - 1;
    const dailyRfUsdc = dailyRf * this.config.startingCapital;
    return ((mean - dailyRfUsdc) / stdDev) * Math.sqrt(365);
  }

  private calculateSortino(dailyPnls: number[]): number {
    if (dailyPnls.length < 2) return 0;
    const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
    const downsidePnls = dailyPnls.filter((p) => p < 0);
    if (downsidePnls.length === 0) return 0;
    const downsideVariance = downsidePnls.reduce((s, p) => s + Math.pow(p, 2), 0) / downsidePnls.length;
    const downsideDev = Math.sqrt(downsideVariance);
    if (downsideDev === 0) return 0;
    const dailyRf = Math.pow(1.05, 1 / 365) - 1;
    const dailyRfUsdc = dailyRf * this.config.startingCapital;
    return ((mean - dailyRfUsdc) / downsideDev) * Math.sqrt(365);
  }

  private emptyResults(): WhaleBacktestResults {
    return {
      config: this.config,
      trades: [],
      whalesTracked: 0,
      stats: {
        totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
        totalGrossProfit: 0, totalFees: 0, totalNetProfit: 0, avgProfitPerTrade: 0,
        startingCapital: this.config.startingCapital, endingCapital: this.config.startingCapital,
        totalReturn: 0, annualizedReturn: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        sharpeRatio: 0, sortinoRatio: 0, profitFactor: 0,
        bestWhale: { wallet: "N/A", pnl: 0, trades: 0 },
        worstWhale: { wallet: "N/A", pnl: 0, trades: 0 },
        tradesSkippedExposure: 0, tradesSkippedDailyLoss: 0, tradesSkippedCapital: 0,
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
