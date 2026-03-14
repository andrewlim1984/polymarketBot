import axios, { AxiosInstance } from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { Logger } from "./logger";
import {
  BacktestConfig,
  EventPriceHistory,
  MarketPriceHistory,
  PricePoint,
} from "./backtest-types";

const parquet = require("@dsnp/parquetjs");

/** A row from the Telonex markets metadata Parquet file */
interface TelonexMarketRow {
  market_id: string;
  slug: string;
  event_id: string;
  event_slug: string;
  event_title: string;
  question: string;
  outcome_0: string;
  outcome_1: string;
  asset_id_0: string;
  asset_id_1: string;
  status: string;
  quotes_from: string | null;
  quotes_to: string | null;
  category: string;
}

/** A row from the Telonex quotes Parquet file */
interface TelonexQuoteRow {
  timestamp_us: bigint;
  slug: string;
  asset_id: string;
  outcome: string;
  bid_price: string;
  bid_size: string;
  ask_price: string;
  ask_size: string;
}

/** Grouped market info by event */
interface TelonexEventGroup {
  eventId: string;
  eventTitle: string;
  markets: Array<{
    marketId: string;
    slug: string;
    question: string;
    outcome0: string;
    outcome1: string;
    assetId0: string;
    assetId1: string;
    quotesFrom: string;
    quotesTo: string;
  }>;
}

export class TelonexFetcher {
  private apiClient: AxiosInstance;
  private logger: Logger;
  private config: BacktestConfig;
  private apiKey: string;
  private tmpDir: string;

  constructor(config: BacktestConfig, apiKey: string, logger: Logger) {
    this.config = config;
    this.apiKey = apiKey;
    this.logger = logger;
    this.tmpDir = path.join(os.tmpdir(), "telonex-backtest");

    // Create temp directory
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    this.apiClient = axios.create({
      baseURL: "https://api.telonex.io/v1",
      timeout: 60000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      maxRedirects: 5,
    });
  }

  /**
   * Fetch and parse the markets metadata from Telonex (free, no API key needed).
   * Groups markets by event for multi-market arbitrage detection.
   */
  async fetchMarketMetadata(): Promise<TelonexEventGroup[]> {
    this.logger.info("Downloading Telonex markets metadata...");

    const metadataPath = path.join(this.tmpDir, "markets.parquet");

    // Download if not cached or older than 24h
    if (!fs.existsSync(metadataPath) || this.isStale(metadataPath, 86400000)) {
      const response = await axios.get(
        "https://api.telonex.io/v1/datasets/polymarket/markets",
        { responseType: "arraybuffer", timeout: 120000 }
      );
      fs.writeFileSync(metadataPath, Buffer.from(response.data));
      this.logger.info("Markets metadata downloaded.");
    } else {
      this.logger.info("Using cached markets metadata.");
    }

    // Parse the Parquet file and group by event
    const eventMap = new Map<string, TelonexEventGroup>();
    const reader = await parquet.ParquetReader.openFile(metadataPath);
    const cursor = reader.getCursor([
      "market_id", "slug", "event_id", "event_slug", "event_title",
      "question", "outcome_0", "outcome_1", "asset_id_0", "asset_id_1",
      "status", "quotes_from", "quotes_to", "category",
    ]);

    let row: TelonexMarketRow | null;
    let totalMarkets = 0;
    let marketsWithQuotes = 0;

    while ((row = await cursor.next()) !== null) {
      totalMarkets++;

      // Only include markets with quotes data
      if (!row.quotes_from || !row.event_id) continue;

      // Check if quotes data falls within our lookback period
      const lookbackStart = new Date();
      lookbackStart.setDate(lookbackStart.getDate() - this.config.lookbackDays);
      const quotesTo = new Date(row.quotes_to || "");
      if (quotesTo < lookbackStart) continue;

      marketsWithQuotes++;

      const existing = eventMap.get(row.event_id);
      if (existing) {
        existing.markets.push({
          marketId: row.market_id,
          slug: row.slug,
          question: row.question,
          outcome0: row.outcome_0,
          outcome1: row.outcome_1,
          assetId0: row.asset_id_0,
          assetId1: row.asset_id_1,
          quotesFrom: row.quotes_from,
          quotesTo: row.quotes_to || "",
        });
      } else {
        eventMap.set(row.event_id, {
          eventId: row.event_id,
          eventTitle: row.event_title,
          markets: [{
            marketId: row.market_id,
            slug: row.slug,
            question: row.question,
            outcome0: row.outcome_0,
            outcome1: row.outcome_1,
            assetId0: row.asset_id_0,
            assetId1: row.asset_id_1,
            quotesFrom: row.quotes_from,
            quotesTo: row.quotes_to || "",
          }],
        });
      }
    }

    await reader.close();

    const events = [...eventMap.values()];
    this.logger.info(
      `Parsed ${totalMarkets} total markets, ${marketsWithQuotes} with quotes data, ${events.length} events.`
    );

    // Apply maxEvents limit
    if (this.config.maxEvents > 0 && events.length > this.config.maxEvents) {
      // Prefer multi-market events with 2-20 markets (best for arbitrage)
      // Very large events (100+ markets) are slow to fetch and often sports props
      events.sort((a, b) => {
        const aScore = a.markets.length >= 2 && a.markets.length <= 20 ? 1 : 0;
        const bScore = b.markets.length >= 2 && b.markets.length <= 20 ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore;
        return b.markets.length - a.markets.length;
      });
      return events.slice(0, this.config.maxEvents);
    }

    return events;
  }

  /**
   * Download quotes data for a specific asset on a specific date.
   * Returns parsed quote rows.
   */
  async downloadQuotes(
    slug: string,
    outcome: string,
    date: string
  ): Promise<TelonexQuoteRow[]> {
    const cacheKey = `quotes_${slug}_${outcome}_${date}.parquet`;
    const cachePath = path.join(this.tmpDir, cacheKey);

    // Use cache if available
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
      return this.parseQuotesParquet(cachePath);
    }

    try {
      const response = await this.apiClient.get(
        `/downloads/polymarket/quotes/${date}`,
        {
          params: { slug, outcome },
          responseType: "arraybuffer",
        }
      );
      fs.writeFileSync(cachePath, Buffer.from(response.data));
      return this.parseQuotesParquet(cachePath);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          // No data for this date — not an error
          return [];
        }
        if (error.response?.status === 429) {
          this.logger.warn("Telonex rate limited, waiting 5s...");
          await this.sleep(5000);
          return this.downloadQuotes(slug, outcome, date);
        }
        if (error.response?.status === 401 || error.response?.status === 403) {
          this.logger.error("Telonex API key is invalid or insufficient permissions.");
          return [];
        }
      }
      return [];
    }
  }

  /**
   * Parse a quotes Parquet file and return rows.
   */
  private async parseQuotesParquet(filePath: string): Promise<TelonexQuoteRow[]> {
    const rows: TelonexQuoteRow[] = [];
    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor([
      "timestamp_us", "slug", "asset_id", "outcome",
      "bid_price", "bid_size", "ask_price", "ask_size",
    ]);

    let row: TelonexQuoteRow | null;
    while ((row = await cursor.next()) !== null) {
      rows.push({
        timestamp_us: row.timestamp_us,
        slug: row.slug,
        asset_id: row.asset_id,
        outcome: row.outcome,
        bid_price: row.bid_price,
        bid_size: row.bid_size,
        ask_price: row.ask_price,
        ask_size: row.ask_size,
      });
    }

    await reader.close();
    return rows;
  }

  /**
   * Convert Telonex quote rows into PricePoint arrays for the backtest engine.
   * Uses mid-price (avg of bid and ask) as the price signal.
   * Includes liquidity data (bid_size * bid_price or ask_size * ask_price in USDC).
   */
  private quotesToPricePoints(quotes: TelonexQuoteRow[]): PricePoint[] {
    const points: PricePoint[] = [];

    for (const q of quotes) {
      const bid = parseFloat(q.bid_price);
      const ask = parseFloat(q.ask_price);

      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) continue;

      const midPrice = (bid + ask) / 2;
      // Convert microseconds to seconds
      const timestamp = Number(q.timestamp_us) / 1_000_000;

      // Compute available liquidity in USDC (min of bid-side and ask-side depth)
      const bidSize = parseFloat(q.bid_size);
      const askSize = parseFloat(q.ask_size);
      const bidLiquidityUsdc = !isNaN(bidSize) ? bidSize * bid : 0;
      const askLiquidityUsdc = !isNaN(askSize) ? askSize * ask : 0;
      const liquidity = Math.min(bidLiquidityUsdc, askLiquidityUsdc);

      points.push({ t: Math.floor(timestamp), p: midPrice, liquidity });
    }

    return points;
  }

  /**
   * Downsample price points to reduce density while preserving trends.
   * Keeps one point per interval (in seconds).
   */
  private downsample(points: PricePoint[], intervalSec: number): PricePoint[] {
    if (points.length === 0) return [];

    const result: PricePoint[] = [points[0]];
    let lastT = points[0].t;

    for (let i = 1; i < points.length; i++) {
      if (points[i].t - lastT >= intervalSec) {
        result.push(points[i]);
        lastT = points[i].t;
      }
    }

    return result;
  }

  /**
   * Fetch complete price history for all markets in an event group.
   * Downloads quotes for each outcome across all dates in the lookback period.
   */
  async fetchEventPriceHistory(
    eventGroup: TelonexEventGroup
  ): Promise<EventPriceHistory | null> {
    const marketHistories: MarketPriceHistory[] = [];

    // Limit markets per event to avoid excessive API calls
    const maxMarketsPerEvent = 20;
    const markets = eventGroup.markets.slice(0, maxMarketsPerEvent);

    for (const market of markets) {
      const yesQuotes: TelonexQuoteRow[] = [];
      const noQuotes: TelonexQuoteRow[] = [];

      // Only fetch dates where this market actually has data
      const marketDates = this.getMarketDateRange(
        market.quotesFrom,
        market.quotesTo,
        this.config.lookbackDays
      );

      if (marketDates.length === 0) continue;

      // Download quotes for each date
      for (const date of marketDates) {
        const [yesData, noData] = await Promise.all([
          this.downloadQuotes(market.slug, market.outcome0, date),
          this.downloadQuotes(market.slug, market.outcome1, date),
        ]);

        yesQuotes.push(...yesData);
        noQuotes.push(...noData);

        // Small delay to respect rate limits
        await this.sleep(50);
      }

      if (yesQuotes.length === 0 && noQuotes.length === 0) continue;

      // Convert to PricePoints and downsample
      const downsampleInterval = this.getDownsampleInterval();
      let yesHistory = this.quotesToPricePoints(yesQuotes);
      let noHistory = this.quotesToPricePoints(noQuotes);

      if (downsampleInterval > 0) {
        yesHistory = this.downsample(yesHistory, downsampleInterval);
        noHistory = this.downsample(noHistory, downsampleInterval);
      }

      if (yesHistory.length === 0 && noHistory.length === 0) continue;

      marketHistories.push({
        marketId: market.marketId,
        conditionId: market.marketId,
        question: market.question,
        eventId: eventGroup.eventId,
        eventTitle: eventGroup.eventTitle,
        yesHistory,
        noHistory,
        yesTokenId: market.assetId0,
        noTokenId: market.assetId1,
      });
    }

    if (marketHistories.length === 0) return null;

    return {
      eventId: eventGroup.eventId,
      eventTitle: eventGroup.eventTitle,
      markets: marketHistories,
    };
  }

  /**
   * Get the downsample interval based on config.interval.
   */
  private getDownsampleInterval(): number {
    switch (this.config.interval) {
      case "1h": return 3600;
      case "6h": return 21600;
      case "1d": return 86400;
      case "1w": return 604800;
      case "max": return 0; // No downsampling
      default: return 3600;
    }
  }

  /**
   * Generate an array of date strings (YYYY-MM-DD) for a specific market's data range,
   * intersected with the lookback period.
   */
  private getMarketDateRange(
    quotesFrom: string,
    quotesTo: string,
    lookbackDays: number
  ): string[] {
    const dates: string[] = [];
    const now = new Date();
    const lookbackStart = new Date(now);
    lookbackStart.setDate(lookbackStart.getDate() - lookbackDays);

    const dataStart = new Date(quotesFrom);
    const dataEnd = new Date(quotesTo);

    // Use the later of lookbackStart and dataStart
    const effectiveStart = dataStart > lookbackStart ? dataStart : lookbackStart;
    // Use the earlier of now and dataEnd
    const effectiveEnd = dataEnd < now ? dataEnd : now;

    if (effectiveStart > effectiveEnd) return [];

    const current = new Date(effectiveStart);
    while (current <= effectiveEnd) {
      dates.push(current.toISOString().split("T")[0]);
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  /**
   * Check if a file is older than maxAge (in milliseconds).
   */
  private isStale(filePath: string, maxAgeMs: number): boolean {
    const stats = fs.statSync(filePath);
    return Date.now() - stats.mtimeMs > maxAgeMs;
  }

  /**
   * Clean up temporary files.
   */
  cleanup(): void {
    if (fs.existsSync(this.tmpDir)) {
      const files = fs.readdirSync(this.tmpDir);
      for (const file of files) {
        if (file !== "markets.parquet") {
          fs.unlinkSync(path.join(this.tmpDir, file));
        }
      }
      this.logger.info("Cleaned up temporary Telonex data files.");
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
