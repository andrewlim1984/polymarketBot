# Testing Polymarket Whale Copy-Trading Strategy

## Overview
The whale copy-trading strategy has two CLI entry points:
- `npm run whale` — Live whale monitoring (runs continuously until SIGINT)
- `npm run whale:backtest` — Historical backtest simulation (runs to completion)

Both hit public Polymarket APIs (no auth required for read-only mode).

## Devin Secrets Needed
- No secrets needed for basic whale strategy testing (leaderboard and trades APIs are public)
- `TELONEX_API_KEY` — Only needed for the arbitrage backtest (`npm run backtest`), not for whale strategy
- `PRIVATE_KEY` + `WALLET_ADDRESS` — Only needed if testing with `WHALE_AUTO_TRADE=true`

## Environment Setup
```bash
cd /home/ubuntu/repos/polymarket-scanner
npm install
npm run typecheck  # Verify clean build
```

## Testing npm run whale (Live Scanner)
Use small values to keep the test quick:
```bash
WHALE_TOP_WALLETS=3 WHALE_MIN_PNL=5000 timeout 45 npm run whale
```

**Expected output pattern:**
1. Banner: "POLYMARKET WHALE COPY-TRADER v1.0"
2. Config JSON printed
3. "Fetching Polymarket leaderboard..."
4. "Discovered X whales" with wallet addresses and PnL values
5. Top whale listing: rank, username, PnL, volume, wallet prefix
6. "Monitoring X whales. Polling every 15s. Auto-trade: OFF"
7. Trade polling starts (may show "no new trades" or actual copy signals)

**Things to verify:**
- Whale PnL values should be large positive numbers (top Polymarket traders have $millions in PnL)
- Wallet addresses should be valid Ethereum addresses (0x...)
- No crashes, no Infinity/NaN values
- The process runs continuously and responds to SIGINT gracefully

## Testing npm run whale:backtest
Use small values for a quick test:
```bash
WHALE_BT_TOP_WALLETS=3 WHALE_BT_LOOKBACK_DAYS=3 WHALE_BT_COPY_DELAY_MS=5000 npm run whale:backtest
```

**Expected output pattern:**
1. Banner: "POLYMARKET WHALE COPY-TRADING BACKTEST"
2. Steps 1-4 progress logging
3. Full report with sections: Configuration, Overview, Trade Statistics, Profit & Loss, Returns, Risk Metrics, Risk Constraints (if any skipped), Top Whales, Top 10 Trades, Equity Curve (ASCII)
4. "Results exported to .../whale-backtest-results.json"

**Things to verify:**
- No Infinity or NaN in stats
- Win rate between 0-100%
- Trade titles reference real Polymarket markets
- whale-backtest-results.json is valid JSON
- Wallet addresses in JSON match real Ethereum addresses
- Risk constraints section shows skipped trades if daily loss limit or exposure limit was hit

**Timing notes:**
- With 3 wallets and 3 days lookback, backtest typically completes in under 10 seconds
- Larger runs (25 wallets, 14 days) can take several minutes due to API rate limiting (200ms delays between requests)
- For very large runs, use `NODE_OPTIONS="--max-old-space-size=4096"` to increase Node heap

## Testing Existing Arbitrage Scanner
```bash
npm run scan  # One-shot scan, no wallet needed
```
Verify it finds opportunities and doesn't flag zero-price markets as arbitrage.

## Known Issues / Gotchas
- ESLint config is missing from the repo — `npm run lint` will fail. Use `npm run typecheck` instead.
- The first whale on the leaderboard may have Vol: $0 if the API returns volume differently than expected.
- Backtest results are affected by whether markets have resolved — unresolved markets use current prices as exit, which can skew PnL.
- The daily loss limit can cause many trades to be skipped (41 of 47 in a test run), which is expected behavior when the limit is hit early.
