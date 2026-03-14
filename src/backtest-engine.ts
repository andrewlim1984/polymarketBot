import {
  BacktestConfig,
  BacktestResults,
  BacktestStats,
  BacktestTrade,
  DailyReturn,
  EquityPoint,
  EventPriceHistory,
  MarketPriceHistory,
  PricePoint,
} from "./backtest-types";
import { Logger } from "./logger";

export class BacktestEngine {
  private config: BacktestConfig;
  private logger: Logger;

  // Risk constraint tracking
  private currentExposure = 0;
  private dailyPnl = new Map<string, number>();
  private skippedExposure = 0;
  private skippedDailyLoss = 0;
  private skippedLiquidity = 0;
  private dailyLossBreaches = 0;

  constructor(config: BacktestConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Run the full backtest simulation on historical data.
   */
  run(eventHistories: EventPriceHistory[]): BacktestResults {
    this.logger.info("Running backtest simulation...");

    // Reset risk state
    this.currentExposure = 0;
    this.dailyPnl.clear();
    this.skippedExposure = 0;
    this.skippedDailyLoss = 0;
    this.skippedLiquidity = 0;
    this.dailyLossBreaches = 0;

    const candidateTrades: BacktestTrade[] = [];

    for (const eventHistory of eventHistories) {
      // Single-market arbitrage: check each market's YES+NO sum
      for (const market of eventHistory.markets) {
        const singleTrades = this.simulateSingleMarket(market);
        candidateTrades.push(...singleTrades);
      }

      // Multi-market arbitrage: check sum of all YES prices across markets in event
      if (eventHistory.markets.length >= 2) {
        const multiTrades = this.simulateMultiMarket(eventHistory);
        candidateTrades.push(...multiTrades);
      }
    }

    // Sort all candidates by timestamp to simulate chronological execution
    candidateTrades.sort((a, b) => a.timestamp - b.timestamp);

    // Apply risk constraints in chronological order
    const trades = this.applyRiskConstraints(candidateTrades);

    // Build equity curve and daily returns
    const equityCurve = this.buildEquityCurve(trades);
    const dailyReturns = this.buildDailyReturns(trades);

    // Calculate statistics
    const stats = this.calculateStats(trades, equityCurve, dailyReturns, eventHistories);

    const results: BacktestResults = {
      config: this.config,
      trades,
      stats,
      equityCurve,
      dailyReturns,
    };

    return results;
  }

  /**
   * Apply risk constraints to candidate trades in chronological order.
   * Enforces max exposure, daily loss limit, and liquidity minimum.
   */
  private applyRiskConstraints(candidates: BacktestTrade[]): BacktestTrade[] {
    const accepted: BacktestTrade[] = [];
    let exposure = 0;
    const dailyPnlMap = new Map<string, number>();
    const breachedDays = new Set<string>();

    for (const trade of candidates) {
      const tradeDate = new Date(trade.timestamp * 1000).toISOString().split("T")[0];

      // Check daily loss limit
      if (this.config.dailyLossLimitUsdc > 0) {
        const dayPnl = dailyPnlMap.get(tradeDate) || 0;
        if (dayPnl < 0 && Math.abs(dayPnl) >= this.config.dailyLossLimitUsdc) {
          if (!breachedDays.has(tradeDate)) {
            breachedDays.add(tradeDate);
            this.dailyLossBreaches++;
          }
          this.skippedDailyLoss++;
          continue;
        }
      }

      // Check max exposure
      if (this.config.maxExposureUsdc > 0) {
        if (exposure + trade.costUsdc > this.config.maxExposureUsdc) {
          this.skippedExposure++;
          continue;
        }
      }

      // Check liquidity (if available on the trade)
      if (this.config.minLiquidityUsdc > 0 && trade.liquidityUsdc !== undefined) {
        if (trade.liquidityUsdc < this.config.minLiquidityUsdc) {
          this.skippedLiquidity++;
          continue;
        }
      }

      // Trade passes all risk checks
      accepted.push(trade);

      // Update exposure (add cost, reduce by payout on resolution — simplified as immediate)
      exposure += trade.costUsdc;
      // Assume positions resolve quickly, reducing exposure
      exposure = Math.max(0, exposure - trade.payoutUsdc);

      // Update daily PnL
      const currentDayPnl = dailyPnlMap.get(tradeDate) || 0;
      dailyPnlMap.set(tradeDate, currentDayPnl + trade.netProfitUsdc);
    }

    if (this.skippedExposure > 0 || this.skippedDailyLoss > 0 || this.skippedLiquidity > 0) {
      this.logger.info(
        `Risk constraints: ${this.skippedExposure} skipped (exposure), ` +
        `${this.skippedDailyLoss} skipped (daily loss), ` +
        `${this.skippedLiquidity} skipped (liquidity)`
      );
    }

    return accepted;
  }

  /**
   * Simulate single-market arbitrage: at each timestamp, check if YES + NO < 1.0.
   */
  private simulateSingleMarket(market: MarketPriceHistory): BacktestTrade[] {
    const trades: BacktestTrade[] = [];
    const aligned = this.alignTimeSeries(market.yesHistory, market.noHistory);

    for (const { t, yesPrice, noPrice, yesLiquidity, noLiquidity } of aligned) {
      const priceSum = yesPrice + noPrice;
      const spread = 1.0 - priceSum;

      if (spread > this.config.minSpread) {
        const costUsdc = this.config.tradeSizeUsdc;
        // How many "sets" of YES+NO can we buy?
        const sets = costUsdc / priceSum;
        const payoutUsdc = sets * 1.0; // Each set pays $1
        const grossProfit = payoutUsdc - costUsdc;
        // Fees: applied on the payout (Polymarket charges on proceeds)
        const fees = payoutUsdc * this.config.feeRate + this.config.gasCostPerTx * 2; // 2 orders
        const netProfit = grossProfit - fees;

        // Compute minimum liquidity across both sides
        const liquidityUsdc = (yesLiquidity !== undefined && noLiquidity !== undefined)
          ? Math.min(yesLiquidity, noLiquidity)
          : undefined;

        trades.push({
          timestamp: t,
          type: "single-market",
          eventTitle: market.eventTitle,
          marketQuestion: market.question,
          priceSum,
          spread,
          costUsdc,
          payoutUsdc,
          grossProfitUsdc: grossProfit,
          feesUsdc: fees,
          netProfitUsdc: netProfit,
          liquidityUsdc,
        });
      }
    }

    return trades;
  }

  /**
   * Simulate multi-market arbitrage: at each timestamp, check if sum of all YES < 1.0.
   */
  private simulateMultiMarket(eventHistory: EventPriceHistory): BacktestTrade[] {
    const trades: BacktestTrade[] = [];

    // Get all YES histories
    const yesHistories = eventHistory.markets.map((m) => m.yesHistory);

    // Find common timestamps across all markets
    const commonTimestamps = this.findCommonTimestamps(yesHistories);

    for (const t of commonTimestamps) {
      const yesPrices: number[] = [];
      const liquidities: number[] = [];
      let valid = true;

      for (const history of yesHistories) {
        const point = this.findClosestPoint(history, t);
        if (point === null) {
          valid = false;
          break;
        }
        yesPrices.push(point.p);
        if (point.liquidity !== undefined) {
          liquidities.push(point.liquidity);
        }
      }

      if (!valid) continue;

      const priceSum = yesPrices.reduce((a, b) => a + b, 0);
      const spread = 1.0 - priceSum;

      if (spread > this.config.minSpread) {
        const costUsdc = this.config.tradeSizeUsdc;
        const sets = costUsdc / priceSum;
        const payoutUsdc = sets * 1.0;
        const grossProfit = payoutUsdc - costUsdc;
        const numOrders = eventHistory.markets.length;
        const fees = payoutUsdc * this.config.feeRate + this.config.gasCostPerTx * numOrders;
        const netProfit = grossProfit - fees;

        const liquidityUsdc = liquidities.length === yesHistories.length
          ? Math.min(...liquidities)
          : undefined;

        trades.push({
          timestamp: t,
          type: "multi-market",
          eventTitle: eventHistory.eventTitle,
          priceSum,
          spread,
          costUsdc,
          payoutUsdc,
          grossProfitUsdc: grossProfit,
          feesUsdc: fees,
          netProfitUsdc: netProfit,
          liquidityUsdc,
        });
      }
    }

    return trades;
  }

  /**
   * Align two time series by matching timestamps within a tolerance window.
   */
  private alignTimeSeries(
    yesHistory: PricePoint[],
    noHistory: PricePoint[],
    toleranceSec = 300
  ): Array<{ t: number; yesPrice: number; noPrice: number; yesLiquidity?: number; noLiquidity?: number }> {
    const result: Array<{ t: number; yesPrice: number; noPrice: number; yesLiquidity?: number; noLiquidity?: number }> = [];

    // Build a map of NO points by timestamp for quick lookup
    const noMap = new Map<number, PricePoint>();
    for (const point of noHistory) {
      noMap.set(point.t, point);
    }

    for (const yesPoint of yesHistory) {
      // Try exact match first
      let noPoint = noMap.get(yesPoint.t);

      // If no exact match, search within tolerance
      if (!noPoint) {
        noPoint = this.findClosestPoint(noHistory, yesPoint.t, toleranceSec) ?? undefined;
      }

      if (noPoint) {
        result.push({
          t: yesPoint.t,
          yesPrice: yesPoint.p,
          noPrice: noPoint.p,
          yesLiquidity: yesPoint.liquidity,
          noLiquidity: noPoint.liquidity,
        });
      }
    }

    return result;
  }

  /**
   * Find the point closest to a target timestamp within a tolerance window.
   */
  private findClosestPoint(
    history: PricePoint[],
    targetTs: number,
    toleranceSec = 300
  ): PricePoint | null {
    let closest: PricePoint | null = null;
    let minDiff = Infinity;

    for (const point of history) {
      const diff = Math.abs(point.t - targetTs);
      if (diff < minDiff && diff <= toleranceSec) {
        minDiff = diff;
        closest = point;
      }
    }

    return closest;
  }

  /**
   * Find timestamps that appear (within tolerance) in all time series.
   */
  private findCommonTimestamps(
    histories: PricePoint[][],
    toleranceSec = 300
  ): number[] {
    if (histories.length === 0) return [];

    // Use the first series as the reference
    const reference = histories[0];
    const common: number[] = [];

    for (const point of reference) {
      let foundInAll = true;

      for (let i = 1; i < histories.length; i++) {
        const match = this.findClosestPoint(histories[i], point.t, toleranceSec);
        if (match === null) {
          foundInAll = false;
          break;
        }
      }

      if (foundInAll) {
        common.push(point.t);
      }
    }

    return common;
  }

  /**
   * Build an equity curve from the trade sequence.
   */
  private buildEquityCurve(trades: BacktestTrade[]): EquityPoint[] {
    const curve: EquityPoint[] = [];
    let equity = this.config.startingCapital;

    // Starting point
    if (trades.length > 0) {
      curve.push({ timestamp: trades[0].timestamp, equity });
    }

    for (const trade of trades) {
      equity += trade.netProfitUsdc;
      curve.push({ timestamp: trade.timestamp, equity });
    }

    return curve;
  }

  /**
   * Build daily return records.
   */
  private buildDailyReturns(trades: BacktestTrade[]): DailyReturn[] {
    const dailyMap = new Map<string, { pnl: number; count: number }>();

    for (const trade of trades) {
      const date = new Date(trade.timestamp * 1000).toISOString().split("T")[0];
      const existing = dailyMap.get(date) || { pnl: 0, count: 0 };
      existing.pnl += trade.netProfitUsdc;
      existing.count += 1;
      dailyMap.set(date, existing);
    }

    // Sort by date and compute cumulative PnL
    const sortedDates = [...dailyMap.keys()].sort();
    const dailyReturns: DailyReturn[] = [];
    let cumPnl = 0;

    for (const date of sortedDates) {
      const day = dailyMap.get(date)!;
      cumPnl += day.pnl;
      dailyReturns.push({
        date,
        pnl: day.pnl,
        tradeCount: day.count,
        cumPnl,
      });
    }

    return dailyReturns;
  }

  /**
   * Calculate comprehensive backtest statistics.
   */
  private calculateStats(
    trades: BacktestTrade[],
    equityCurve: EquityPoint[],
    dailyReturns: DailyReturn[],
    eventHistories: EventPriceHistory[]
  ): BacktestStats {
    const totalMarkets = eventHistories.reduce(
      (sum, e) => sum + e.markets.length,
      0
    );

    // Time period
    const timestamps = trades.map((t) => t.timestamp);
    const periodStart = timestamps.length > 0
      ? new Date(Math.min(...timestamps) * 1000).toISOString().split("T")[0]
      : "N/A";
    const periodEnd = timestamps.length > 0
      ? new Date(Math.max(...timestamps) * 1000).toISOString().split("T")[0]
      : "N/A";
    const durationDays = timestamps.length > 0
      ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86400
      : 0;

    // Trade stats
    const winningTrades = trades.filter((t) => t.netProfitUsdc > 0);
    const losingTrades = trades.filter((t) => t.netProfitUsdc <= 0);

    // PnL
    const totalGrossProfit = trades.reduce((s, t) => s + t.grossProfitUsdc, 0);
    const totalFees = trades.reduce((s, t) => s + t.feesUsdc, 0);
    const totalNetProfit = trades.reduce((s, t) => s + t.netProfitUsdc, 0);
    const spreads = trades.map((t) => t.spread);

    // Drawdown from equity curve
    const { maxDrawdown, maxDrawdownPercent, peakCapital, troughCapital } =
      this.calculateDrawdown(equityCurve);

    // Daily returns for Sharpe/Sortino
    const dailyPnls = dailyReturns.map((d) => d.pnl);
    const sharpeRatio = this.calculateSharpeRatio(dailyPnls);
    const sortinoRatio = this.calculateSortinoRatio(dailyPnls);

    // Profit factor
    const grossWins = winningTrades.reduce((s, t) => s + t.netProfitUsdc, 0);
    const grossLosses = Math.abs(losingTrades.reduce((s, t) => s + t.netProfitUsdc, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    // Best/worst day
    const bestDay = dailyReturns.length > 0
      ? dailyReturns.reduce((best, d) => (d.pnl > best.pnl ? d : best))
      : { date: "N/A", pnl: 0 };
    const worstDay = dailyReturns.length > 0
      ? dailyReturns.reduce((worst, d) => (d.pnl < worst.pnl ? d : worst))
      : { date: "N/A", pnl: 0 };

    // Returns
    const totalReturn = this.config.startingCapital > 0
      ? totalNetProfit / this.config.startingCapital
      : 0;
    const annualizedReturn = durationDays > 0
      ? Math.pow(1 + totalReturn, 365 / durationDays) - 1
      : 0;

    // Calmar ratio
    const calmarRatio = maxDrawdownPercent > 0
      ? annualizedReturn / maxDrawdownPercent
      : 0;

    const endingCapital = this.config.startingCapital + totalNetProfit;

    return {
      totalEvents: eventHistories.length,
      totalMarketsScanned: totalMarkets,
      periodStart,
      periodEnd,
      durationDays: Math.round(durationDays),
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? winningTrades.length / trades.length : 0,
      totalGrossProfit,
      totalFees,
      totalNetProfit,
      avgProfitPerTrade: trades.length > 0 ? totalNetProfit / trades.length : 0,
      avgSpread: spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
      maxSpread: spreads.length > 0 ? Math.max(...spreads) : 0,
      minSpread: spreads.length > 0 ? Math.min(...spreads) : 0,
      totalReturn,
      annualizedReturn,
      maxDrawdown,
      maxDrawdownPercent,
      sharpeRatio,
      sortinoRatio,
      profitFactor,
      calmarRatio,
      startingCapital: this.config.startingCapital,
      endingCapital,
      peakCapital,
      troughCapital,
      avgTradesPerDay: durationDays > 0 ? trades.length / durationDays : trades.length,
      bestDay: { date: bestDay.date, pnl: bestDay.pnl },
      worstDay: { date: worstDay.date, pnl: worstDay.pnl },
      tradesSkippedExposure: this.skippedExposure,
      tradesSkippedDailyLoss: this.skippedDailyLoss,
      tradesSkippedLiquidity: this.skippedLiquidity,
      dailyLossBreaches: this.dailyLossBreaches,
    };
  }

  /**
   * Calculate maximum drawdown from equity curve.
   */
  private calculateDrawdown(equityCurve: EquityPoint[]): {
    maxDrawdown: number;
    maxDrawdownPercent: number;
    peakCapital: number;
    troughCapital: number;
  } {
    let peak = this.config.startingCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let peakCapital = this.config.startingCapital;
    let troughCapital = this.config.startingCapital;

    for (const point of equityCurve) {
      if (point.equity > peak) {
        peak = point.equity;
        peakCapital = Math.max(peakCapital, peak);
      }

      const drawdown = peak - point.equity;
      const drawdownPercent = peak > 0 ? drawdown / peak : 0;

      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercent = drawdownPercent;
        troughCapital = point.equity;
      }
    }

    return { maxDrawdown, maxDrawdownPercent, peakCapital, troughCapital };
  }

  /**
   * Calculate Sharpe Ratio from daily returns.
   * Assumes risk-free rate of 5% annualized (money market rate).
   */
  private calculateSharpeRatio(dailyPnls: number[]): number {
    if (dailyPnls.length < 2) return 0;

    const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
    const variance =
      dailyPnls.reduce((sum, pnl) => sum + Math.pow(pnl - mean, 2), 0) /
      (dailyPnls.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return mean > 0 ? Infinity : 0;

    // Daily risk-free rate (5% annualized)
    const dailyRf = Math.pow(1.05, 1 / 365) - 1;
    const dailyRfUsdc = dailyRf * this.config.startingCapital;

    return ((mean - dailyRfUsdc) / stdDev) * Math.sqrt(365);
  }

  /**
   * Calculate Sortino Ratio (only penalizes downside volatility).
   */
  private calculateSortinoRatio(dailyPnls: number[]): number {
    if (dailyPnls.length < 2) return 0;

    const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
    const downsidePnls = dailyPnls.filter((p) => p < 0);

    if (downsidePnls.length === 0) return mean > 0 ? Infinity : 0;

    const downsideVariance =
      downsidePnls.reduce((sum, pnl) => sum + Math.pow(pnl, 2), 0) /
      downsidePnls.length;
    const downsideDev = Math.sqrt(downsideVariance);

    if (downsideDev === 0) return mean > 0 ? Infinity : 0;

    const dailyRf = Math.pow(1.05, 1 / 365) - 1;
    const dailyRfUsdc = dailyRf * this.config.startingCapital;

    return ((mean - dailyRfUsdc) / downsideDev) * Math.sqrt(365);
  }
}
