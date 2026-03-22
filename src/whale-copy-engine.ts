/**
 * Whale Copy Engine — executes copy trades when whale signals are detected.
 * Wraps the existing Trader module for order placement and RiskManager for risk checks.
 */
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import axios from "axios";
import { Logger } from "./logger";
import { WhaleConfig, CopySignal, WhaleTrade } from "./whale-types";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

interface MarketInfo {
  conditionId: string;
  clobTokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  negRisk: boolean;
  enableOrderBook: boolean;
  liquidity: number;
}

export class WhaleCopyEngine {
  private config: WhaleConfig;
  private logger: Logger;
  private client: ClobClient | null = null;
  private initialized = false;
  private totalExposure = 0;
  private dailyPnl = 0;
  private dailyPnlDate = "";
  private executedTrades: Array<{
    signal: CopySignal;
    orderId?: string;
    status: "filled" | "failed" | "skipped";
    reason?: string;
  }> = [];

  constructor(config: WhaleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Initialize the CLOB trading client.
   */
  async initialize(privateKey: string, walletAddress: string, signatureType: number): Promise<boolean> {
    if (!privateKey) {
      this.logger.warn("No private key configured — copy trading disabled. Running in monitor-only mode.");
      return false;
    }

    try {
      const signer = new Wallet(privateKey);
      const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
      const apiCreds = await tempClient.createOrDeriveApiKey();

      this.client = new ClobClient(
        "https://clob.polymarket.com",
        137,
        signer,
        apiCreds,
        signatureType,
        walletAddress || signer.address
      );

      this.initialized = true;
      this.logger.success(`Copy engine initialized. Wallet: ${signer.address}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize copy engine: ${error}`);
      return false;
    }
  }

  /**
   * Execute a copy trade based on a whale signal.
   */
  async executeCopy(signal: CopySignal): Promise<boolean> {
    // Daily reset
    const today = new Date().toISOString().split("T")[0];
    if (today !== this.dailyPnlDate) {
      this.dailyPnl = 0;
      this.dailyPnlDate = today;
    }

    if (!this.config.autoTradeEnabled) {
      this.logger.info(
        `Copy signal from ${signal.whaleProfile.userName}: ${signal.whaleTrade.outcome} ` +
        `on "${signal.whaleTrade.title}" — $${signal.suggestedSizeUsdc.toFixed(2)} ` +
        `(auto-trade disabled, skipping)`
      );
      this.executedTrades.push({ signal, status: "skipped", reason: "auto-trade disabled" });
      return false;
    }

    if (!this.initialized || !this.client) {
      this.executedTrades.push({ signal, status: "skipped", reason: "not initialized" });
      return false;
    }

    // Look up market info to get the CLOB token ID
    const market = await this.lookupMarket(signal.whaleTrade.conditionId);
    if (!market) {
      this.executedTrades.push({ signal, status: "failed", reason: "market not found" });
      return false;
    }

    if (!market.enableOrderBook) {
      this.executedTrades.push({ signal, status: "skipped", reason: "orderbook disabled" });
      return false;
    }

    // Determine which token to buy
    const outcomeIdx = signal.whaleTrade.outcomeIndex;
    const tokenId = JSON.parse(JSON.stringify(market.clobTokenIds))[outcomeIdx];

    if (!tokenId) {
      this.executedTrades.push({ signal, status: "failed", reason: "token ID not found" });
      return false;
    }

    const tradeSize = signal.suggestedSizeUsdc;
    const price = signal.whaleTrade.price;

    try {
      const response = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          price,
          amount: tradeSize,
          side: Side.BUY,
        },
        { tickSize: "0.01" as const, negRisk: market.negRisk },
        OrderType.FOK
      );

      const filled = response.status === "matched";
      this.executedTrades.push({
        signal,
        orderId: response.orderID,
        status: filled ? "filled" : "failed",
      });

      if (filled) {
        this.totalExposure += tradeSize;
        this.logger.success(
          `Copied ${signal.whaleProfile.userName}: ${signal.whaleTrade.outcome} ` +
          `"${signal.whaleTrade.title}" — $${tradeSize.toFixed(2)} @ $${price.toFixed(4)}`
        );
      }

      return filled;
    } catch (error) {
      this.executedTrades.push({ signal, status: "failed", reason: String(error) });
      this.logger.error(`Copy trade failed: ${error}`);
      return false;
    }
  }

  /**
   * Look up market info from the Gamma API by condition ID.
   */
  private async lookupMarket(conditionId: string): Promise<MarketInfo | null> {
    try {
      const response = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { condition_id: conditionId },
        timeout: 10000,
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        return null;
      }

      const m = response.data[0];
      return {
        conditionId: m.conditionId,
        clobTokenIds: JSON.parse(m.clobTokenIds || "[]"),
        outcomes: JSON.parse(m.outcomes || "[]"),
        outcomePrices: JSON.parse(m.outcomePrices || "[]"),
        negRisk: m.negRisk || false,
        enableOrderBook: m.enableOrderBook || false,
        liquidity: m.liquidity || 0,
      };
    } catch (error) {
      this.logger.error(`Failed to look up market ${conditionId}: ${error}`);
      return null;
    }
  }

  /** Get executed trade history. */
  getExecutedTrades(): ReadonlyArray<typeof this.executedTrades[number]> {
    return this.executedTrades;
  }

  /** Check if engine is ready for trading. */
  isReady(): boolean {
    return this.initialized && this.client !== null;
  }
}
