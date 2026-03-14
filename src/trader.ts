import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { Config } from "./config";
import { Logger } from "./logger";
import { RiskManager } from "./risk";
import { ArbitrageOpportunity, TradeRecord } from "./types";

export class Trader {
  private client: ClobClient | null = null;
  private config: Config;
  private logger: Logger;
  private riskManager: RiskManager;
  private tradeHistory: TradeRecord[] = [];
  private initialized = false;

  constructor(config: Config, logger: Logger, riskManager: RiskManager) {
    this.config = config;
    this.logger = logger;
    this.riskManager = riskManager;
  }

  /**
   * Initialize the CLOB client with wallet credentials.
   * Must be called before trading.
   */
  async initialize(): Promise<boolean> {
    if (!this.config.privateKey) {
      this.logger.warn("No private key configured — trading disabled. Running in scan-only mode.");
      return false;
    }

    try {
      const signer = new Wallet(this.config.privateKey);

      // Step 1: Create a temporary client to derive API credentials
      const tempClient = new ClobClient(
        this.config.clobApiUrl,
        this.config.chainId,
        signer
      );

      this.logger.info("Deriving API credentials from private key...");
      const apiCreds = await tempClient.createOrDeriveApiKey();
      this.logger.success("API credentials derived successfully.");

      // Step 2: Create the full trading client
      this.client = new ClobClient(
        this.config.clobApiUrl,
        this.config.chainId,
        signer,
        apiCreds,
        this.config.signatureType,
        this.config.walletAddress || signer.address
      );

      this.initialized = true;
      this.logger.success(`Trader initialized. Wallet: ${signer.address}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize trader: ${error}`);
      return false;
    }
  }

  /**
   * Execute an arbitrage opportunity.
   * For single-market: buy both YES and NO.
   * For multi-market: buy YES on all markets.
   */
  async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<boolean> {
    if (!this.initialized || !this.client) {
      this.logger.warn("Trader not initialized, cannot execute trade.");
      return false;
    }

    if (!this.config.autoTradeEnabled) {
      this.logger.info("Auto-trading disabled. Opportunity logged but not executed.");
      return false;
    }

    // Calculate trade size
    const tradeSize = this.riskManager.calculateTradeSize(opportunity);
    if (tradeSize <= 0) {
      this.logger.warn("Trade size is 0, skipping.");
      return false;
    }

    // Risk check
    const riskCheck = this.riskManager.checkTrade(opportunity, tradeSize);
    if (!riskCheck.approved) {
      this.logger.warn(`Risk check failed: ${riskCheck.reason}`);
      return false;
    }

    this.logger.info(
      `Executing ${opportunity.type} arbitrage. Trade size: $${tradeSize.toFixed(2)}`
    );

    const useFok = this.config.orderType === "FOK";
    let allFilled = true;

    // Place orders for each token in the opportunity
    for (let i = 0; i < opportunity.tokenIdsToBuy.length; i++) {
      const tokenId = opportunity.tokenIdsToBuy[i];
      const price = opportunity.pricesToBuy[i];
      // Size in USDC: tradeSize is total, divide by number of tokens
      const sizePerToken = tradeSize / opportunity.tokenIdsToBuy.length;
      // Number of shares = USDC amount / price per share
      const shares = Math.floor(sizePerToken / price);

      if (shares <= 0) {
        this.logger.warn(`Calculated 0 shares for token ${tokenId}, skipping.`);
        continue;
      }

      const record: TradeRecord = {
        opportunityId: `${opportunity.eventId || "single"}-${Date.now()}`,
        tokenId,
        side: "BUY",
        price,
        size: sizePerToken,
        status: "pending",
        timestamp: new Date(),
      };

      try {
        // Determine tick size and negRisk from the market
        const market = opportunity.markets.find(
          (m) => m.clobTokenIds.includes(tokenId)
        );
        const negRisk = market?.negRisk || false;
        const options = { tickSize: "0.01" as const, negRisk };

        let response: { orderID?: string; status?: string };

        if (useFok) {
          // FOK (Fill-or-Kill) market order — executes immediately or cancels
          response = await this.client.createAndPostMarketOrder(
            {
              tokenID: tokenId,
              price,
              amount: sizePerToken, // USDC amount for BUY
              side: Side.BUY,
            },
            options,
            OrderType.FOK
          );
        } else {
          // GTC (Good-Til-Cancelled) limit order — rests on the book
          response = await this.client.createAndPostOrder(
            {
              tokenID: tokenId,
              price,
              size: shares,
              side: Side.BUY,
            },
            options,
            OrderType.GTC
          );
        }

        record.orderId = response.orderID;
        record.status = response.status === "matched" ? "filled" : "pending";

        if (record.status === "filled") {
          this.riskManager.recordTrade(tokenId, sizePerToken, 0);
        } else {
          allFilled = false;
        }

        this.logger.trade(record);
      } catch (error) {
        record.status = "failed";
        allFilled = false;
        this.logger.trade(record);
        this.logger.error(`Order failed for token ${tokenId}: ${error}`);
      }

      this.tradeHistory.push(record);
    }

    return allFilled;
  }

  /**
   * Cancel all open orders (emergency).
   */
  async cancelAllOrders(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.cancelAll();
      this.logger.success("All open orders cancelled.");
    } catch (error) {
      this.logger.error(`Failed to cancel orders: ${error}`);
    }
  }

  /** Get trade history. */
  getTradeHistory(): ReadonlyArray<TradeRecord> {
    return this.tradeHistory;
  }

  /** Check if trader is initialized and ready. */
  isReady(): boolean {
    return this.initialized && this.client !== null;
  }
}
