import { Logger } from "./logger";
import { BacktestConfig, EventPriceHistory } from "./backtest-types";
import { BacktestFetcher } from "./backtest-fetcher";
import { TelonexFetcher } from "./telonex-fetcher";
import { BacktestEngine } from "./backtest-engine";
import { BacktestReport } from "./backtest-report";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/**
 * Polymarket Arbitrage Backtester
 *
 * Usage: npm run backtest
 *
 * Environment variables (optional):
 *   BACKTEST_SOURCE        - Data source: "telonex" or "clob" (default: telonex if API key set, else clob)
 *   TELONEX_API_KEY        - Telonex API key (required for telonex source)
 *   BACKTEST_CAPITAL       - Starting capital in USDC (default: 10000)
 *   BACKTEST_TRADE_SIZE    - Trade size per opportunity (default: 100)
 *   BACKTEST_MIN_SPREAD    - Min spread threshold, e.g. 0.02 = 2% (default: 0.02)
 *   BACKTEST_FEE_RATE      - Fee rate, e.g. 0.02 = 2% (default: 0.02)
 *   BACKTEST_GAS_COST      - Gas cost per tx in USDC (default: 0.007)
 *   BACKTEST_LOOKBACK_DAYS - Number of days of history (default: 30)
 *   BACKTEST_INTERVAL      - Price history interval: 1h, 6h, 1d, 1w, max (default: 1h)
 *   BACKTEST_FIDELITY      - Number of data points per token (default: 500) [clob source only]
 *   BACKTEST_MAX_EVENTS    - Max events to backtest, 0 = all (default: 200)
 *   BACKTEST_MAX_EXPOSURE   - Max total exposure USDC, 0 = unlimited (default: 500)
 *   BACKTEST_DAILY_LOSS     - Daily loss limit USDC, 0 = unlimited (default: 100)
 *   BACKTEST_MIN_LIQUIDITY  - Min orderbook depth USDC, 0 = no filter (default: 100)
 */

async function main(): Promise<void> {
  const logger = new Logger();

  console.log("\n" +
    "╔══════════════════════════════════════════════════════════════╗\n" +
    "║       POLYMARKET ARBITRAGE BACKTESTER v1.0                   ║\n" +
    "║       Simulating historical arbitrage opportunities           ║\n" +
    "╚══════════════════════════════════════════════════════════════╝\n"
  );

  const telonexApiKey = process.env.TELONEX_API_KEY || "";
  const source = process.env.BACKTEST_SOURCE || (telonexApiKey ? "telonex" : "clob");

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
    maxExposureUsdc: parseFloat(process.env.BACKTEST_MAX_EXPOSURE || process.env.MAX_TOTAL_EXPOSURE_USDC || "500"),
    dailyLossLimitUsdc: parseFloat(process.env.BACKTEST_DAILY_LOSS || process.env.DAILY_LOSS_LIMIT_USDC || "100"),
    minLiquidityUsdc: parseFloat(process.env.BACKTEST_MIN_LIQUIDITY || process.env.MIN_LIQUIDITY_USDC || "100"),
  };

  logger.info(`Data source: ${source.toUpperCase()}`);
  logger.info(`Backtest config: ${JSON.stringify({
    capital: `$${config.startingCapital}`,
    tradeSize: `$${config.tradeSizeUsdc}`,
    minSpread: `${(config.minSpread * 100).toFixed(1)}%`,
    feeRate: `${(config.feeRate * 100).toFixed(1)}%`,
    lookback: `${config.lookbackDays} days`,
    interval: config.interval,
    maxEvents: config.maxEvents,
    maxExposure: config.maxExposureUsdc > 0 ? `$${config.maxExposureUsdc}` : "unlimited",
    dailyLossLimit: config.dailyLossLimitUsdc > 0 ? `$${config.dailyLossLimitUsdc}` : "unlimited",
    minLiquidity: config.minLiquidityUsdc > 0 ? `$${config.minLiquidityUsdc}` : "none",
  })}`);

  let eventHistories: EventPriceHistory[];

  if (source === "telonex") {
    eventHistories = await fetchFromTelonex(config, telonexApiKey, logger);
  } else {
    eventHistories = await fetchFromClob(config, logger);
  }

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

/**
 * Fetch historical data from Telonex API (tick-level quotes).
 */
async function fetchFromTelonex(
  config: BacktestConfig,
  apiKey: string,
  logger: Logger
): Promise<EventPriceHistory[]> {
  if (!apiKey) {
    logger.error("TELONEX_API_KEY is required for Telonex data source. Set it in .env or environment.");
    process.exit(1);
  }

  logger.info("Phase 1: Fetching historical data from Telonex...");
  const fetcher = new TelonexFetcher(config, apiKey, logger);

  // Step 1: Get market metadata
  const eventGroups = await fetcher.fetchMarketMetadata();
  logger.info(`Found ${eventGroups.length} events to backtest.`);

  // Step 2: Download quotes for each event
  logger.info(`Downloading quotes for ${eventGroups.length} events (this may take a while)...`);
  const eventHistories: EventPriceHistory[] = [];
  let fetchedCount = 0;
  let skippedCount = 0;

  for (const eventGroup of eventGroups) {
    const history = await fetcher.fetchEventPriceHistory(eventGroup);
    if (history) {
      eventHistories.push(history);
      fetchedCount++;
    } else {
      skippedCount++;
    }

    const total = fetchedCount + skippedCount;
    if (total % 25 === 0) {
      logger.info(`  Progress: ${total}/${eventGroups.length} events (${fetchedCount} with data, ${skippedCount} skipped)`);
    }
  }

  logger.info(`Phase 1 complete: ${fetchedCount} events with Telonex data, ${skippedCount} skipped.`);

  // Cleanup temp files (keep metadata cache)
  fetcher.cleanup();

  return eventHistories;
}

/**
 * Fetch historical data from Polymarket's CLOB API (prices-history endpoint).
 */
async function fetchFromClob(
  config: BacktestConfig,
  logger: Logger
): Promise<EventPriceHistory[]> {
  logger.info("Phase 1: Fetching historical data from Polymarket CLOB API...");
  const fetcher = new BacktestFetcher(config, logger);
  const events = await fetcher.fetchEvents();

  logger.info(`Fetching price histories for ${events.length} events (this may take a few minutes)...`);
  const eventHistories: EventPriceHistory[] = [];
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

    const total = fetchedCount + skippedCount;
    if (total % 50 === 0) {
      logger.info(`  Progress: ${total}/${events.length} events (${fetchedCount} with data, ${skippedCount} skipped)`);
    }
  }

  logger.info(`Phase 1 complete: ${fetchedCount} events with price history, ${skippedCount} skipped.`);
  return eventHistories;
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
