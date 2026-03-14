/**
 * Scan-only mode: runs a single scan and prints results.
 * No trading, no WebSocket, no private key required.
 *
 * Usage: npm run scan
 */
import { loadConfig } from "./config";
import { Logger } from "./logger";
import { MarketScanner } from "./scanner";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger();

  logger.banner();
  logger.info("Running single scan (no trading)...\n");

  // Override threshold to show more opportunities
  const threshold = config.minSpreadThreshold;
  logger.info(`Minimum spread threshold: ${(threshold * 100).toFixed(1)}%`);

  const scanner = new MarketScanner(config, logger);

  try {
    const opportunities = await scanner.scan();

    if (opportunities.length === 0) {
      logger.info("No arbitrage opportunities found above threshold.");
      logger.info("Try lowering MIN_SPREAD_THRESHOLD in .env to see more results.");
    } else {
      // Sort by spread (most profitable first)
      opportunities.sort((a, b) => b.spread - a.spread);

      logger.success(`\nFound ${opportunities.length} opportunities:\n`);

      for (const opp of opportunities) {
        logger.opportunity(opp);
      }
    }
  } catch (error) {
    logger.error(`Scan failed: ${error}`);
    process.exit(1);
  }
}

main().catch(console.error);
