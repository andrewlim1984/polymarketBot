import WebSocket from "ws";
import { Config } from "./config";
import { Logger } from "./logger";
import { ParsedMarket } from "./types";

interface WsMessage {
  event_type?: string;
  market?: string;
  price?: string;
  side?: string;
  size?: string;
  asset_id?: string;
  // Orderbook update fields
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

type PriceUpdateCallback = (tokenId: string, price: number, side: string) => void;

export class RealtimeMonitor {
  private ws: WebSocket | null = null;
  private config: Config;
  private logger: Logger;
  private subscribedTokens: Set<string> = new Set();
  private onPriceUpdate: PriceUpdateCallback | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isConnecting = false;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Set the callback for price updates.
   */
  setPriceUpdateCallback(callback: PriceUpdateCallback): void {
    this.onPriceUpdate = callback;
  }

  /**
   * Connect to the Polymarket WebSocket.
   */
  async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on("open", () => {
          this.logger.success("WebSocket connected to Polymarket.");
          this.reconnectAttempts = 0;
          this.isConnecting = false;

          // Start ping interval to keep connection alive
          this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.ping();
            }
          }, 30000);

          // Re-subscribe to all tokens
          this.resubscribeAll();
          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on("close", () => {
          this.logger.warn("WebSocket disconnected.");
          this.isConnecting = false;
          this.cleanupPing();
          this.attemptReconnect();
        });

        this.ws.on("error", (error: Error) => {
          this.logger.error(`WebSocket error: ${error.message}`);
          this.isConnecting = false;
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Subscribe to price updates for specific token IDs (markets).
   */
  subscribeToMarkets(markets: ParsedMarket[]): void {
    for (const market of markets) {
      for (const tokenId of market.clobTokenIds) {
        this.subscribedTokens.add(tokenId);
      }
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscriptions([...this.subscribedTokens]);
    }
  }

  /**
   * Subscribe to a list of token IDs directly.
   */
  subscribeToTokenIds(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokens.add(id);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscriptions(tokenIds);
    }
  }

  /**
   * Disconnect the WebSocket.
   */
  disconnect(): void {
    this.cleanupPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTokens.clear();
    this.logger.info("WebSocket monitor disconnected.");
  }

  /** Check if connected. */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const messages: WsMessage[] = JSON.parse(data.toString());

      if (!Array.isArray(messages)) return;

      for (const msg of messages) {
        if (msg.event_type === "price_change" && msg.asset_id && msg.price) {
          const price = parseFloat(msg.price);
          const side = msg.side || "unknown";

          if (this.onPriceUpdate) {
            this.onPriceUpdate(msg.asset_id, price, side);
          }
        }
      }
    } catch {
      // Some messages may not be JSON arrays (e.g., connection acks)
    }
  }

  private sendSubscriptions(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to market channel for each token
    const subscribeMsg = {
      type: "subscribe",
      channel: "market",
      assets_ids: tokenIds,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    this.logger.info(`Subscribed to ${tokenIds.length} token price feeds.`);
  }

  private resubscribeAll(): void {
    if (this.subscribedTokens.size > 0) {
      this.sendSubscriptions([...this.subscribedTokens]);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error("Max reconnect attempts reached. Giving up.");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    this.logger.info(
      `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    setTimeout(() => {
      this.connect().catch((err) => {
        this.logger.error(`Reconnect failed: ${err}`);
      });
    }, delay);
  }

  private cleanupPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
