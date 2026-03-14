import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export interface Config {
  // Wallet
  privateKey: string;
  walletAddress: string;
  signatureType: number;
  rpcUrl: string;

  // Scanner
  scanIntervalMs: number;
  minSpreadThreshold: number;

  // Trading
  autoTradeEnabled: boolean;
  maxTradeSizeUsdc: number;
  maxTotalExposureUsdc: number;
  dailyLossLimitUsdc: number;
  minLiquidityUsdc: number;
  orderType: "FOK" | "GTC";

  // API endpoints
  gammaApiUrl: string;
  clobApiUrl: string;
  wsUrl: string;
  chainId: number;
}

export function loadConfig(): Config {
  return {
    // Wallet
    privateKey: process.env.PRIVATE_KEY || "",
    walletAddress: process.env.WALLET_ADDRESS || "",
    signatureType: parseInt(process.env.SIGNATURE_TYPE || "2", 10),
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",

    // Scanner
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || "30000", 10),
    minSpreadThreshold: parseFloat(process.env.MIN_SPREAD_THRESHOLD || "0.02"),

    // Trading
    autoTradeEnabled: process.env.AUTO_TRADE_ENABLED === "true",
    maxTradeSizeUsdc: parseFloat(process.env.MAX_TRADE_SIZE_USDC || "50"),
    maxTotalExposureUsdc: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USDC || "500"),
    dailyLossLimitUsdc: parseFloat(process.env.DAILY_LOSS_LIMIT_USDC || "100"),
    minLiquidityUsdc: parseFloat(process.env.MIN_LIQUIDITY_USDC || "100"),
    orderType: (process.env.ORDER_TYPE as "FOK" | "GTC") || "FOK",

    // API endpoints (fixed)
    gammaApiUrl: "https://gamma-api.polymarket.com",
    clobApiUrl: "https://clob.polymarket.com",
    wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/",
    chainId: 137,
  };
}
