# Testing the Whale Copy-Trading Strategy & Profiler

## Overview
The whale strategy has two main CLI entry points and a profiler module that classifies wallets.

## Devin Secrets Needed
- `TELONEX_API_KEY` — Required only for arbitrage backtests (not whale strategy)
- No auth needed for whale strategy — it uses Polymarket's public Data API and Gamma API

## Commands

### Whale Scanner (live monitoring)
```bash
WHALE_TOP_WALLETS=3 WHALE_MIN_PNL=5000 WHALE_PROFILE_MIN_TRADES=5 timeout 180 npm run whale
```
- Fetches leaderboard, profiles each whale, prints summary table + top 5 detailed profiles
- Then starts polling trades (auto-trade OFF by default)
- Use `timeout` to prevent it from running indefinitely
- Use `WHALE_PROFILE=false` to skip profiling and test scanner alone

### Whale Backtest
```bash
WHALE_BT_TOP_WALLETS=3 WHALE_BT_LOOKBACK_DAYS=3 WHALE_BT_COPY_DELAY_MS=5000 WHALE_PROFILE_MIN_TRADES=3 npm run whale:backtest
```
- Fetches leaderboard, pulls trade histories, simulates copying, profiles whales
- Prints full report with equity curve and whale profiles section
- Exports results to `whale-backtest-results.json` (includes `whaleProfiles` array)

### Arbitrage Scanner
```bash
npm run scan
```
- One-shot scan, no credentials needed

### Arbitrage Backtest
```bash
TELONEX_API_KEY=$TELONEX_API_KEY BACKTEST_MAX_EVENTS=5 BACKTEST_LOOKBACK_DAYS=7 npm run backtest
```

## Expected Output Patterns

### Whale Profiler Summary Table
Look for this format:
```
--- Whale Profiles ---
  Type        Wallet        Conv   Win%   wWin%  Trades  Age   Primary Cat   HHI
  ----------------------------------------------------------------------------------
  INSIDER     0xabc123...   72%    65%    82%    450     230d  politics      85%
```

### Detailed Profile
```
  [INSIDER] username (0xabc123...) — Conviction: 72%
    Age: 230d | Trades: 450 (2.0/day) | Win: 65% raw, 82% weighted
    Avg Size: $5000 | Max: $50000 | Consistency: 75%
    Categories: 2 (politics) | Concentration: 85% HHI
    Classification: INSIDER (90% confidence)
    Reason: high weighted win rate in narrow categories
```

## Known Limitations & Gotchas

1. **Win rates might be 0% for recent/active whales**: The profiler determines wins by checking market resolution status via Gamma API. If the whale's recent trades are on markets that haven't resolved yet (common for sports events), win rates will show 0% and all whales get classified as DEGENERATE. This is correct behavior — try using a longer lookback period or testing during periods when more markets have resolved.

2. **Profiling takes 30-60 seconds per whale**: The profiler fetches up to 1000 trades per whale and resolves each unique market via Gamma API with 100-200ms delays. For 3 whales, expect ~1-2 minutes. For 25 whales, expect 5-10 minutes.

3. **Daily loss limit can skip most trades in backtest**: With default settings ($100 daily loss limit, $50 trade size), only 2 losing trades per day are allowed before the limit kicks in. The report shows "Skipped (Daily Loss)" count.

4. **Leaderboard returns different wallets each week**: The WEEK period leaderboard changes frequently. Test results are not reproducible across different days.

5. **TypeScript compilation**: Run `npm run typecheck` before testing. ESLint is not configured (pre-existing), so `npm run lint` will fail — this is expected.

6. **No unit tests**: The project has no automated test suite. All testing is manual via CLI commands against live APIs.

## Verification Checklist
- [ ] `npm run typecheck` passes cleanly
- [ ] `npm run whale` prints profiler summary table with valid types (INSIDER/QUANT/MARKET_MAKER/DEGENERATE/WALLET_FOLLOWER/UNKNOWN)
- [ ] No Infinity, NaN, or crash errors in output
- [ ] Conviction scores are between 0-1 (displayed as 0-100%)
- [ ] `npm run whale:backtest` includes "Whale Profiles" section in report
- [ ] `whale-backtest-results.json` contains `whaleProfiles` array with full profile data
- [ ] `WHALE_PROFILE=false` disables profiling without breaking scanner
