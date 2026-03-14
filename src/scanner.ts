import axios, { AxiosInstance } from "axios";
import { Config } from "./config";
import { Logger } from "./logger";
import {
  GammaEvent,
  GammaMarket,
  ParsedMarket,
  ArbitrageOpportunity,
} from "./types";

export class MarketScanner {
  private client: AxiosInstance;
  private logger: Logger;
  private config: Config;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.client = axios.create({
      baseURL: config.gammaApiUrl,
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Fetch all active events with their markets from the Gamma API.
   * Paginates through all results.
   */
  async fetchActiveEvents(): Promise<GammaEvent[]> {
    const allEvents: GammaEvent[] = [];
    const limit = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.client.get<GammaEvent[]>("/events", {
          params: {
            active: true,
            closed: false,
            limit,
            offset,
          },
        });

        const events = response.data;
        if (events.length === 0) {
          hasMore = false;
        } else {
          allEvents.push(...events);
          offset += limit;

          // Safety: stop after 5000 events to avoid infinite loops
          if (offset > 5000) {
            hasMore = false;
          }
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          this.logger.error(`Gamma API error: ${error.message} (status: ${error.response?.status})`);
          // If rate limited, wait and retry
          if (error.response?.status === 429) {
            this.logger.warn("Rate limited, waiting 10 seconds...");
            await this.sleep(10000);
            continue;
          }
        } else {
          this.logger.error(`Unexpected error fetching events: ${error}`);
        }
        hasMore = false;
      }
    }

    return allEvents;
  }

  /**
   * Parse a GammaMarket into a typed ParsedMarket.
   */
  parseMarket(market: GammaMarket): ParsedMarket | null {
    try {
      const outcomes: string[] = JSON.parse(market.outcomes || "[]");
      const outcomePrices: number[] = JSON.parse(market.outcomePrices || "[]").map(Number);
      const clobTokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");

      if (outcomes.length === 0 || outcomePrices.length === 0) {
        return null;
      }

      return {
        id: market.id,
        question: market.question,
        slug: market.slug,
        outcomes,
        outcomePrices,
        clobTokenIds,
        enableOrderBook: market.enableOrderBook,
        active: market.active,
        closed: market.closed,
        volume: market.volume,
        volume24hr: market.volume24hr,
        liquidity: market.liquidity,
        negRisk: market.negRisk,
        negRiskMarketId: market.negRiskMarketId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Scan a single binary market (YES/NO) for arbitrage.
   * Returns an opportunity if YES + NO != $1.00 (within threshold).
   */
  checkSingleMarketArbitrage(
    market: ParsedMarket,
    eventId?: string,
    eventTitle?: string
  ): ArbitrageOpportunity | null {
    if (!market.enableOrderBook || market.closed || !market.active) {
      return null;
    }

    // Single binary market should have exactly 2 outcomes
    if (market.outcomes.length !== 2) {
      return null;
    }

    const yesPrice = market.outcomePrices[0];
    const noPrice = market.outcomePrices[1];

    // Skip markets with zero prices (no liquidity)
    if (yesPrice === 0 && noPrice === 0) {
      return null;
    }

    const priceSum = yesPrice + noPrice;
    const spread = 1.0 - priceSum;

    // Only interested when sum < 1.0 (can buy both sides for less than $1)
    if (spread <= this.config.minSpreadThreshold) {
      return null;
    }

    const profitPerDollar = spread;

    return {
      type: "single-market",
      eventId,
      eventTitle,
      markets: [market],
      priceSum,
      spread,
      profitPerDollar,
      strategy: `Buy YES @ $${yesPrice.toFixed(4)} + Buy NO @ $${noPrice.toFixed(4)} = $${priceSum.toFixed(4)} cost → $1.00 payout → $${spread.toFixed(4)} profit`,
      detectedAt: new Date(),
      tokenIdsToBuy: market.clobTokenIds,
      pricesToBuy: [yesPrice, noPrice],
    };
  }

  /**
   * Scan a multi-market event for arbitrage.
   * If the sum of all YES prices across all markets in the event < $1.00,
   * buying YES on all markets guarantees a profit.
   */
  checkMultiMarketArbitrage(event: GammaEvent): ArbitrageOpportunity | null {
    if (!event.markets || event.markets.length < 2) {
      return null;
    }

    const parsedMarkets: ParsedMarket[] = [];
    const yesPrices: number[] = [];
    const tokenIdsToBuy: string[] = [];

    for (const rawMarket of event.markets) {
      const market = this.parseMarket(rawMarket);
      if (!market || !market.enableOrderBook || market.closed || !market.active) {
        return null; // All markets must be tradeable for a valid arb
      }

      // Each market should be a binary YES/NO
      if (market.outcomes.length < 1) {
        return null;
      }

      const yesPrice = market.outcomePrices[0]; // First outcome is YES
      if (yesPrice === 0) {
        return null;
      }

      parsedMarkets.push(market);
      yesPrices.push(yesPrice);
      // First token ID is typically the YES token
      if (market.clobTokenIds.length > 0) {
        tokenIdsToBuy.push(market.clobTokenIds[0]);
      }
    }

    const priceSum = yesPrices.reduce((a, b) => a + b, 0);
    const spread = 1.0 - priceSum;

    // Only interested if buying all YES positions costs < $1.00
    if (spread <= this.config.minSpreadThreshold) {
      return null;
    }

    const profitPerDollar = spread;
    const priceBreakdown = parsedMarkets
      .map((m, i) => `${m.question}: YES @ $${yesPrices[i].toFixed(4)}`)
      .join(" + ");

    return {
      type: "multi-market",
      eventId: event.id,
      eventTitle: event.title,
      markets: parsedMarkets,
      priceSum,
      spread,
      profitPerDollar,
      strategy: `Buy YES on all ${parsedMarkets.length} markets: ${priceBreakdown} = $${priceSum.toFixed(4)} cost → $1.00 payout → $${spread.toFixed(4)} profit`,
      detectedAt: new Date(),
      tokenIdsToBuy,
      pricesToBuy: yesPrices,
    };
  }

  /**
   * Run a full scan of all active markets and return any arbitrage opportunities.
   */
  async scan(): Promise<ArbitrageOpportunity[]> {
    const startTime = Date.now();
    const opportunities: ArbitrageOpportunity[] = [];

    const events = await this.fetchActiveEvents();
    let totalMarkets = 0;

    for (const event of events) {
      if (!event.markets || event.markets.length === 0) {
        continue;
      }

      totalMarkets += event.markets.length;

      if (event.markets.length === 1) {
        // Single-market event: check YES+NO arbitrage
        const market = this.parseMarket(event.markets[0]);
        if (market) {
          const opp = this.checkSingleMarketArbitrage(market, event.id, event.title);
          if (opp) {
            opportunities.push(opp);
          }
        }
      } else {
        // Multi-market event: check sum of all YES prices
        const multiOpp = this.checkMultiMarketArbitrage(event);
        if (multiOpp) {
          opportunities.push(multiOpp);
        }

        // Also check each individual market for YES+NO arbitrage
        for (const rawMarket of event.markets) {
          const market = this.parseMarket(rawMarket);
          if (market) {
            const opp = this.checkSingleMarketArbitrage(market, event.id, event.title);
            if (opp) {
              opportunities.push(opp);
            }
          }
        }
      }
    }

    this.logger.scanStart(totalMarkets);
    const elapsed = Date.now() - startTime;
    this.logger.scanComplete(opportunities.length, elapsed);

    return opportunities;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
