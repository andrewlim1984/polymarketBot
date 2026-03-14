import chalk from "chalk";
import { ArbitrageOpportunity, TradeRecord } from "./types";

export class Logger {
  private startTime: Date;

  constructor() {
    this.startTime = new Date();
  }

  info(message: string): void {
    console.log(chalk.gray(`[${this.timestamp()}]`) + " " + chalk.white(message));
  }

  success(message: string): void {
    console.log(chalk.gray(`[${this.timestamp()}]`) + " " + chalk.green(message));
  }

  warn(message: string): void {
    console.log(chalk.gray(`[${this.timestamp()}]`) + " " + chalk.yellow(message));
  }

  error(message: string): void {
    console.log(chalk.gray(`[${this.timestamp()}]`) + " " + chalk.red(message));
  }

  banner(): void {
    console.log(chalk.cyan("\n" +
      "╔══════════════════════════════════════════════════╗\n" +
      "║       POLYMARKET ARBITRAGE SCANNER v1.0          ║\n" +
      "║       Scanning for YES+NO != $1.00               ║\n" +
      "╚══════════════════════════════════════════════════╝\n"
    ));
  }

  scanStart(marketCount: number): void {
    console.log(
      chalk.gray(`[${this.timestamp()}]`) +
      chalk.cyan(` 🔍 Scanning ${marketCount} markets for arbitrage opportunities...`)
    );
  }

  scanComplete(opportunities: number, elapsed: number): void {
    if (opportunities > 0) {
      console.log(
        chalk.gray(`[${this.timestamp()}]`) +
        chalk.green(` ✅ Found ${opportunities} opportunities (${elapsed}ms)`)
      );
    } else {
      console.log(
        chalk.gray(`[${this.timestamp()}]`) +
        chalk.gray(` No opportunities found (${elapsed}ms)`)
      );
    }
  }

  opportunity(opp: ArbitrageOpportunity): void {
    const spreadPct = (opp.spread * 100).toFixed(2);
    const profitPct = (opp.profitPerDollar * 100).toFixed(2);
    const header = opp.type === "single-market"
      ? `SINGLE-MARKET ARB: ${opp.markets[0].question}`
      : `MULTI-MARKET ARB: ${opp.eventTitle}`;

    console.log("\n" + chalk.bgYellow.black(` 💰 ${header} `));
    console.log(chalk.yellow(`   Type: ${opp.type}`));
    console.log(chalk.yellow(`   Price Sum: $${opp.priceSum.toFixed(4)}`));
    console.log(chalk.yellow(`   Spread: ${spreadPct}%`));
    console.log(chalk.green(`   Profit/Dollar: ${profitPct}%`));
    console.log(chalk.yellow(`   Strategy: ${opp.strategy}`));

    for (let i = 0; i < opp.markets.length; i++) {
      const m = opp.markets[i];
      const prices = m.outcomePrices.map((p, idx) => `${m.outcomes[idx]}: $${p.toFixed(4)}`).join(", ");
      console.log(chalk.gray(`   Market ${i + 1}: ${m.question} [${prices}]`));
    }
    console.log("");
  }

  trade(record: TradeRecord): void {
    const statusColor = record.status === "filled" ? chalk.green :
      record.status === "failed" ? chalk.red : chalk.yellow;
    console.log(
      chalk.gray(`[${this.timestamp()}]`) +
      chalk.magenta(` 📊 TRADE: `) +
      chalk.white(`${record.side} $${record.size.toFixed(2)} @ $${record.price.toFixed(4)} `) +
      statusColor(`[${record.status}]`) +
      (record.orderId ? chalk.gray(` orderId: ${record.orderId}`) : "")
    );
  }

  riskAlert(message: string): void {
    console.log(
      chalk.gray(`[${this.timestamp()}]`) +
      chalk.bgRed.white(` ⚠️  RISK ALERT: ${message} `)
    );
  }

  stats(data: {
    totalScans: number;
    totalOpportunities: number;
    totalTrades: number;
    totalPnl: number;
    uptime: number;
  }): void {
    const uptimeMin = Math.floor(data.uptime / 60000);
    console.log(chalk.cyan("\n--- Session Stats ---"));
    console.log(chalk.white(`  Uptime: ${uptimeMin} minutes`));
    console.log(chalk.white(`  Total Scans: ${data.totalScans}`));
    console.log(chalk.white(`  Opportunities Found: ${data.totalOpportunities}`));
    console.log(chalk.white(`  Trades Executed: ${data.totalTrades}`));
    console.log(
      (data.totalPnl >= 0 ? chalk.green : chalk.red)(`  PnL: $${data.totalPnl.toFixed(2)}`)
    );
    console.log(chalk.cyan("---------------------\n"));
  }

  private timestamp(): string {
    return new Date().toISOString().replace("T", " ").substring(0, 19);
  }
}
