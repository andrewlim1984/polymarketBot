import { Config } from "./config";
import { Logger } from "./logger";
import { ArbitrageOpportunity, RiskState } from "./types";

export class RiskManager {
  private state: RiskState;
  private config: Config;
  private logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.state = {
      totalExposure: 0,
      dailyPnl: 0,
      dailyTradeCount: 0,
      openPositions: new Map(),
      killSwitchTriggered: false,
      lastResetDate: this.todayStr(),
    };
  }

  /**
   * Check if a trade opportunity passes all risk checks.
   * Returns { approved: boolean, reason?: string }
   */
  checkTrade(
    opportunity: ArbitrageOpportunity,
    tradeSize: number
  ): { approved: boolean; reason?: string } {
    // Daily reset check
    this.maybeResetDaily();

    // Kill switch
    if (this.state.killSwitchTriggered) {
      return { approved: false, reason: "Kill switch is active" };
    }

    // Daily loss limit
    if (this.state.dailyPnl < -this.config.dailyLossLimitUsdc) {
      this.triggerKillSwitch("Daily loss limit exceeded");
      return { approved: false, reason: `Daily loss limit exceeded ($${this.state.dailyPnl.toFixed(2)})` };
    }

    // Max trade size
    if (tradeSize > this.config.maxTradeSizeUsdc) {
      return {
        approved: false,
        reason: `Trade size $${tradeSize.toFixed(2)} exceeds max $${this.config.maxTradeSizeUsdc}`,
      };
    }

    // Max total exposure
    if (this.state.totalExposure + tradeSize > this.config.maxTotalExposureUsdc) {
      return {
        approved: false,
        reason: `Would exceed max exposure (current: $${this.state.totalExposure.toFixed(2)}, limit: $${this.config.maxTotalExposureUsdc})`,
      };
    }

    // Minimum spread (already checked in scanner, but double-check)
    if (opportunity.spread < this.config.minSpreadThreshold) {
      return {
        approved: false,
        reason: `Spread ${(opportunity.spread * 100).toFixed(2)}% below threshold ${(this.config.minSpreadThreshold * 100).toFixed(2)}%`,
      };
    }

    // Check minimum liquidity
    const minLiquidity = Math.min(
      ...opportunity.markets.map((m) => m.liquidity || 0)
    );
    if (minLiquidity < this.config.minLiquidityUsdc) {
      return {
        approved: false,
        reason: `Insufficient liquidity ($${minLiquidity.toFixed(2)} < $${this.config.minLiquidityUsdc} minimum)`,
      };
    }

    return { approved: true };
  }

  /**
   * Calculate the optimal trade size for an opportunity.
   * Considers max trade size, available exposure room, and orderbook depth.
   */
  calculateTradeSize(opportunity: ArbitrageOpportunity): number {
    const maxFromConfig = this.config.maxTradeSizeUsdc;
    const maxFromExposure = this.config.maxTotalExposureUsdc - this.state.totalExposure;

    // Use the minimum liquidity across all markets in the opportunity
    const minLiquidity = Math.min(
      ...opportunity.markets.map((m) => m.liquidity || 0)
    );
    // Don't take more than 10% of the available liquidity
    const maxFromLiquidity = minLiquidity * 0.1;

    const tradeSize = Math.min(maxFromConfig, maxFromExposure, maxFromLiquidity);

    return Math.max(0, tradeSize);
  }

  /**
   * Record a completed trade for risk tracking.
   */
  recordTrade(tokenId: string, size: number, pnl: number): void {
    this.state.totalExposure += size;
    this.state.dailyPnl += pnl;
    this.state.dailyTradeCount += 1;

    const currentPos = this.state.openPositions.get(tokenId) || 0;
    this.state.openPositions.set(tokenId, currentPos + size);
  }

  /**
   * Record that a position has been closed (resolved).
   */
  closePosition(tokenId: string, size: number, pnl: number): void {
    this.state.totalExposure = Math.max(0, this.state.totalExposure - size);
    this.state.dailyPnl += pnl;

    const currentPos = this.state.openPositions.get(tokenId) || 0;
    this.state.openPositions.set(tokenId, Math.max(0, currentPos - size));
  }

  /** Trigger the kill switch - stops all trading. */
  triggerKillSwitch(reason: string): void {
    this.state.killSwitchTriggered = true;
    this.logger.riskAlert(`KILL SWITCH TRIGGERED: ${reason}`);
  }

  /** Reset the kill switch (manual override). */
  resetKillSwitch(): void {
    this.state.killSwitchTriggered = false;
    this.logger.info("Kill switch reset manually.");
  }

  /** Get current risk state. */
  getState(): Readonly<RiskState> {
    return { ...this.state, openPositions: new Map(this.state.openPositions) };
  }

  /** Reset daily counters if a new day has started. */
  private maybeResetDaily(): void {
    const today = this.todayStr();
    if (today !== this.state.lastResetDate) {
      this.logger.info(`New day detected (${today}), resetting daily counters.`);
      this.state.dailyPnl = 0;
      this.state.dailyTradeCount = 0;
      this.state.lastResetDate = today;
      // Reset kill switch on new day
      if (this.state.killSwitchTriggered) {
        this.state.killSwitchTriggered = false;
        this.logger.info("Kill switch auto-reset for new day.");
      }
    }
  }

  private todayStr(): string {
    return new Date().toISOString().split("T")[0];
  }
}
