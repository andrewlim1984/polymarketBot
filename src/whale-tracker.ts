/**
 * Whale Tracker — discovers and ranks the most profitable Polymarket wallets
 * using the public Data API leaderboard endpoint.
 */
import axios from "axios";
import { Logger } from "./logger";
import { WhaleProfile, WhaleConfig } from "./whale-types";

const DATA_API_URL = "https://data-api.polymarket.com";

interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  vol: number;
  pnl: number;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
}

export class WhaleTracker {
  private config: WhaleConfig;
  private logger: Logger;
  private trackedWhales: Map<string, WhaleProfile> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(config: WhaleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Fetch the leaderboard and populate tracked whales.
   * Returns the list of whale profiles discovered.
   */
  async discover(): Promise<WhaleProfile[]> {
    this.logger.info("Fetching Polymarket leaderboard...");

    const profiles: WhaleProfile[] = [];
    let offset = 0;
    const limit = 50; // API max per request

    while (profiles.length < this.config.topWalletsCount) {
      const remaining = this.config.topWalletsCount - profiles.length;
      const fetchLimit = Math.min(limit, remaining);

      try {
        const response = await axios.get<LeaderboardEntry[]>(`${DATA_API_URL}/v1/leaderboard`, {
          params: {
            category: this.config.leaderboardCategory,
            timePeriod: this.config.leaderboardPeriod,
            orderBy: "PNL",
            limit: fetchLimit,
            offset,
          },
          timeout: 15000,
        });

        if (!response.data || response.data.length === 0) break;

        for (const entry of response.data) {
          const pnl = Number(entry.pnl) || 0;

          // Skip wallets below minimum PnL threshold
          if (pnl < this.config.minWhalePnl) continue;

          const profile: WhaleProfile = {
            proxyWallet: entry.proxyWallet.toLowerCase(),
            userName: entry.userName || `Wallet-${entry.proxyWallet.slice(0, 8)}`,
            pnl,
            volume: Number(entry.vol) || 0,
            rank: parseInt(entry.rank, 10) || offset + profiles.length + 1,
            category: this.config.leaderboardCategory,
            timePeriod: this.config.leaderboardPeriod,
            lastUpdated: Date.now(),
            isActive: true,
          };

          profiles.push(profile);
          this.trackedWhales.set(profile.proxyWallet, profile);
        }

        offset += response.data.length;

        // Avoid rate limiting
        await sleep(200);
      } catch (error) {
        this.logger.error(`Failed to fetch leaderboard page (offset=${offset}): ${error}`);
        break;
      }
    }

    this.logger.success(
      `Discovered ${profiles.length} whales (min PnL: $${this.config.minWhalePnl}, ` +
      `period: ${this.config.leaderboardPeriod}, category: ${this.config.leaderboardCategory})`
    );

    // Log top 5
    const top5 = profiles.slice(0, 5);
    for (const whale of top5) {
      this.logger.info(
        `  #${whale.rank} ${whale.userName} — PnL: $${whale.pnl.toLocaleString()} | ` +
        `Vol: $${whale.volume.toLocaleString()} | ${whale.proxyWallet.slice(0, 10)}...`
      );
    }

    return profiles;
  }

  /**
   * Start periodic leaderboard refresh in the background.
   */
  startRefreshLoop(): void {
    if (this.refreshTimer) return;

    this.refreshTimer = setInterval(async () => {
      try {
        this.logger.info("Refreshing whale leaderboard...");
        const newProfiles = await this.discover();

        // Detect new entrants (wallets that weren't tracked before)
        for (const profile of newProfiles) {
          if (!this.trackedWhales.has(profile.proxyWallet)) {
            this.logger.info(
              `New whale detected: ${profile.userName} (${profile.proxyWallet.slice(0, 10)}...) — ` +
              `PnL: $${profile.pnl.toLocaleString()}`
            );
          }
        }
      } catch (error) {
        this.logger.error(`Leaderboard refresh failed: ${error}`);
      }
    }, this.config.leaderboardRefreshMs);
  }

  /** Stop the refresh loop. */
  stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Get all currently tracked whale profiles. */
  getTrackedWhales(): WhaleProfile[] {
    return Array.from(this.trackedWhales.values());
  }

  /** Get a whale profile by wallet address. */
  getWhale(wallet: string): WhaleProfile | undefined {
    return this.trackedWhales.get(wallet.toLowerCase());
  }

  /** Get wallet addresses of all tracked whales. */
  getTrackedAddresses(): string[] {
    return Array.from(this.trackedWhales.keys());
  }

  /** Mark a wallet as inactive. */
  markInactive(wallet: string): void {
    const profile = this.trackedWhales.get(wallet.toLowerCase());
    if (profile) {
      profile.isActive = false;
    }
  }

  /** Add a wallet to track (e.g., from cluster detection). */
  addWallet(profile: WhaleProfile): void {
    this.trackedWhales.set(profile.proxyWallet.toLowerCase(), profile);
  }

  /** Link a wallet to a cluster. */
  linkToCluster(wallet: string, clusterId: string): void {
    const profile = this.trackedWhales.get(wallet.toLowerCase());
    if (profile) {
      profile.clusterId = clusterId;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
