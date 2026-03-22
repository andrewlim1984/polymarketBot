/** Types for the whale copy-trading strategy */

/** A whale wallet discovered from the leaderboard */
export interface WhaleProfile {
  /** Proxy wallet address (0x-prefixed) */
  proxyWallet: string;
  /** Display name / username */
  userName: string;
  /** Profit and loss in USDC */
  pnl: number;
  /** Trading volume in USDC */
  volume: number;
  /** Leaderboard rank */
  rank: number;
  /** Category (OVERALL, POLITICS, SPORTS, etc.) */
  category: string;
  /** Time period (DAY, WEEK, MONTH, ALL) */
  timePeriod: string;
  /** When this profile was last refreshed */
  lastUpdated: number;
  /** Whether this wallet is currently active (traded recently) */
  isActive: boolean;
  /** Cluster ID if this wallet is linked to others */
  clusterId?: string;
}

/** A trade made by a whale, from the Data API */
export interface WhaleTrade {
  /** Proxy wallet that made the trade */
  proxyWallet: string;
  /** BUY or SELL */
  side: "BUY" | "SELL";
  /** Condition ID of the market */
  conditionId: string;
  /** Asset token ID */
  asset: string;
  /** Number of shares */
  size: number;
  /** Price per share */
  price: number;
  /** Unix timestamp (seconds) */
  timestamp: number;
  /** Market title / question */
  title: string;
  /** Market slug */
  slug: string;
  /** Event slug */
  eventSlug: string;
  /** Outcome label (e.g., "Yes", "No") */
  outcome: string;
  /** Outcome index (0 or 1) */
  outcomeIndex: number;
  /** Transaction hash */
  transactionHash?: string;
  /** USDC value of the trade (size * price) */
  usdcValue: number;
}

/** A copy-trade signal emitted when a whale makes a trade we want to follow */
export interface CopySignal {
  /** The whale trade we're copying */
  whaleTrade: WhaleTrade;
  /** The whale's profile */
  whaleProfile: WhaleProfile;
  /** Confidence score 0-1 based on whale's track record */
  confidence: number;
  /** Suggested position size in USDC */
  suggestedSizeUsdc: number;
  /** Time since whale's trade (ms) */
  delayMs: number;
  /** When this signal was generated */
  generatedAt: number;
}

/** Behavioral fingerprint for a wallet — used to detect wallet switches */
export interface WalletFingerprint {
  proxyWallet: string;
  /** Average trade size in USDC */
  avgTradeSize: number;
  /** Median trade size in USDC */
  medianTradeSize: number;
  /** Trades per day */
  tradesPerDay: number;
  /** Buy vs sell ratio (0-1, where 1 = all buys) */
  buyRatio: number;
  /** Set of market categories traded */
  categories: Set<string>;
  /** Set of condition IDs traded */
  marketsTraded: Set<string>;
  /** Hour-of-day distribution (24 buckets) */
  hourDistribution: number[];
  /** Last trade timestamp */
  lastTradeTimestamp: number;
  /** Total trade count used to build this fingerprint */
  tradeCount: number;
}

/** A cluster of wallets believed to be the same trader */
export interface WalletCluster {
  /** Unique cluster ID */
  id: string;
  /** All wallet addresses in this cluster */
  wallets: string[];
  /** The primary (most profitable) wallet */
  primaryWallet: string;
  /** How the link was detected */
  linkType: "fund-flow" | "behavioral" | "manual";
  /** Similarity score (0-1) for behavioral links */
  similarityScore?: number;
  /** When this cluster was created */
  createdAt: number;
}

/** Configuration for the whale copy-trading strategy */
export interface WhaleConfig {
  /** Number of top wallets to track from leaderboard */
  topWalletsCount: number;
  /** Leaderboard time period: DAY, WEEK, MONTH, ALL */
  leaderboardPeriod: string;
  /** Leaderboard category: OVERALL, POLITICS, SPORTS, etc. */
  leaderboardCategory: string;
  /** How often to refresh the leaderboard (ms) */
  leaderboardRefreshMs: number;
  /** How often to poll whale trades (ms) */
  tradePollingMs: number;
  /** Minimum whale PnL to track (USDC) */
  minWhalePnl: number;
  /** Maximum delay to copy a trade (ms) — skip if whale's trade is too old */
  maxCopyDelayMs: number;
  /** Position sizing: fraction of whale's trade to copy (0-1) */
  copySizeFraction: number;
  /** Maximum USDC per copy trade */
  maxCopySizeUsdc: number;
  /** Minimum confidence score to copy (0-1) */
  minConfidence: number;
  /** Enable wallet cluster detection */
  clusterDetectionEnabled: boolean;
  /** Similarity threshold for behavioral matching (0-1) */
  clusterSimilarityThreshold: number;
  /** Days of inactivity before a wallet is considered "switched" */
  inactivityDaysThreshold: number;
  /** Auto-trade enabled */
  autoTradeEnabled: boolean;
  /** Polygon RPC URL for fund flow tracking */
  rpcUrl: string;
  /** USDC token address on Polygon */
  usdcAddress: string;
  /** Categories to exclude from copy trading (e.g. ["sports"]) */
  excludeCategories: string[];
}

/** Trader classification type */
export type TraderType =
  | "INSIDER"
  | "QUANT"
  | "MARKET_MAKER"
  | "DEGENERATE"
  | "WALLET_FOLLOWER"
  | "UNKNOWN";

/** Per-category performance stats */
export interface CategoryStats {
  /** Category name (e.g., "sports", "politics", "crypto") */
  category: string;
  /** Total trades in this category */
  trades: number;
  /** Winning trades */
  wins: number;
  /** Win rate (0-1) */
  winRate: number;
  /** Net PnL in this category */
  pnl: number;
  /** Weighted win rate (low-probability wins weighted higher) */
  weightedWinRate: number;
}

/** Full profiler analysis for a whale wallet */
export interface WhaleProfileAnalysis {
  /** Wallet address */
  proxyWallet: string;
  /** Display name */
  userName: string;
  /** Wallet age in days (since first trade) */
  walletAgeDays: number;
  /** First trade timestamp (unix seconds) */
  firstTradeTimestamp: number;
  /** Total trades analyzed */
  totalTrades: number;
  /** Total BUY trades */
  buyTrades: number;
  /** Total SELL trades */
  sellTrades: number;
  /** Raw win rate (0-1) */
  rawWinRate: number;
  /**
   * Weighted win rate: wins on low-probability bets count more.
   * A win at 5% probability is weighted ~20x more than a win at 99%.
   * Weight = 1 / entryPrice for wins, so lower entry prices (longer odds) = higher weight.
   */
  weightedWinRate: number;
  /** Average trade size in USDC */
  avgTradeSize: number;
  /** Standard deviation of trade sizes */
  tradeSizeStdDev: number;
  /** Maximum single trade size */
  maxTradeSize: number;
  /** Bet sizing consistency (0-1, higher = more consistent) */
  sizingConsistency: number;
  /** Trades per day */
  tradesPerDay: number;
  /** Per-category breakdown */
  categoryStats: CategoryStats[];
  /** Number of distinct categories traded */
  categoryCount: number;
  /** Herfindahl index of category concentration (0-1, higher = more concentrated) */
  categoryConcentration: number;
  /** Primary (most-traded) category */
  primaryCategory: string;
  /** Classified trader type */
  traderType: TraderType;
  /** Confidence in the classification (0-1) */
  classificationConfidence: number;
  /** Conviction score for copy-trading (0-1, higher = more worth following) */
  convictionScore: number;
  /** Human-readable explanation of classification */
  explanation: string;
}

/** Whale backtest configuration */
export interface WhaleBacktestConfig {
  /** Starting capital in USDC */
  startingCapital: number;
  /** How many top wallets to simulate copying */
  topWalletsCount: number;
  /** Max USDC per copy trade */
  maxCopySizeUsdc: number;
  /** Position sizing fraction of whale trade (0-1) */
  copySizeFraction: number;
  /** Fee rate (e.g., 0.02 = 2%) */
  feeRate: number;
  /** Gas cost per transaction */
  gasCostPerTx: number;
  /** Simulated delay in ms before copying a whale trade */
  copyDelayMs: number;
  /** Lookback days */
  lookbackDays: number;
  /** Max exposure USDC */
  maxExposureUsdc: number;
  /** Daily loss limit USDC */
  dailyLossLimitUsdc: number;
  /** Categories to exclude from copy trading (e.g. ["sports"]) */
  excludeCategories: string[];
}

/** Whale backtest trade result */
export interface WhaleBacktestTrade {
  /** Timestamp of the whale's original trade */
  whaleTimestamp: number;
  /** Timestamp we would have copied */
  copyTimestamp: number;
  /** Whale wallet address */
  whaleWallet: string;
  /** Market condition ID */
  conditionId: string;
  /** Market title */
  title: string;
  /** Side we copied */
  side: "BUY" | "SELL";
  /** Outcome (e.g., "Yes", "No") */
  outcome: string;
  /** Price whale entered at */
  whalePrice: number;
  /** Price we entered at (after delay) */
  copyPrice: number;
  /** Our position size in USDC */
  sizeUsdc: number;
  /** Resolution price (1.0 if correct, 0.0 if wrong, or current price) */
  exitPrice: number;
  /** Whether the market has resolved */
  resolved: boolean;
  /** Net PnL after fees */
  netPnlUsdc: number;
  /** Fees paid */
  feesUsdc: number;
}

/** Whale backtest results */
export interface WhaleBacktestResults {
  config: WhaleBacktestConfig;
  trades: WhaleBacktestTrade[];
  whalesTracked: number;
  stats: WhaleBacktestStats;
}

/** Whale backtest statistics */
export interface WhaleBacktestStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalGrossProfit: number;
  totalFees: number;
  totalNetProfit: number;
  avgProfitPerTrade: number;
  startingCapital: number;
  endingCapital: number;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  bestWhale: { wallet: string; pnl: number; trades: number };
  worstWhale: { wallet: string; pnl: number; trades: number };
  tradesSkippedExposure: number;
  tradesSkippedDailyLoss: number;
  tradesSkippedCapital: number;
  tradesSkippedCategory: number;
}
