import { Logger } from "./logger";
import { BacktestConfig } from "./backtest-types";
import { BacktestFetcher } from "./backtest-fetcher";
import { BacktestEngine } from "./backtest-engine";
import { BacktestReport } from "./backtest-report";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/**
 * Polymarket Arbitrage Backtester
 *
 * Usage: npm run backtest
 *
 * Environment variables (optional):
 *   BACKTEST_CAPITAL       - Starting capital in USDC (default: 10000)
 *   BACKTEST_TRADE_SIZE    - Trade size per opportunity (default: 100)
 *   BACKTEST_MIN_SPREAD    - Min spread threshold, e.g. 0.02 = 2% (default: 0.02)
 *   BACKTEST_FEE_RATE      - Fee rate, e.g. 0.02 = 2% (default: 0.02)
 *   BACKTEST_GAS_COST      - Gas cost per tx in USDC (default: 0.007)
 *   BACKTEST_LOOKBACK_DAYS - Number of days of history (default: 30)
 *   BACKTEST_INTERVAL      - Price history interval: 1h, 6h, 1d, 1w, max (default: 1h)
 *   BACKTEST_FIDELITY      - Number of data points per token (default: 500)
 *   BACKTEST_MAX_EVENTS    - Max events to backtest, 0 = all (default: 200)
 */

async function main(): Promise<void> {
  const logger = new Logger();

  console.log("\n" +
    "╔══════════════════════════════════════════════════════════════╗\n" +
    "║       POLYMARKET ARBITRAGE BACKTESTER v1.0                   ║\n" +
    "║       Simulating historical arbitrage opportunities           ║\n" +
    "╚══════════════════════════════════════════════════════════════╝\n"
  );

  const config: BacktestConfig = {
    startingCapital: parseFloat(process.env.BACKTEST_CAPITAL || "10000"),
    tradeSizeUsdc: parseFloat(process.env.BACKTEST_TRADE_SIZE || "100"),
    minSpread: parseFloat(process.env.BACKTEST_MIN_SPREAD || "0.02"),
    feeRate: parseFloat(process.env.BACKTEST_FEE_RATE || "0.02"),
    gasCostPerTx: parseFloat(process.env.BACKTEST_GAS_COST || "0.007"),
    lookbackDays: parseInt(process.env.BACKTEST_LOOKBACK_DAYS || "30", 10),
    interval: (process.env.BACKTEST_INTERVAL as BacktestConfig["interval"]) || "1h",
    fidelity: parseInt(process.env.BACKTEST_FIDELITY || "500", 10),
    maxEvents: parseInt(process.env.BACKTEST_MAX_EVENTS || "200", 10),
  };

  logger.info(`Backtest config: ${JSON.stringify({
    capital: `$${config.startingCapital}`,
    tradeSize: `$${config.tradeSizeUsdc}`,
    minSpread: `${(config.minSpread * 100).toFixed(1)}%`,
    feeRate: `${(config.feeRate * 100).toFixed(1)}%`,
    lookback: `${config.lookbackDays} days`,
    interval: config.interval,
    maxEvents: config.maxEvents,
  })}`);

  // Phase 1: Fetch data
  logger.info("Phase 1: Fetching historical price data...");
  const fetcher = new BacktestFetcher(config, logger);
  const events = await fetcher.fetchEvents();

  logger.info(`Fetching price histories for ${events.length} events (this may take a few minutes)...`);

  const eventHistories = [];
  let fetchedCount = 0;
  let skippedCount = 0;

  for (const event of events) {
    const history = await fetcher.fetchEventPriceHistory(event);
    if (history) {
      eventHistories.push(history);
      fetchedCount++;
    } else {
      skippedCount++;
    }

    // Progress update every 50 events
    const total = fetchedCount + skippedCount;
    if (total % 50 === 0) {
      logger.info(`  Progress: ${total}/${events.length} events processed (${fetchedCount} with data, ${skippedCount} skipped)`);
    }
  }

  logger.info(`Phase 1 complete: ${fetchedCount} events with price history, ${skippedCount} skipped.`);

  if (eventHistories.length === 0) {
    logger.error("No historical price data found. Try increasing BACKTEST_MAX_EVENTS or BACKTEST_LOOKBACK_DAYS.");
    process.exit(1);
  }

  // Phase 2: Run simulation
  logger.info("Phase 2: Running backtest simulation...");
  const engine = new BacktestEngine(config, logger);
  const results = engine.run(eventHistories);

  // Phase 3: Print report
  logger.info("Phase 3: Generating report...");
  BacktestReport.print(results);

  // Export results to JSON
  const outputPath = path.resolve(process.cwd(), "backtest-results.json");
  const fs = await import("fs");
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        config: results.config,
        stats: results.stats,
        dailyReturns: results.dailyReturns,
        tradeCount: results.trades.length,
        topTrades: results.trades
          .sort((a, b) => b.netProfitUsdc - a.netProfitUsdc)
          .slice(0, 50)
          .map((t) => ({
            date: new Date(t.timestamp * 1000).toISOString(),
            type: t.type,
            event: t.eventTitle,
            spread: t.spread,
            netProfit: t.netProfitUsdc,
          })),
      },
      null,
      2
    )
  );
  logger.success(`Results exported to ${outputPath}`);
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
