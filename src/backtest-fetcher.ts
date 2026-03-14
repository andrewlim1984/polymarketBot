import axios, { AxiosInstance } from "axios";
import { Logger } from "./logger";
import { GammaEvent, GammaMarket } from "./types";
import {
  BacktestConfig,
  MarketPriceHistory,
  EventPriceHistory,
  PricePoint,
} from "./backtest-types";

export class BacktestFetcher {
  private gammaClient: AxiosInstance;
  private clobClient: AxiosInstance;
  private logger: Logger;
  private config: BacktestConfig;

  constructor(config: BacktestConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.gammaClient = axios.create({
      baseURL: "https://gamma-api.polymarket.com",
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });
    this.clobClient = axios.create({
      baseURL: "https://clob.polymarket.com",
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Fetch events (both active and recently closed) for backtesting.
   */
  async fetchEvents(): Promise<GammaEvent[]> {
    const allEvents: GammaEvent[] = [];
    const limit = 100;
    let offset = 0;
    let hasMore = true;

    this.logger.info("Fetching events from Gamma API for backtest...");

    // Fetch active events
    while (hasMore) {
      try {
        const response = await this.gammaClient.get<GammaEvent[]>("/events", {
          params: { active: true, closed: false, limit, offset },
        });
        const events = response.data;
        if (events.length === 0) {
          hasMore = false;
        } else {
          allEvents.push(...events);
          offset += limit;
          if (offset > 3000) hasMore = false;
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.logger.warn("Rate limited, waiting 10s...");
          await this.sleep(10000);
          continue;
        }
        this.logger.error(`Error fetching active events: ${error}`);
        hasMore = false;
      }
    }

    // Also fetch recently closed events for more history
    offset = 0;
    hasMore = true;
    while (hasMore) {
      try {
        const response = await this.gammaClient.get<GammaEvent[]>("/events", {
          params: { closed: true, limit, offset },
        });
        const events = response.data;
        if (events.length === 0) {
          hasMore = false;
        } else {
          allEvents.push(...events);
          offset += limit;
          if (offset > 2000) hasMore = false;
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.logger.warn("Rate limited, waiting 10s...");
          await this.sleep(10000);
          continue;
        }
        this.logger.error(`Error fetching closed events: ${error}`);
        hasMore = false;
      }
    }

    // Deduplicate by event ID
    const uniqueEvents = new Map<string, GammaEvent>();
    for (const event of allEvents) {
      uniqueEvents.set(event.id, event);
    }

    const result = [...uniqueEvents.values()];
    this.logger.info(`Fetched ${result.length} unique events.`);

    // Apply maxEvents limit
    if (this.config.maxEvents > 0 && result.length > this.config.maxEvents) {
      return result.slice(0, this.config.maxEvents);
    }

    return result;
  }

  /**
   * Fetch historical prices for a specific token ID.
   */
  async fetchTokenPriceHistory(tokenId: string): Promise<PricePoint[]> {
    try {
      const endTs = Math.floor(Date.now() / 1000);
      const startTs = endTs - this.config.lookbackDays * 86400;

      const response = await this.clobClient.get<{ history: PricePoint[] }>("/prices-history", {
        params: {
          market: tokenId,
          startTs,
          endTs,
          fidelity: this.config.fidelity,
          interval: this.config.interval,
        },
      });

      return response.data.history || [];
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        await this.sleep(5000);
        return this.fetchTokenPriceHistory(tokenId); // Retry once
      }
      return [];
    }
  }

  /**
   * Fetch price histories for all markets in an event.
   * Returns null if data is insufficient.
   */
  async fetchEventPriceHistory(event: GammaEvent): Promise<EventPriceHistory | null> {
    if (!event.markets || event.markets.length === 0) return null;

    const marketHistories: MarketPriceHistory[] = [];

    for (const market of event.markets) {
      const history = await this.fetchMarketPriceHistory(market, event.id, event.title);
      if (history) {
        marketHistories.push(history);
      }
      // Small delay to respect rate limits
      await this.sleep(200);
    }

    if (marketHistories.length === 0) return null;

    return {
      eventId: event.id,
      eventTitle: event.title,
      markets: marketHistories,
    };
  }

  /**
   * Fetch price history for a single market (both YES and NO tokens).
   */
  private async fetchMarketPriceHistory(
    market: GammaMarket,
    eventId: string,
    eventTitle: string
  ): Promise<MarketPriceHistory | null> {
    let clobTokenIds: string[];
    try {
      clobTokenIds = JSON.parse(market.clobTokenIds || "[]");
    } catch {
      return null;
    }

    if (clobTokenIds.length < 2) return null;

    const yesTokenId = clobTokenIds[0];
    const noTokenId = clobTokenIds[1];

    const [yesHistory, noHistory] = await Promise.all([
      this.fetchTokenPriceHistory(yesTokenId),
      this.fetchTokenPriceHistory(noTokenId),
    ]);

    if (yesHistory.length === 0 && noHistory.length === 0) return null;

    return {
      marketId: market.id,
      conditionId: market.conditionId,
      question: market.question,
      eventId,
      eventTitle,
      yesHistory,
      noHistory,
      yesTokenId,
      noTokenId,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
