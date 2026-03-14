import { loadConfig } from "./config";
import { Logger } from "./logger";
import { MarketScanner } from "./scanner";
import { RiskManager } from "./risk";
import { Trader } from "./trader";
import { RealtimeMonitor } from "./monitor";
import { ArbitrageOpportunity } from "./types";

class PolymarketArbitrageBot {
  private config = loadConfig();
  private logger = new Logger();
  private scanner: MarketScanner;
  private riskManager: RiskManager;
  private trader: Trader;
  private monitor: RealtimeMonitor;

  private totalScans = 0;
  private totalOpportunities = 0;
  private totalTrades = 0;
  private totalPnl = 0;
  private startTime = Date.now();
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.scanner = new MarketScanner(this.config, this.logger);
    this.riskManager = new RiskManager(this.config, this.logger);
    this.trader = new Trader(this.config, this.logger, this.riskManager);
    this.monitor = new RealtimeMonitor(this.config, this.logger);
  }

  async start(): Promise<void> {
    this.logger.banner();

    // Print configuration
    this.logger.info(`Scan interval: ${this.config.scanIntervalMs / 1000}s`);
    this.logger.info(`Min spread threshold: ${(this.config.minSpreadThreshold * 100).toFixed(1)}%`);
    this.logger.info(`Auto-trade enabled: ${this.config.autoTradeEnabled}`);

    if (this.config.autoTradeEnabled) {
      this.logger.info(`Max trade size: $${this.config.maxTradeSizeUsdc}`);
      this.logger.info(`Max total exposure: $${this.config.maxTotalExposureUsdc}`);
      this.logger.info(`Daily loss limit: $${this.config.dailyLossLimitUsdc}`);
      this.logger.info(`Order type: ${this.config.orderType}`);
    }

    // Initialize trader if auto-trading is enabled
    if (this.config.autoTradeEnabled) {
      const traderReady = await this.trader.initialize();
      if (!traderReady) {
        this.logger.warn("Trader initialization failed. Running in scan-only mode.");
      }
    } else {
      this.logger.info("Running in SCAN-ONLY mode. Set AUTO_TRADE_ENABLED=true to enable trading.");
    }

    // Connect WebSocket monitor
    try {
      await this.monitor.connect();
      this.monitor.setPriceUpdateCallback((tokenId, price, side) => {
        this.logger.info(`WS Price Update: ${tokenId.substring(0, 12)}... → $${price.toFixed(4)} (${side})`);
      });
    } catch {
      this.logger.warn("WebSocket connection failed. Running with polling only.");
    }

    // Setup graceful shutdown
    this.setupGracefulShutdown();

    // Start the scan loop
    this.isRunning = true;
    this.logger.success("Bot started. Press Ctrl+C to stop.\n");

    await this.runScanLoop();
  }

  private async runScanLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.runSingleScan();
      } catch (error) {
        this.logger.error(`Scan error: ${error}`);
      }

      // Print stats every 10 scans
      if (this.totalScans % 10 === 0 && this.totalScans > 0) {
        this.printStats();
      }

      // Wait for next scan
      await this.sleep(this.config.scanIntervalMs);
    }
  }

  private async runSingleScan(): Promise<void> {
    this.totalScans++;

    const opportunities = await this.scanner.scan();

    if (opportunities.length > 0) {
      this.totalOpportunities += opportunities.length;

      for (const opp of opportunities) {
        this.logger.opportunity(opp);

        // Subscribe to real-time updates for this opportunity
        if (this.monitor.isConnected()) {
          this.monitor.subscribeToTokenIds(opp.tokenIdsToBuy);
        }

        // Attempt to trade if enabled
        if (this.config.autoTradeEnabled && this.trader.isReady()) {
          await this.handleOpportunity(opp);
        }
      }
    }
  }

  private async handleOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const success = await this.trader.executeArbitrage(opportunity);
    if (success) {
      this.totalTrades++;
      this.logger.success(`Trade executed successfully for ${opportunity.type} opportunity.`);
    }
  }

  private printStats(): void {
    this.logger.stats({
      totalScans: this.totalScans,
      totalOpportunities: this.totalOpportunities,
      totalTrades: this.totalTrades,
      totalPnl: this.totalPnl,
      uptime: Date.now() - this.startTime,
    });
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (): Promise<void> => {
      this.logger.warn("\nShutting down gracefully...");
      this.isRunning = false;

      if (this.scanTimer) {
        clearTimeout(this.scanTimer);
      }

      // Cancel all open orders if trading
      if (this.trader.isReady()) {
        await this.trader.cancelAllOrders();
      }

      // Disconnect WebSocket
      this.monitor.disconnect();

      // Print final stats
      this.printStats();

      this.logger.info("Bot stopped.");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scanTimer = setTimeout(resolve, ms);
    });
  }
}

// Entry point
const bot = new PolymarketArbitrageBot();
bot.start().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
