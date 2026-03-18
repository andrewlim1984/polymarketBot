/**
 * Whale Copy-Trading Backtest — CLI entry point.
 *
 * Simulates the whale copy-trading strategy on historical Polymarket data:
 * 1. Identifies historically profitable wallets from the leaderboard
 * 2. Fetches their trade history within the lookback period
 * 3. Simulates copying each BUY trade with a configurable delay
 * 4. Reports PnL, risk metrics, and per-whale breakdown
 *
 * Usage: npm run whale:backtest
 */
import dotenv from "dotenv";
import path from "path";
import { Logger } from "./logger";
import { WhaleBacktestConfig, WhaleBacktestResults, WhaleBacktestStats } from "./whale-types";
import { WhaleBacktestEngine } from "./whale-backtest-engine";
import { WhaleProfiler } from "./whale-profiler";
import { WhaleProfileAnalysis } from "./whale-types";
import fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function loadConfig(): WhaleBacktestConfig {
  return {
    startingCapital: parseFloat(process.env.WHALE_BT_CAPITAL || process.env.BACKTEST_CAPITAL || "10000"),
    topWalletsCount: parseInt(process.env.WHALE_BT_TOP_WALLETS || "25", 10),
    maxCopySizeUsdc: parseFloat(process.env.WHALE_BT_MAX_COPY_SIZE || "50"),
    copySizeFraction: parseFloat(process.env.WHALE_BT_COPY_FRACTION || "0.1"),
    feeRate: parseFloat(process.env.WHALE_BT_FEE_RATE || process.env.BACKTEST_FEE_RATE || "0.02"),
    gasCostPerTx: parseFloat(process.env.WHALE_BT_GAS_COST || process.env.BACKTEST_GAS_COST || "0.007"),
    copyDelayMs: parseInt(process.env.WHALE_BT_COPY_DELAY_MS || "5000", 10),
    lookbackDays: parseInt(process.env.WHALE_BT_LOOKBACK_DAYS || process.env.BACKTEST_LOOKBACK_DAYS || "14", 10),
    maxExposureUsdc: parseFloat(process.env.WHALE_BT_MAX_EXPOSURE || process.env.BACKTEST_MAX_EXPOSURE || "500"),
    dailyLossLimitUsdc: parseFloat(process.env.WHALE_BT_DAILY_LOSS || process.env.BACKTEST_DAILY_LOSS || "100"),
  };
}

function printReport(results: WhaleBacktestResults, whaleProfiles?: WhaleProfileAnalysis[] | null): void {
  const { stats, config, trades } = results;

  console.log("\n" +
    "╔══════════════════════════════════════════════════════════════╗\n" +
    "║       WHALE COPY-TRADING BACKTEST REPORT                     ║\n" +
    "╚══════════════════════════════════════════════════════════════╝\n"
  );

  // Configuration
  console.log("--- Configuration ---");
  console.log(`  Starting Capital          $${config.startingCapital.toLocaleString()}`);
  console.log(`  Top Wallets               ${config.topWalletsCount}`);
  console.log(`  Max Copy Size             $${config.maxCopySizeUsdc}`);
  console.log(`  Copy Size Fraction        ${(config.copySizeFraction * 100).toFixed(0)}%`);
  console.log(`  Fee Rate                  ${(config.feeRate * 100).toFixed(2)}%`);
  console.log(`  Gas Cost / Tx             $${config.gasCostPerTx}`);
  console.log(`  Copy Delay                ${config.copyDelayMs}ms`);
  console.log(`  Lookback                  ${config.lookbackDays} days`);
  console.log(`  Max Exposure              $${config.maxExposureUsdc > 0 ? config.maxExposureUsdc.toLocaleString() : "none"}`);
  console.log(`  Daily Loss Limit          $${config.dailyLossLimitUsdc > 0 ? config.dailyLossLimitUsdc.toLocaleString() : "none"}`);
  console.log();

  // Overview
  console.log("--- Overview ---");
  console.log(`  Whales Tracked            ${results.whalesTracked}`);
  if (trades.length > 0) {
    const minTs = Math.min(...trades.map((t) => t.whaleTimestamp));
    const maxTs = Math.max(...trades.map((t) => t.whaleTimestamp));
    const startDate = new Date(minTs * 1000).toISOString().split("T")[0];
    const endDate = new Date(maxTs * 1000).toISOString().split("T")[0];
    const days = Math.max(1, Math.ceil((maxTs - minTs) / 86400));
    console.log(`  Period                    ${startDate} to ${endDate} (${days} days)`);
  }
  console.log(`  Total Copy Trades         ${stats.totalTrades}`);
  const resolvedCount = trades.filter((t) => t.resolved).length;
  const unresolvedCount = trades.length - resolvedCount;
  console.log(`  Resolved Markets          ${resolvedCount} (${unresolvedCount} pending)`);
  console.log();

  // Trade Statistics
  console.log("--- Trade Statistics ---");
  console.log(`  Total Trades              ${stats.totalTrades}`);
  console.log(`  Winning Trades            ${stats.winningTrades} (${(stats.winRate * 100).toFixed(1)}%)`);
  console.log(`  Losing Trades             ${stats.losingTrades}`);
  if (trades.length > 0) {
    const days = new Set(trades.map((t) => new Date(t.whaleTimestamp * 1000).toISOString().split("T")[0])).size;
    console.log(`  Avg Trades / Day          ${(trades.length / Math.max(1, days)).toFixed(1)}`);
  }
  console.log();

  // Profit & Loss
  console.log("--- Profit & Loss ---");
  console.log(`  Gross Profit              $${stats.totalGrossProfit.toFixed(2)}`);
  console.log(`  Total Fees                -$${stats.totalFees.toFixed(2)}`);
  console.log(`  Net Profit                $${stats.totalNetProfit.toFixed(2)}`);
  console.log(`  Avg Profit / Trade        $${stats.avgProfitPerTrade.toFixed(4)}`);
  console.log();

  // Returns
  console.log("--- Returns ---");
  console.log(`  Total Return              ${(stats.totalReturn * 100).toFixed(2)}%`);
  console.log(`  Annualized Return         ${(stats.annualizedReturn * 100).toFixed(2)}%`);
  console.log(`  Ending Capital            $${stats.endingCapital.toFixed(2)}`);
  console.log();

  // Risk Metrics
  console.log("--- Risk Metrics ---");
  console.log(`  Max Drawdown              $${stats.maxDrawdown.toFixed(2)} (${(stats.maxDrawdownPercent * 100).toFixed(2)}%)`);
  console.log(`  Sharpe Ratio              ${stats.sharpeRatio.toFixed(2)}`);
  console.log(`  Sortino Ratio             ${stats.sortinoRatio.toFixed(2)}`);
  console.log(`  Profit Factor             ${stats.profitFactor.toFixed(2)}`);
  console.log();

  // Risk Constraints
  const totalSkipped = stats.tradesSkippedExposure + stats.tradesSkippedDailyLoss + stats.tradesSkippedCapital;
  if (totalSkipped > 0) {
    console.log("--- Risk Constraints ---");
    console.log(`  Total Trades Skipped      ${totalSkipped}`);
    if (stats.tradesSkippedExposure > 0) {
      console.log(`  Skipped (Exposure)        ${stats.tradesSkippedExposure}`);
    }
    if (stats.tradesSkippedDailyLoss > 0) {
      console.log(`  Skipped (Daily Loss)      ${stats.tradesSkippedDailyLoss}`);
    }
    if (stats.tradesSkippedCapital > 0) {
      console.log(`  Skipped (Capital)         ${stats.tradesSkippedCapital}`);
    }
    console.log();
  }

  // Per-Whale Breakdown
  console.log("--- Top Whales (by copy PnL) ---");
  console.log(`  Best Whale                ${stats.bestWhale.wallet.slice(0, 10)}... — ` +
    `$${stats.bestWhale.pnl.toFixed(2)} PnL (${stats.bestWhale.trades} trades)`);
  console.log(`  Worst Whale               ${stats.worstWhale.wallet.slice(0, 10)}... — ` +
    `$${stats.worstWhale.pnl.toFixed(2)} PnL (${stats.worstWhale.trades} trades)`);
  console.log();

  // Top 10 Trades
  if (trades.length > 0) {
    const sorted = [...trades].sort((a, b) => b.netPnlUsdc - a.netPnlUsdc);
    const top10 = sorted.slice(0, 10);
    console.log("--- Top 10 Copy Trades ---");
    for (let i = 0; i < top10.length; i++) {
      const t = top10[i];
      const date = new Date(t.whaleTimestamp * 1000).toISOString().split("T")[0];
      const status = t.resolved ? "resolved" : "pending";
      console.log(
        `  ${i + 1}. [${date}] "${t.title.slice(0, 40)}..." ` +
        `${t.outcome} — whale: $${t.whalePrice.toFixed(4)} → copy: $${t.copyPrice.toFixed(4)} ` +
        `→ exit: $${t.exitPrice.toFixed(4)} — PnL: $${t.netPnlUsdc.toFixed(2)} (${status})`
      );
    }
    console.log();
  }

  // Whale Profiles
  if (whaleProfiles && whaleProfiles.length > 0) {
    const profiler = new WhaleProfiler(new Logger());
    profiler.printSummary(whaleProfiles);
  }

  // Equity Curve (ASCII)
  if (trades.length > 1) {
    printEquityCurve(trades, config.startingCapital);
  }
}

function printEquityCurve(trades: WhaleBacktestResults["trades"], startingCapital: number): void {
  const width = 60;
  const height = 15;

  // Build equity series
  const equity: number[] = [startingCapital];
  let capital = startingCapital;
  for (const trade of trades) {
    capital += trade.netPnlUsdc;
    equity.push(capital);
  }

  const min = Math.min(...equity);
  const max = Math.max(...equity);
  const range = max - min || 1;

  console.log("--- Equity Curve ---");

  // Sample points to fit width
  const step = Math.max(1, Math.floor(equity.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < equity.length; i += step) {
    sampled.push(equity[i]);
  }
  if (sampled.length > width) sampled.length = width;

  // Draw chart
  for (let row = height - 1; row >= 0; row--) {
    const threshold = min + (range * row) / (height - 1);
    let line = "";
    for (const val of sampled) {
      line += val >= threshold ? "█" : " ";
    }
    const label = threshold >= 1000 ? `$${(threshold / 1000).toFixed(1)}k` : `$${threshold.toFixed(0)}`;
    console.log(`  ${label.padStart(8)} │${line}`);
  }
  console.log(`  ${"".padStart(8)} └${"─".repeat(sampled.length)}`);
  console.log();
}

async function main(): Promise<void> {
  const logger = new Logger();

  console.log("\n" +
    "╔══════════════════════════════════════════════════════════════╗\n" +
    "║       POLYMARKET WHALE COPY-TRADING BACKTEST                 ║\n" +
    "╚══════════════════════════════════════════════════════════════╝\n"
  );

  const config = loadConfig();

  logger.info("Starting whale copy-trading backtest...");
  logger.info(`Config: top ${config.topWalletsCount} wallets, ${config.lookbackDays} day lookback, ` +
    `$${config.startingCapital} capital, ${config.copyDelayMs}ms copy delay`);

  const engine = new WhaleBacktestEngine(config, logger);
  const results = await engine.run();

  // Profile whales if we have trade data
  let whaleProfiles: WhaleProfileAnalysis[] | null = null;
  if (results.whalesTracked > 0) {
    logger.info("Step 5: Profiling whale wallets...");
    const profiler = new WhaleProfiler(logger, parseInt(process.env.WHALE_PROFILE_MIN_TRADES || "5", 10));
    whaleProfiles = await profiler.profileAll(
      // Build WhaleProfile objects from the backtest wallet addresses
      Array.from(new Set(results.trades.map((t) => t.whaleWallet))).map((wallet) => ({
        proxyWallet: wallet,
        userName: wallet.slice(0, 10) + "...",
        pnl: 0,
        volume: 0,
        rank: 0,
        category: "OVERALL",
        timePeriod: "MONTH",
        lastUpdated: Date.now(),
        isActive: true,
      }))
    );
  }

  printReport(results, whaleProfiles);

  // Export to JSON
  const exportPath = path.resolve(process.cwd(), "whale-backtest-results.json");
  const exportData = {
    ...results,
    trades: results.trades.map((t) => ({
      ...t,
      whaleTimestampIso: new Date(t.whaleTimestamp * 1000).toISOString(),
      copyTimestampIso: new Date(t.copyTimestamp * 1000).toISOString(),
    })),
    whaleProfiles: whaleProfiles || [],
  };
  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
  logger.success(`Results exported to ${exportPath}`);
}

main().catch((err) => {
  console.error("Whale backtest failed:", err);
  process.exit(1);
});
