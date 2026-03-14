/** A single market from the Gamma API */
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string; // JSON string: '["Yes","No"]'
  outcomePrices: string; // JSON string: '["0.20","0.80"]'
  clobTokenIds: string; // JSON string: '["token1","token2"]'
  enableOrderBook: boolean;
  active: boolean;
  closed: boolean;
  volume: number;
  volume24hr: number;
  liquidity: number;
  negRisk: boolean;
  negRiskMarketId?: string;
  spread?: number;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
}

/** An event from the Gamma API (may contain multiple markets) */
export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description?: string;
  markets: GammaMarket[];
  volume: number;
  volume24hr: number;
  liquidity: number;
  competitive: number;
  negRisk: boolean;
}

/** Parsed market data with typed outcome prices */
export interface ParsedMarket {
  id: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  enableOrderBook: boolean;
  active: boolean;
  closed: boolean;
  volume: number;
  volume24hr: number;
  liquidity: number;
  negRisk: boolean;
  negRiskMarketId?: string;
}

/** An arbitrage opportunity detected by the scanner */
export interface ArbitrageOpportunity {
  type: "single-market" | "multi-market";
  eventId?: string;
  eventTitle?: string;
  markets: ParsedMarket[];
  /** Sum of all relevant YES prices (or YES+NO for single market) */
  priceSum: number;
  /** Spread = |1.0 - priceSum|. Positive when sum < 1.0 (buy opportunity) */
  spread: number;
  /** The guaranteed profit per $1 if you buy all sides */
  profitPerDollar: number;
  /** Strategy description */
  strategy: string;
  /** Timestamp when detected */
  detectedAt: Date;
  /** CLOB token IDs to buy */
  tokenIdsToBuy: string[];
  /** Prices for each token to buy */
  pricesToBuy: number[];
}

/** Trade record */
export interface TradeRecord {
  opportunityId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  orderId?: string;
  status: "pending" | "filled" | "failed" | "cancelled";
  timestamp: Date;
  pnl?: number;
}

/** Risk state tracked by the risk manager */
export interface RiskState {
  totalExposure: number;
  dailyPnl: number;
  dailyTradeCount: number;
  openPositions: Map<string, number>;
  killSwitchTriggered: boolean;
  lastResetDate: string;
}

/** Orderbook from CLOB API */
export interface OrderbookEntry {
  price: string;
  size: string;
}

export interface Orderbook {
  market: string;
  asset_id: string;
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
  hash: string;
  timestamp: string;
}
