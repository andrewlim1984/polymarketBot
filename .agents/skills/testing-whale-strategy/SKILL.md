# Testing the Whale Copy-Trading Strategy & Profiler

## Overview
The whale strategy has two main CLI entry points and a profiler module that classifies wallets. DEGENERATE wallets are automatically excluded from both live monitoring and backtesting.

## Devin Secrets Needed
- `TELONEX_API_KEY` — Required only for arbitrage backtests (not whale strategy)
- No auth needed for whale strategy — it uses Polymarket's public Data API and Gamma API

## Commands

### Whale Scanner (live monitoring)
```bash
WHALE_TOP_WALLETS=3 WHALE_MIN_PNL=5000 WHALE_PROFILE_MIN_TRADES=5 timeout 180 npm run whale
```
- Fetches leaderboard, profiles each whale, filters out DEGENERATEs
- Logs "Excluded N DEGENERATE wallet(s) from monitoring"
- If all whales are DEGENERATE, exits with error (exit code 1)
- Use `timeout` to prevent it from running indefinitely
- Use `WHALE_PROFILE=false` to skip profiling and disable DEGENERATE filtering

### Whale Backtest
```bash
WHALE_BT_TOP_WALLETS=3 WHALE_BT_LOOKBACK_DAYS=3 WHALE_BT_COPY_DELAY_MS=5000 WHALE_PROFILE_MIN_TRADES=3 npm run whale:backtest
```
- Step 1: Discovers whales from leaderboard
- Step 2: Profiles whales and filters out DEGENERATEs BEFORE simulation
- Steps 3-4: Runs backtest simulation on filtered wallets only
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

### DEGENERATE Filter Log
```
Excluded 3 DEGENERATE wallet(s) from monitoring. Tracking 2 whale(s) with edge.
```
or if all are DEGENERATE:
```
All discovered whales are DEGENERATE. No wallets to monitor.
```

### Whale Profiler Summary Table
```
--- Whale Profiles ---
  Type        Wallet        Conv   Win%   wWin%  Trades  Age   Primary Cat   HHI
  ----------------------------------------------------------------------------------
  INSIDER     0xabc123...   72%    65%    82%    450     230d  politics      85%
```

## Known Limitations & Gotchas

1. **Win rates might be 0% for recent/active whales**: The profiler determines wins by checking market resolution status via Gamma API. If the whale's recent trades are on markets that haven't resolved yet (very common for sports events), win rates will show 0% and ALL whales get classified as DEGENERATE. This means the DEGENERATE filter will exclude every whale and the scanner/backtest will exit. Workarounds:
   - Use `WHALE_PROFILE=false` to bypass profiling and DEGENERATE filtering
   - Use a longer lookback period where markets have had time to resolve
   - Test with MONTH leaderboard (`WHALE_LEADERBOARD_PERIOD=MONTH`) which may include wallets with more resolved markets

2. **Profiling takes 30-60 seconds per whale**: The profiler fetches up to 1000 trades per whale and resolves each unique market via Gamma API with 100-200ms delays. For 3 whales, expect ~1-2 minutes. For 25 whales, expect 5-10 minutes.

3. **Daily loss limit can skip most trades in backtest**: With default settings ($100 daily loss limit, $50 trade size), only 2 losing trades per day are allowed before the limit kicks in.

4. **Leaderboard returns different wallets each week**: The WEEK period leaderboard changes frequently. Test results are not reproducible across different days.

5. **TypeScript compilation**: Run `npm run typecheck` before testing. ESLint is not configured (pre-existing), so `npm run lint` will fail — this is expected.

6. **No unit tests**: The project has no automated test suite. All testing is manual via CLI commands against live APIs.

## Verification Checklist
- [ ] `npm run typecheck` passes cleanly
- [ ] `npm run whale` profiles whales and logs DEGENERATE exclusion count
- [ ] `npm run whale` exits gracefully if all whales are DEGENERATE
- [ ] `npm run whale:backtest` profiles whales in Step 2 (before simulation)
- [ ] No Infinity, NaN, or crash errors in output
- [ ] Conviction scores are between 0-1 (displayed as 0-100%)
- [ ] `whale-backtest-results.json` contains `whaleProfiles` array
- [ ] `WHALE_PROFILE=false` disables profiling and DEGENERATE filtering
