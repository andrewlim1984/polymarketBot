/** Historical price point from CLOB API /prices-history */
export interface PricePoint {
  /** Unix timestamp (seconds) */
  t: number;
  /** Price at that time */
  p: number;
  /** Available liquidity in USDC at this price level (optional, from Telonex bid_size/ask_size) */
  liquidity?: number;
}

/** Historical price data for a single token */
export interface TokenPriceHistory {
  tokenId: string;
  marketId: string;
  question: string;
  outcome: string;
  prices: PricePoint[];
}

/** A pair of token histories for a single binary market (YES + NO) */
export interface MarketPriceHistory {
  marketId: string;
  conditionId: string;
  question: string;
  eventId: string;
  eventTitle: string;
  yesHistory: PricePoint[];
  noHistory: PricePoint[];
  yesTokenId: string;
  noTokenId: string;
}

/** A group of market histories belonging to one multi-market event */
export interface EventPriceHistory {
  eventId: string;
  eventTitle: string;
  markets: MarketPriceHistory[];
}

/** A simulated trade in the backtest */
export interface BacktestTrade {
  timestamp: number;
  type: "single-market" | "multi-market";
  eventTitle: string;
  marketQuestion?: string;
  priceSum: number;
  spread: number;
  costUsdc: number;
  payoutUsdc: number;
  grossProfitUsdc: number;
  feesUsdc: number;
  netProfitUsdc: number;
  /** Available liquidity in USDC at the time of the trade (min across all legs) */
  liquidityUsdc?: number;
}

/** Configuration for the backtest */
export interface BacktestConfig {
  /** Starting capital in USDC */
  startingCapital: number;
  /** Trade size per opportunity in USDC */
  tradeSizeUsdc: number;
  /** Minimum spread to trigger a trade (e.g. 0.02 = 2%) */
  minSpread: number;
  /** Fee rate on Polymarket (e.g. 0.02 = 2%) */
  feeRate: number;
  /** Gas cost per transaction on Polygon (USDC) */
  gasCostPerTx: number;
  /** How many days of history to fetch */
  lookbackDays: number;
  /** Price history interval */
  interval: "1h" | "6h" | "1d" | "1w" | "max";
  /** Fidelity (number of data points) */
  fidelity: number;
  /** Max number of events to backtest (0 = all) */
  maxEvents: number;
  /** Maximum total exposure across all open positions (USDC). 0 = unlimited */
  maxExposureUsdc: number;
  /** Daily loss limit — stop trading for the day if losses exceed this (USDC). 0 = unlimited */
  dailyLossLimitUsdc: number;
  /** Minimum orderbook liquidity (USDC) to consider a trade. 0 = no filter */
  minLiquidityUsdc: number;
}

/** Full backtest results and statistics */
export interface BacktestResults {
  config: BacktestConfig;
  trades: BacktestTrade[];
  stats: BacktestStats;
  equityCurve: EquityPoint[];
  dailyReturns: DailyReturn[];
}

/** Equity at a point in time */
export interface EquityPoint {
  timestamp: number;
  equity: number;
}

/** Daily return record */
export interface DailyReturn {
  date: string;
  pnl: number;
  tradeCount: number;
  cumPnl: number;
}

/** Summary statistics for the backtest */
export interface BacktestStats {
  // General
  totalEvents: number;
  totalMarketsScanned: number;
  periodStart: string;
  periodEnd: string;
  durationDays: number;

  // Trade stats
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  // PnL
  totalGrossProfit: number;
  totalFees: number;
  totalNetProfit: number;
  avgProfitPerTrade: number;
  avgSpread: number;
  maxSpread: number;
  minSpread: number;

  // Returns
  totalReturn: number;
  annualizedReturn: number;

  // Risk
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  calmarRatio: number;

  // Capital
  startingCapital: number;
  endingCapital: number;
  peakCapital: number;
  troughCapital: number;

  // Frequency
  avgTradesPerDay: number;
  bestDay: { date: string; pnl: number };
  worstDay: { date: string; pnl: number };

  // Risk constraint stats
  tradesSkippedExposure: number;
  tradesSkippedDailyLoss: number;
  tradesSkippedLiquidity: number;
  dailyLossBreaches: number;
}
