# Polymarket Arbitrage Scanner & Auto-Trading Bot

A Node.js/TypeScript system that scans Polymarket prediction markets for arbitrage opportunities where the sum of outcome prices deviates from $1.00, and optionally auto-trades to capture the spread.

## Strategy

### How It Works

On Polymarket, every binary market has YES and NO shares. Their prices should sum to ~$1.00:
- **YES** at $0.60 + **NO** at $0.40 = $1.00 (no opportunity)
- **YES** at $0.42 + **NO** at $0.52 = $0.94 (6% arbitrage!)

When the combined price is **less than $1.00**, you can buy both sides and guarantee a profit regardless of the outcome.

### Two Types of Arbitrage

1. **Single-Market Arbitrage**: A binary YES/NO market where YES + NO < $1.00. Buy both.
2. **Multi-Market Arbitrage**: An event with multiple outcomes (e.g., "Who wins the election?" with candidates A, B, C). If the sum of all YES prices < $1.00, buy YES on every outcome — one must resolve to $1.00.

## Features

- **Market Scanner**: Fetches all active markets from Polymarket's Gamma API and detects mispricing
- **Real-Time WebSocket Monitor**: Subscribes to live price feeds for detected opportunities
- **Auto-Trading Engine**: Places orders via the official `@polymarket/clob-client` SDK
- **Risk Management**: Configurable trade limits, daily loss caps, and kill switch
- **Scan-Only Mode**: Run without a wallet to just monitor opportunities
- **Backtesting Engine**: Simulate the strategy on historical data with full statistics (PnL, Sharpe, max drawdown, equity curve)
- **Telonex Integration**: Use tick-level bid/ask quotes from [Telonex.io](https://telonex.io) for high-fidelity backtesting
- **Whale Copy-Trading**: Identify and follow the most profitable Polymarket wallets in real-time
- **Wallet Switch Detection**: Behavioral fingerprinting and fund flow tracking to detect when whales switch wallets

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- (For trading) A Polygon wallet with USDC funded on Polymarket

### Installation

```bash
git clone https://github.com/andrewlim1984/polymarketBot.git
cd polymarketBot
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Required for trading (not needed for scan-only mode)
PRIVATE_KEY=your_polygon_wallet_private_key
WALLET_ADDRESS=0xYourPolymarketProxyWallet
SIGNATURE_TYPE=2

# Scanner settings
SCAN_INTERVAL_MS=30000
MIN_SPREAD_THRESHOLD=0.02

# Trading settings
AUTO_TRADE_ENABLED=false
MAX_TRADE_SIZE_USDC=50
MAX_TOTAL_EXPOSURE_USDC=500
DAILY_LOSS_LIMIT_USDC=100
```

### Usage

#### Scan-Only Mode (No wallet needed)

Run a single scan to see current opportunities:

```bash
npm run scan
```

#### Backtest Mode (No wallet needed)

Run a historical backtest to simulate returns:

```bash
# Using Telonex data (recommended - tick-level quotes)
TELONEX_API_KEY=your_key npm run backtest

# Using Polymarket CLOB API (no API key needed)
BACKTEST_SOURCE=clob npm run backtest
```

Customize backtest parameters via environment variables:

```bash
BACKTEST_CAPITAL=10000 BACKTEST_LOOKBACK_DAYS=30 BACKTEST_MAX_EVENTS=200 npm run backtest
```

The backtest outputs:
- Full PnL breakdown (gross profit, fees, net profit)
- Risk metrics (Sharpe ratio, Sortino ratio, max drawdown, Calmar ratio)
- Win rate, profit factor, daily returns table
- Top 10 most profitable trades
- ASCII equity curve
- JSON export to `backtest-results.json`

#### Whale Copy-Trading Mode (No wallet needed for monitoring)

Monitor the most profitable Polymarket wallets and copy their trades:

```bash
# Monitor-only mode (no trading, just signals)
npm run whale

# With auto-trading enabled
WHALE_AUTO_TRADE=true npm run whale
```

Customize whale tracking parameters:

```bash
WHALE_TOP_WALLETS=50 WHALE_MIN_PNL=5000 WHALE_LEADERBOARD_PERIOD=MONTH npm run whale
```

#### Whale Copy-Trading Backtest

Simulate the whale copy-trading strategy on historical data:

```bash
npm run whale:backtest

# Custom parameters
WHALE_BT_TOP_WALLETS=50 WHALE_BT_LOOKBACK_DAYS=30 WHALE_BT_COPY_DELAY_MS=2000 npm run whale:backtest
```

The whale backtest outputs:
- Per-whale PnL breakdown (best/worst whale to copy)
- Resolved vs pending market breakdown
- Risk metrics (Sharpe, Sortino, max drawdown, profit factor)
- Top 10 most profitable copy trades
- ASCII equity curve
- JSON export to `whale-backtest-results.json`

#### How Wallet Switch Detection Works

Profitable traders often switch to new wallets to avoid being tracked. The system detects this two ways:

1. **Fund Flow Tracking**: Monitors USDC transfers on Polygon from known whale addresses to new addresses. If a tracked whale sends significant USDC to a new wallet, that wallet is automatically added to monitoring.

2. **Behavioral Fingerprinting**: Builds a profile for each whale based on trade size, frequency, timing patterns, market categories, and buy/sell ratio. When a whale goes inactive and a new wallet appears with a similar fingerprint, it's flagged as the same trader.

Enable with `WHALE_CLUSTER_ENABLED=true`. Adjust sensitivity with `WHALE_CLUSTER_THRESHOLD` (0-1, higher = stricter matching).

#### Full Bot Mode (Arbitrage)

Start the continuous scanner with optional auto-trading:

```bash
npm run dev
```

Or build and run:

```bash
npm run build
npm start
```

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Polygon wallet private key (without 0x prefix) |
| `WALLET_ADDRESS` | — | Polymarket proxy wallet address |
| `SIGNATURE_TYPE` | `2` | `0`=EOA, `1`=POLY_PROXY, `2`=GNOSIS_SAFE |
| `RPC_URL` | `https://polygon-rpc.com` | Polygon RPC endpoint |
| `SCAN_INTERVAL_MS` | `30000` | Scan frequency in milliseconds |
| `MIN_SPREAD_THRESHOLD` | `0.02` | Minimum spread to flag (0.02 = 2%) |
| `AUTO_TRADE_ENABLED` | `false` | Enable auto-trading |
| `MAX_TRADE_SIZE_USDC` | `50` | Max USDC per trade |
| `MAX_TOTAL_EXPOSURE_USDC` | `500` | Max total position size |
| `DAILY_LOSS_LIMIT_USDC` | `100` | Daily loss limit before kill switch |
| `MIN_LIQUIDITY_USDC` | `100` | Min orderbook liquidity to trade |
| `ORDER_TYPE` | `FOK` | `FOK` (Fill-or-Kill) or `GTC` (Good-Til-Cancelled) |
| `BACKTEST_SOURCE` | `telonex`* | Data source: `telonex` or `clob` (*auto: telonex if API key set) |
| `TELONEX_API_KEY` | — | Telonex API key (required for telonex source) |
| `BACKTEST_CAPITAL` | `10000` | Starting capital for backtest (USDC) |
| `BACKTEST_TRADE_SIZE` | `100` | Trade size per opportunity in backtest |
| `BACKTEST_MIN_SPREAD` | `0.02` | Min spread threshold for backtest |
| `BACKTEST_FEE_RATE` | `0.02` | Simulated fee rate (0.02 = 2%) |
| `BACKTEST_GAS_COST` | `0.007` | Gas cost per transaction (USDC) |
| `BACKTEST_LOOKBACK_DAYS` | `30` | Days of historical data to fetch |
| `BACKTEST_INTERVAL` | `1h` | Price history interval (1h/6h/1d/1w/max) |
| `BACKTEST_FIDELITY` | `500` | Number of data points per token (clob source only) |
| `BACKTEST_MAX_EVENTS` | `200` | Max events to backtest (0 = all) |
| `WHALE_TOP_WALLETS` | `25` | Number of top wallets to track |
| `WHALE_LEADERBOARD_PERIOD` | `WEEK` | Leaderboard period: DAY/WEEK/MONTH/ALL |
| `WHALE_LEADERBOARD_CATEGORY` | `OVERALL` | Leaderboard category |
| `WHALE_POLL_MS` | `15000` | Trade polling interval (ms) |
| `WHALE_MIN_PNL` | `1000` | Minimum whale PnL to track (USDC) |
| `WHALE_COPY_FRACTION` | `0.1` | Fraction of whale's trade to copy |
| `WHALE_MAX_COPY_SIZE` | `50` | Max USDC per copy trade |
| `WHALE_MIN_CONFIDENCE` | `0.3` | Min confidence score to copy (0-1) |
| `WHALE_CLUSTER_ENABLED` | `false` | Enable wallet switch detection |
| `WHALE_CLUSTER_THRESHOLD` | `0.7` | Behavioral similarity threshold (0-1) |
| `WHALE_AUTO_TRADE` | `false` | Enable auto copy-trading |

## Architecture

```
src/
├── index.ts              # Main entry point - orchestrates all modules
├── scan-only.ts          # Standalone single-scan mode
├── backtest.ts           # Arbitrage backtest CLI entry point
├── backtest-types.ts     # Backtest type definitions
├── backtest-fetcher.ts   # Historical price data fetcher (Polymarket CLOB)
├── telonex-fetcher.ts    # Historical price data fetcher (Telonex tick-level quotes)
├── backtest-engine.ts    # Backtest simulation engine
├── backtest-report.ts    # Statistics & report printer
├── whale-scanner.ts      # Whale copy-trading CLI entry point
├── whale-backtest.ts     # Whale backtest CLI entry point
├── whale-backtest-engine.ts # Whale backtest simulation engine
├── whale-tracker.ts      # Leaderboard discovery & wallet ranking
├── whale-monitor.ts      # Real-time whale trade polling
├── whale-copy-engine.ts  # Copy trade execution engine
├── wallet-cluster.ts     # Wallet switch detection (fund flows + fingerprinting)
├── whale-types.ts        # Whale strategy type definitions
├── config.ts             # Configuration loader (.env)
├── types.ts              # TypeScript interfaces
├── scanner.ts            # Market scanner (Gamma API)
├── monitor.ts            # WebSocket real-time price monitor
├── trader.ts             # Trading engine (CLOB API)
├── risk.ts               # Risk management
└── logger.ts             # Colored console output
```

## API Endpoints Used

| API | Base URL | Auth Required |
|---|---|---|
| Gamma API | `https://gamma-api.polymarket.com` | No |
| CLOB API | `https://clob.polymarket.com` | Yes (for trading) |
| WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/` | No |
| Telonex API | `https://api.telonex.io/v1` | Yes (API key for downloads) |
| Data API | `https://data-api.polymarket.com` | No (leaderboard + trades) |

## Risk Disclaimer

**This software is for educational and research purposes only.** Trading on prediction markets involves significant risk. Past arbitrage opportunities do not guarantee future profits. Always:

- Start with small amounts
- Test in scan-only mode first
- Understand the fees (Polymarket charges ~2%)
- Account for gas costs on Polygon
- Never trade more than you can afford to lose

## License

MIT
