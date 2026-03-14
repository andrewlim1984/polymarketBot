import chalk from "chalk";
import { BacktestResults, BacktestStats, DailyReturn, BacktestConfig } from "./backtest-types";

export class BacktestReport {
  /**
   * Print a comprehensive backtest report to the console.
   */
  static print(results: BacktestResults): void {
    const { stats, dailyReturns, trades } = results;

    console.log(chalk.cyan("\n" +
      "╔══════════════════════════════════════════════════════════════╗\n" +
      "║           POLYMARKET ARBITRAGE BACKTEST REPORT               ║\n" +
      "╚══════════════════════════════════════════════════════════════╝\n"
    ));

    // Configuration
    this.printSection("Configuration", [
      ["Starting Capital", `$${stats.startingCapital.toLocaleString()}`],
      ["Trade Size", `$${results.config.tradeSizeUsdc}`],
      ["Min Spread Threshold", `${(results.config.minSpread * 100).toFixed(2)}%`],
      ["Fee Rate", `${(results.config.feeRate * 100).toFixed(2)}%`],
      ["Gas Cost / Tx", `$${results.config.gasCostPerTx}`],
      ["Lookback", `${results.config.lookbackDays} days`],
      ["Latency", results.config.latencyMs > 0 ? `${results.config.latencyMs}ms` : "instant"],
      ["Max Exposure", results.config.maxExposureUsdc > 0 ? `$${results.config.maxExposureUsdc}` : "unlimited"],
      ["Daily Loss Limit", results.config.dailyLossLimitUsdc > 0 ? `$${results.config.dailyLossLimitUsdc}` : "unlimited"],
      ["Min Liquidity", results.config.minLiquidityUsdc > 0 ? `$${results.config.minLiquidityUsdc}` : "none"],
    ]);

    // Overview
    this.printSection("Overview", [
      ["Period", `${stats.periodStart} to ${stats.periodEnd} (${stats.durationDays} days)`],
      ["Events Scanned", stats.totalEvents.toString()],
      ["Markets Scanned", stats.totalMarketsScanned.toString()],
    ]);

    // Trade Statistics
    this.printSection("Trade Statistics", [
      ["Total Trades", stats.totalTrades.toString()],
      ["Winning Trades", `${stats.winningTrades} (${(stats.winRate * 100).toFixed(1)}%)`],
      ["Losing Trades", stats.losingTrades.toString()],
      ["Avg Trades / Day", stats.avgTradesPerDay.toFixed(1)],
    ]);

    // PnL
    const pnlColor = stats.totalNetProfit >= 0 ? chalk.green : chalk.red;
    this.printSection("Profit & Loss", [
      ["Gross Profit", `$${stats.totalGrossProfit.toFixed(2)}`],
      ["Total Fees", chalk.red(`-$${stats.totalFees.toFixed(2)}`)],
      ["Net Profit", pnlColor(`$${stats.totalNetProfit.toFixed(2)}`)],
      ["Avg Profit / Trade", `$${stats.avgProfitPerTrade.toFixed(4)}`],
    ]);

    // Spread Analysis
    this.printSection("Spread Analysis", [
      ["Avg Spread", `${(stats.avgSpread * 100).toFixed(2)}%`],
      ["Max Spread", `${(stats.maxSpread * 100).toFixed(2)}%`],
      ["Min Spread", `${(stats.minSpread * 100).toFixed(2)}%`],
    ]);

    // Returns
    const retColor = stats.totalReturn >= 0 ? chalk.green : chalk.red;
    this.printSection("Returns", [
      ["Total Return", retColor(`${(stats.totalReturn * 100).toFixed(2)}%`)],
      ["Annualized Return", retColor(`${(stats.annualizedReturn * 100).toFixed(2)}%`)],
      ["Ending Capital", pnlColor(`$${stats.endingCapital.toFixed(2)}`)],
    ]);

    // Risk Metrics
    this.printSection("Risk Metrics", [
      ["Max Drawdown", chalk.red(`$${stats.maxDrawdown.toFixed(2)} (${(stats.maxDrawdownPercent * 100).toFixed(2)}%)`)],
      ["Peak Capital", `$${stats.peakCapital.toFixed(2)}`],
      ["Trough Capital", `$${stats.troughCapital.toFixed(2)}`],
      ["Sharpe Ratio", this.colorRatio(stats.sharpeRatio)],
      ["Sortino Ratio", this.colorRatio(stats.sortinoRatio)],
      ["Profit Factor", stats.profitFactor === Infinity ? chalk.green("Inf") : stats.profitFactor.toFixed(2)],
      ["Calmar Ratio", this.colorRatio(stats.calmarRatio)],
    ]);

    // Best/Worst Days
    this.printSection("Daily Extremes", [
      ["Best Day", chalk.green(`${stats.bestDay.date}: +$${stats.bestDay.pnl.toFixed(2)}`)],
      ["Worst Day", chalk.red(`${stats.worstDay.date}: $${stats.worstDay.pnl.toFixed(2)}`)],
    ]);

    // Risk Constraints
    const totalSkipped = stats.tradesSkippedExposure + stats.tradesSkippedDailyLoss + stats.tradesSkippedLiquidity + stats.tradesSkippedCapital;
    if (totalSkipped > 0 || stats.dailyLossBreaches > 0) {
      this.printSection("Risk Constraints", [
        ["Skipped (Exposure)", stats.tradesSkippedExposure.toString()],
        ["Skipped (Daily Loss)", stats.tradesSkippedDailyLoss.toString()],
        ["Skipped (Liquidity)", stats.tradesSkippedLiquidity.toString()],
        ["Skipped (Capital)", stats.tradesSkippedCapital.toString()],
        ["Total Skipped", chalk.yellow(totalSkipped.toString())],
        ["Daily Loss Breaches", stats.dailyLossBreaches.toString()],
      ]);
    }

    // Print daily returns table (last 30 days)
    if (dailyReturns.length > 0) {
      this.printDailyReturnsTable(dailyReturns);
    }

    // Print top trades by profit
    if (trades.length > 0) {
      this.printTopTrades(results);
    }

    // Print equity curve (ASCII art)
    if (results.equityCurve.length > 1) {
      this.printEquityCurve(results);
    }
  }

  /**
   * Print a comparison table for multiple latency scenarios.
   */
  static printLatencyComparison(scenarios: Array<{ latencyMs: number; results: BacktestResults }>): void {
    console.log(chalk.cyan("\n" +
      "╔══════════════════════════════════════════════════════════════╗\n" +
      "║           LATENCY IMPACT COMPARISON                          ║\n" +
      "╚══════════════════════════════════════════════════════════════╝\n"
    ));

    // Header
    const latencyLabels = scenarios.map((s) => s.latencyMs === 0 ? "Instant" : `${s.latencyMs}ms`);
    const header = "  " + "Metric".padEnd(25) + latencyLabels.map((l) => l.padStart(14)).join("");
    console.log(chalk.gray(header));
    console.log(chalk.gray("  " + "-".repeat(25 + latencyLabels.length * 14)));

    const rows: Array<{ label: string; values: string[]; colorFn?: (v: string, i: number) => string }> = [
      {
        label: "Total Trades",
        values: scenarios.map((s) => s.results.stats.totalTrades.toString()),
      },
      {
        label: "Win Rate",
        values: scenarios.map((s) => `${(s.results.stats.winRate * 100).toFixed(1)}%`),
      },
      {
        label: "Net Profit",
        values: scenarios.map((s) => `$${s.results.stats.totalNetProfit.toFixed(2)}`),
        colorFn: (v, i) => scenarios[i].results.stats.totalNetProfit >= 0 ? chalk.green(v) : chalk.red(v),
      },
      {
        label: "Total Return",
        values: scenarios.map((s) => `${(s.results.stats.totalReturn * 100).toFixed(2)}%`),
        colorFn: (v, i) => scenarios[i].results.stats.totalReturn >= 0 ? chalk.green(v) : chalk.red(v),
      },
      {
        label: "Avg Profit / Trade",
        values: scenarios.map((s) => `$${s.results.stats.avgProfitPerTrade.toFixed(4)}`),
      },
      {
        label: "Max Drawdown",
        values: scenarios.map((s) => `${(s.results.stats.maxDrawdownPercent * 100).toFixed(2)}%`),
      },
      {
        label: "Sharpe Ratio",
        values: scenarios.map((s) => s.results.stats.sharpeRatio.toFixed(2)),
      },
      {
        label: "Avg Spread",
        values: scenarios.map((s) => `${(s.results.stats.avgSpread * 100).toFixed(2)}%`),
      },
      {
        label: "Ending Capital",
        values: scenarios.map((s) => `$${s.results.stats.endingCapital.toFixed(2)}`),
        colorFn: (v, i) => scenarios[i].results.stats.endingCapital >= scenarios[i].results.config.startingCapital ? chalk.green(v) : chalk.red(v),
      },
    ];

    for (const row of rows) {
      let line = "  " + row.label.padEnd(25);
      for (let i = 0; i < row.values.length; i++) {
        const val = row.values[i];
        const colored = row.colorFn ? row.colorFn(val, i) : chalk.white(val);
        line += colored.padStart(14 + (colored.length - val.length));
      }
      console.log(line);
    }

    console.log("");
  }

  private static printSection(title: string, rows: [string, string][]): void {
    console.log(chalk.cyan(`\n--- ${title} ---`));
    for (const [label, value] of rows) {
      console.log(chalk.gray(`  ${label.padEnd(25)}`), chalk.white(value));
    }
  }

  private static colorRatio(ratio: number): string {
    if (ratio === Infinity) return chalk.green("Inf");
    if (ratio >= 2) return chalk.green(ratio.toFixed(2));
    if (ratio >= 1) return chalk.yellow(ratio.toFixed(2));
    return chalk.red(ratio.toFixed(2));
  }

  private static printDailyReturnsTable(dailyReturns: DailyReturn[]): void {
    console.log(chalk.cyan("\n--- Daily Returns (last 30 days) ---"));
    console.log(
      chalk.gray(
        "  Date".padEnd(16) +
        "PnL".padStart(12) +
        "Trades".padStart(10) +
        "Cum PnL".padStart(14)
      )
    );
    console.log(chalk.gray("  " + "-".repeat(50)));

    const recent = dailyReturns.slice(-30);
    for (const day of recent) {
      const pnlStr = day.pnl >= 0 ? chalk.green(`+$${day.pnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(day.pnl).toFixed(2)}`);
      const cumStr = day.cumPnl >= 0 ? chalk.green(`+$${day.cumPnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(day.cumPnl).toFixed(2)}`);
      console.log(
        chalk.gray(`  ${day.date}`.padEnd(16)) +
        pnlStr.padStart(22) +
        chalk.white(day.tradeCount.toString()).padStart(10) +
        cumStr.padStart(24)
      );
    }
  }

  private static printTopTrades(results: BacktestResults): void {
    console.log(chalk.cyan("\n--- Top 10 Most Profitable Trades ---"));
    const sorted = [...results.trades].sort((a, b) => b.netProfitUsdc - a.netProfitUsdc);
    const top = sorted.slice(0, 10);

    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      const date = new Date(t.timestamp * 1000).toISOString().split("T")[0];
      const profit = t.netProfitUsdc >= 0
        ? chalk.green(`+$${t.netProfitUsdc.toFixed(4)}`)
        : chalk.red(`$${t.netProfitUsdc.toFixed(4)}`);
      console.log(
        chalk.gray(`  ${(i + 1).toString().padStart(2)}.`) +
        chalk.white(` [${date}]`) +
        chalk.yellow(` ${t.type}`) +
        ` | Spread: ${(t.spread * 100).toFixed(2)}%` +
        ` | Net: ${profit}` +
        chalk.gray(` | ${t.eventTitle.substring(0, 50)}`)
      );
    }
  }

  private static printEquityCurve(results: BacktestResults): void {
    const curve = results.equityCurve;
    if (curve.length < 2) return;

    console.log(chalk.cyan("\n--- Equity Curve ---"));

    const equities = curve.map((p) => p.equity);
    const minEq = Math.min(...equities);
    const maxEq = Math.max(...equities);
    const range = maxEq - minEq;

    if (range === 0) {
      console.log(chalk.gray("  (flat equity curve)"));
      return;
    }

    const width = 60;
    const height = 15;

    // Sample the curve to fit the width
    const step = Math.max(1, Math.floor(curve.length / width));
    const sampled: number[] = [];
    for (let i = 0; i < curve.length; i += step) {
      sampled.push(curve[i].equity);
    }
    // Ensure we include the last point
    if (sampled[sampled.length - 1] !== curve[curve.length - 1].equity) {
      sampled.push(curve[curve.length - 1].equity);
    }

    // Build ASCII chart
    for (let row = height - 1; row >= 0; row--) {
      const threshold = minEq + (range * row) / (height - 1);
      let line = "";

      // Y-axis label
      const label = `$${threshold.toFixed(0)}`.padStart(8);
      line += chalk.gray(label) + " |";

      for (const eq of sampled) {
        const normalized = (eq - minEq) / range;
        const chartRow = Math.round(normalized * (height - 1));
        if (chartRow === row) {
          line += eq >= results.config.startingCapital ? chalk.green("*") : chalk.red("*");
        } else if (chartRow > row) {
          line += " ";
        } else {
          line += " ";
        }
      }

      console.log(line);
    }

    // X-axis
    console.log(chalk.gray("         " + "+" + "-".repeat(sampled.length)));
    const startDate = new Date(curve[0].timestamp * 1000).toISOString().split("T")[0];
    const endDate = new Date(curve[curve.length - 1].timestamp * 1000).toISOString().split("T")[0];
    console.log(chalk.gray(`         ${startDate}${" ".repeat(Math.max(1, sampled.length - 20))}${endDate}`));
  }
}
