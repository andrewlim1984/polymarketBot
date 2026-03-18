/**
 * Wallet Cluster Detection — detects when profitable traders switch wallets.
 *
 * Two detection methods:
 * 1. Fund flow: Track USDC transfers from known whales to new addresses on Polygon
 * 2. Behavioral: Compare trading fingerprints of inactive whales vs new leaderboard entrants
 */
import axios from "axios";
import { Logger } from "./logger";
import {
  WhaleConfig,
  WhaleProfile,
  WhaleTrade,
  WalletFingerprint,
  WalletCluster,
} from "./whale-types";

const DATA_API_URL = "https://data-api.polymarket.com";

// Polygon USDC contract (PoS bridged)
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

// ERC-20 Transfer event signature
const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export class WalletClusterDetector {
  private config: WhaleConfig;
  private logger: Logger;
  private clusters: Map<string, WalletCluster> = new Map();
  private fingerprints: Map<string, WalletFingerprint> = new Map();

  constructor(config: WhaleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Build a behavioral fingerprint from a wallet's recent trades.
   */
  async buildFingerprint(wallet: string, trades: WhaleTrade[]): Promise<WalletFingerprint> {
    if (trades.length === 0) {
      return this.emptyFingerprint(wallet);
    }

    const sizes = trades.map((t) => t.usdcValue);
    sizes.sort((a, b) => a - b);

    const avgTradeSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const medianTradeSize = sizes[Math.floor(sizes.length / 2)];

    const buyCount = trades.filter((t) => t.side === "BUY").length;
    const buyRatio = buyCount / trades.length;

    // Trades per day
    const timestamps = trades.map((t) => t.timestamp);
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const daySpan = Math.max(1, (maxTs - minTs) / 86400);
    const tradesPerDay = trades.length / daySpan;

    // Hour distribution
    const hourDistribution = new Array(24).fill(0);
    for (const trade of trades) {
      const hour = new Date(trade.timestamp * 1000).getUTCHours();
      hourDistribution[hour]++;
    }
    // Normalize
    const totalTrades = trades.length;
    for (let i = 0; i < 24; i++) {
      hourDistribution[i] /= totalTrades;
    }

    // Categories and markets traded
    const categories = new Set<string>();
    const marketsTraded = new Set<string>();
    for (const trade of trades) {
      if (trade.eventSlug) categories.add(trade.eventSlug.split("-")[0] || "unknown");
      if (trade.conditionId) marketsTraded.add(trade.conditionId);
    }

    const fingerprint: WalletFingerprint = {
      proxyWallet: wallet.toLowerCase(),
      avgTradeSize,
      medianTradeSize,
      tradesPerDay,
      buyRatio,
      categories,
      marketsTraded,
      hourDistribution,
      lastTradeTimestamp: maxTs,
      tradeCount: trades.length,
    };

    this.fingerprints.set(wallet.toLowerCase(), fingerprint);
    return fingerprint;
  }

  /**
   * Calculate similarity between two wallet fingerprints (0-1).
   * Higher = more similar.
   */
  calculateSimilarity(a: WalletFingerprint, b: WalletFingerprint): number {
    if (a.tradeCount < 5 || b.tradeCount < 5) return 0;

    // Trade size similarity (normalized)
    const maxAvg = Math.max(a.avgTradeSize, b.avgTradeSize);
    const sizeSim = maxAvg > 0 ? 1 - Math.abs(a.avgTradeSize - b.avgTradeSize) / maxAvg : 0;

    // Trades per day similarity
    const maxTpd = Math.max(a.tradesPerDay, b.tradesPerDay);
    const tpdSim = maxTpd > 0 ? 1 - Math.abs(a.tradesPerDay - b.tradesPerDay) / maxTpd : 0;

    // Buy ratio similarity
    const buySim = 1 - Math.abs(a.buyRatio - b.buyRatio);

    // Hour distribution similarity (cosine similarity)
    const hourSim = this.cosineSimilarity(a.hourDistribution, b.hourDistribution);

    // Market overlap (Jaccard index)
    const marketOverlap = this.jaccardIndex(a.marketsTraded, b.marketsTraded);

    // Weighted combination
    return (
      sizeSim * 0.2 +
      tpdSim * 0.15 +
      buySim * 0.1 +
      hourSim * 0.2 +
      marketOverlap * 0.35
    );
  }

  /**
   * Detect potential wallet switches by comparing inactive whales with new wallets.
   */
  async detectSwitches(
    inactiveWhales: WhaleProfile[],
    newWallets: WhaleProfile[],
    fetchTrades: (wallet: string) => Promise<WhaleTrade[]>
  ): Promise<WalletCluster[]> {
    const newClusters: WalletCluster[] = [];

    // Build fingerprints for inactive whales (use cached if available)
    for (const whale of inactiveWhales) {
      if (!this.fingerprints.has(whale.proxyWallet)) {
        const trades = await fetchTrades(whale.proxyWallet);
        await this.buildFingerprint(whale.proxyWallet, trades);
        await sleep(200);
      }
    }

    // Build fingerprints for new wallets and compare
    for (const newWallet of newWallets) {
      const newTrades = await fetchTrades(newWallet.proxyWallet);
      const newFp = await this.buildFingerprint(newWallet.proxyWallet, newTrades);
      await sleep(200);

      for (const oldWhale of inactiveWhales) {
        const oldFp = this.fingerprints.get(oldWhale.proxyWallet);
        if (!oldFp) continue;

        const similarity = this.calculateSimilarity(oldFp, newFp);

        if (similarity >= this.config.clusterSimilarityThreshold) {
          const clusterId = `cluster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const cluster: WalletCluster = {
            id: clusterId,
            wallets: [oldWhale.proxyWallet, newWallet.proxyWallet],
            primaryWallet: oldWhale.proxyWallet,
            linkType: "behavioral",
            similarityScore: similarity,
            createdAt: Date.now(),
          };

          this.clusters.set(clusterId, cluster);
          newClusters.push(cluster);

          this.logger.info(
            `Wallet switch detected (behavioral): ${oldWhale.userName} ` +
            `(${oldWhale.proxyWallet.slice(0, 10)}...) → ${newWallet.userName} ` +
            `(${newWallet.proxyWallet.slice(0, 10)}...) — similarity: ${(similarity * 100).toFixed(1)}%`
          );
        }
      }
    }

    return newClusters;
  }

  /**
   * Check for USDC fund flows from known whale wallets to new addresses.
   * Uses Polygon RPC to query Transfer events.
   */
  async detectFundFlows(
    whaleAddresses: string[],
    fromBlock: string = "latest"
  ): Promise<Array<{ from: string; to: string; value: string }>> {
    if (!this.config.rpcUrl) return [];

    const transfers: Array<{ from: string; to: string; value: string }> = [];

    for (const whale of whaleAddresses) {
      try {
        // Pad address to 32 bytes for topic filter
        const paddedAddress = "0x" + whale.replace("0x", "").padStart(64, "0");

        const response = await axios.post(this.config.rpcUrl, {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [{
            address: this.config.usdcAddress || USDC_ADDRESS,
            topics: [
              TRANSFER_EVENT_TOPIC,
              paddedAddress, // from (whale is sender)
            ],
            fromBlock,
            toBlock: "latest",
          }],
        }, { timeout: 10000 });

        if (response.data?.result) {
          for (const log of response.data.result) {
            const to = "0x" + (log.topics[2] as string).slice(26).toLowerCase();
            const value = log.data;

            // Only track significant transfers (> $100 USDC)
            const usdcAmount = parseInt(value, 16) / 1e6;
            if (usdcAmount > 100) {
              transfers.push({
                from: whale.toLowerCase(),
                to,
                value: usdcAmount.toFixed(2),
              });

              // Check if this is a new wallet we should track
              const isKnown = whaleAddresses.some((w) => w.toLowerCase() === to);
              if (!isKnown) {
                const clusterId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const cluster: WalletCluster = {
                  id: clusterId,
                  wallets: [whale.toLowerCase(), to],
                  primaryWallet: whale.toLowerCase(),
                  linkType: "fund-flow",
                  createdAt: Date.now(),
                };

                this.clusters.set(clusterId, cluster);

                this.logger.info(
                  `Fund flow detected: ${whale.slice(0, 10)}... → ${to.slice(0, 10)}... ` +
                  `($${usdcAmount.toFixed(2)} USDC) — possible wallet switch`
                );
              }
            }
          }
        }

        await sleep(200);
      } catch (error) {
        this.logger.error(`Failed to query fund flows for ${whale.slice(0, 10)}...: ${error}`);
      }
    }

    return transfers;
  }

  /** Get all detected clusters. */
  getClusters(): WalletCluster[] {
    return Array.from(this.clusters.values());
  }

  /** Get all wallets in a cluster. */
  getClusterWallets(clusterId: string): string[] {
    return this.clusters.get(clusterId)?.wallets || [];
  }

  /** Get fingerprint for a wallet. */
  getFingerprint(wallet: string): WalletFingerprint | undefined {
    return this.fingerprints.get(wallet.toLowerCase());
  }

  /** Cosine similarity between two vectors. */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dotProduct / denom : 0;
  }

  /** Jaccard index between two sets. */
  private jaccardIndex(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /** Empty fingerprint for wallets with no trades. */
  private emptyFingerprint(wallet: string): WalletFingerprint {
    return {
      proxyWallet: wallet.toLowerCase(),
      avgTradeSize: 0,
      medianTradeSize: 0,
      tradesPerDay: 0,
      buyRatio: 0,
      categories: new Set(),
      marketsTraded: new Set(),
      hourDistribution: new Array(24).fill(0),
      lastTradeTimestamp: 0,
      tradeCount: 0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
