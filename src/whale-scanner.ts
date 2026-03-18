/**
 * Whale Copy-Trading Scanner — CLI entry point for live whale monitoring and copy trading.
 *
 * Usage: npm run whale
 *
 * Environment variables:
 *   WHALE_TOP_WALLETS      - Number of top wallets to track (default: 25)
 *   WHALE_LEADERBOARD_PERIOD - DAY, WEEK, MONTH, ALL (default: WEEK)
 *   WHALE_LEADERBOARD_CATEGORY - OVERALL, POLITICS, SPORTS, etc. (default: OVERALL)
 *   WHALE_LEADERBOARD_REFRESH_MS - Leaderboard refresh interval (default: 3600000 = 1hr)
 *   WHALE_POLL_MS          - Trade polling interval (default: 15000 = 15s)
 *   WHALE_MIN_PNL          - Minimum whale PnL to track (default: 1000)
 *   WHALE_MAX_COPY_DELAY_MS - Max age of whale trade to copy (default: 300000 = 5min)
 *   WHALE_COPY_FRACTION    - Fraction of whale's trade size to copy (default: 0.1)
 *   WHALE_MAX_COPY_SIZE    - Max USDC per copy trade (default: 50)
 *   WHALE_MIN_CONFIDENCE   - Minimum confidence score to copy (default: 0.3)
 *   WHALE_CLUSTER_ENABLED  - Enable wallet switch detection (default: false)
 *   WHALE_CLUSTER_THRESHOLD - Similarity threshold for behavioral matching (default: 0.7)
 *   WHALE_AUTO_TRADE       - Enable auto copy-trading (default: false)
 *   WHALE_PROFILE          - Enable whale profiling (default: true, set "false" to disable)
 *   WHALE_PROFILE_MIN_TRADES - Min trades for classification (default: 10)
 *   PRIVATE_KEY            - Wallet private key (required for trading)
 *   WALLET_ADDRESS         - Proxy wallet address
 *   SIGNATURE_TYPE         - Signature type (default: 2)
 *   RPC_URL                - Polygon RPC URL (for fund flow detection)
 */
import dotenv from "dotenv";
import path from "path";
import { Logger } from "./logger";
import { WhaleConfig } from "./whale-types";
import { WhaleTracker } from "./whale-tracker";
import { WhaleMonitor } from "./whale-monitor";
import { WalletClusterDetector } from "./wallet-cluster";
import { WhaleCopyEngine } from "./whale-copy-engine";
import { WhaleProfiler } from "./whale-profiler";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  const logger = new Logger();

  console.log("\n" +
    "╔══════════════════════════════════════════════════════════════╗\n" +
    "║       POLYMARKET WHALE COPY-TRADER v1.0                      ║\n" +
    "║       Following the smart money on Polymarket                 ║\n" +
    "╚══════════════════════════════════════════════════════════════╝\n"
  );

  const config: WhaleConfig = {
    topWalletsCount: parseInt(process.env.WHALE_TOP_WALLETS || "25", 10),
    leaderboardPeriod: process.env.WHALE_LEADERBOARD_PERIOD || "WEEK",
    leaderboardCategory: process.env.WHALE_LEADERBOARD_CATEGORY || "OVERALL",
    leaderboardRefreshMs: parseInt(process.env.WHALE_LEADERBOARD_REFRESH_MS || "3600000", 10),
    tradePollingMs: parseInt(process.env.WHALE_POLL_MS || "15000", 10),
    minWhalePnl: parseFloat(process.env.WHALE_MIN_PNL || "1000"),
    maxCopyDelayMs: parseInt(process.env.WHALE_MAX_COPY_DELAY_MS || "300000", 10),
    copySizeFraction: parseFloat(process.env.WHALE_COPY_FRACTION || "0.1"),
    maxCopySizeUsdc: parseFloat(process.env.WHALE_MAX_COPY_SIZE || "50"),
    minConfidence: parseFloat(process.env.WHALE_MIN_CONFIDENCE || "0.3"),
    clusterDetectionEnabled: process.env.WHALE_CLUSTER_ENABLED === "true",
    clusterSimilarityThreshold: parseFloat(process.env.WHALE_CLUSTER_THRESHOLD || "0.7"),
    inactivityDaysThreshold: parseInt(process.env.WHALE_INACTIVITY_DAYS || "7", 10),
    autoTradeEnabled: process.env.WHALE_AUTO_TRADE === "true",
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  };

  logger.info(`Config: ${JSON.stringify({
    topWallets: config.topWalletsCount,
    period: config.leaderboardPeriod,
    category: config.leaderboardCategory,
    pollInterval: `${config.tradePollingMs}ms`,
    minPnl: `$${config.minWhalePnl}`,
    copyFraction: `${(config.copySizeFraction * 100).toFixed(0)}%`,
    maxCopySize: `$${config.maxCopySizeUsdc}`,
    autoTrade: config.autoTradeEnabled,
    clusterDetection: config.clusterDetectionEnabled,
  })}`);

  // Phase 1: Discover whales
  const tracker = new WhaleTracker(config, logger);
  const whales = await tracker.discover();

  if (whales.length === 0) {
    logger.error("No whales found on leaderboard. Try lowering WHALE_MIN_PNL.");
    process.exit(1);
  }

  // Phase 1.5: Profile whales (classify trader types)
  const enableProfiling = process.env.WHALE_PROFILE !== "false";
  let profilerResults: import("./whale-types").WhaleProfileAnalysis[] = [];
  if (enableProfiling) {
    logger.info("Profiling whale wallets (this may take a moment)...");
    const profiler = new WhaleProfiler(logger, parseInt(process.env.WHALE_PROFILE_MIN_TRADES || "10", 10));
    profilerResults = await profiler.profileAll(whales);
    profiler.printSummary(profilerResults);

    // Print detailed profiles for top whales
    const topProfiles = [...profilerResults]
      .sort((a, b) => b.convictionScore - a.convictionScore)
      .slice(0, 5);
    console.log("--- Top 5 Whales by Conviction ---");
    for (const p of topProfiles) {
      profiler.printProfile(p);
      console.log();
    }
  }

  // Phase 2: Initialize monitor
  const monitor = new WhaleMonitor(config, logger);
  if (profilerResults.length > 0) {
    monitor.setWhaleAnalyses(profilerResults);
  }
  await monitor.initializeTimestamps(whales);

  // Phase 3: Initialize copy engine (if trading enabled)
  const copyEngine = new WhaleCopyEngine(config, logger);
  if (config.autoTradeEnabled) {
    const privateKey = process.env.PRIVATE_KEY || "";
    const walletAddress = process.env.WALLET_ADDRESS || "";
    const sigType = parseInt(process.env.SIGNATURE_TYPE || "2", 10);
    await copyEngine.initialize(privateKey, walletAddress, sigType);
  }

  // Phase 4: Set up signal handling
  monitor.onSignal(async (signal) => {
    if (config.autoTradeEnabled && copyEngine.isReady()) {
      await copyEngine.executeCopy(signal);
    }
  });

  // Phase 5: Initialize cluster detection (if enabled)
  let clusterDetector: WalletClusterDetector | null = null;
  if (config.clusterDetectionEnabled) {
    clusterDetector = new WalletClusterDetector(config, logger);
    logger.info("Wallet cluster detection enabled.");
  }

  // Phase 6: Start monitoring
  logger.success(
    `Monitoring ${whales.length} whales. ` +
    `Polling every ${config.tradePollingMs / 1000}s. ` +
    `Auto-trade: ${config.autoTradeEnabled ? "ON" : "OFF"}`
  );

  tracker.startRefreshLoop();
  monitor.startPolling(() => tracker.getTrackedWhales());

  // Periodic cluster detection
  if (clusterDetector) {
    setInterval(async () => {
      const allWhales = tracker.getTrackedWhales();
      const inactive = allWhales.filter((w) => {
        const daysSinceUpdate = (Date.now() - w.lastUpdated) / (1000 * 86400);
        return daysSinceUpdate > config.inactivityDaysThreshold;
      });

      if (inactive.length > 0) {
        // Re-fetch leaderboard to find new wallets
        const freshWhales = await tracker.discover();
        const knownAddresses = new Set(allWhales.map((w) => w.proxyWallet));
        const newEntrants = freshWhales.filter((w) => !knownAddresses.has(w.proxyWallet));

        if (newEntrants.length > 0 && inactive.length > 0) {
          const clusters = await clusterDetector!.detectSwitches(
            inactive,
            newEntrants,
            (wallet) => monitor.fetchWhaleTrades(wallet, 200)
          );

          // Start tracking newly discovered wallets
          for (const cluster of clusters) {
            for (const wallet of cluster.wallets) {
              if (!knownAddresses.has(wallet)) {
                tracker.addWallet({
                  proxyWallet: wallet,
                  userName: `Cluster-${cluster.id.slice(0, 8)}`,
                  pnl: 0,
                  volume: 0,
                  rank: 999,
                  category: config.leaderboardCategory,
                  timePeriod: config.leaderboardPeriod,
                  lastUpdated: Date.now(),
                  isActive: true,
                  clusterId: cluster.id,
                });
              }
            }
          }
        }
      }
    }, config.leaderboardRefreshMs);
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    logger.info("Shutting down...");
    tracker.stopRefreshLoop();
    monitor.stopPolling();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Whale scanner failed:", err);
  process.exit(1);
});
