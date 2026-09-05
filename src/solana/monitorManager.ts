import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../logger";
import { eventLog } from "../state/eventLog";
import { runtimeConfig } from "../state/runtimeConfig";
import { watchWallet, SwapHandler } from "./walletMonitor";

/**
 * Owns the live logs subscription so the watched wallet can be swapped at runtime (from the
 * dashboard) without restarting the process: unsubscribes the old address and resubscribes the new
 * one. The choice is persisted to data/runtime-config.json so it survives restarts.
 */
export class MonitorManager {
  private subscriptionId: number | null = null;
  private currentWallet: string;

  constructor(private connection: Connection, private onSwap: SwapHandler, initialWallet: string) {
    this.currentWallet = initialWallet;
  }

  start(): void {
    this.subscriptionId = watchWallet(this.connection, this.currentWallet, this.onSwap);
  }

  get targetWallet(): string {
    return this.currentWallet;
  }

  async setTarget(rawAddress: string): Promise<string> {
    const trimmed = rawAddress.trim();
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(trimmed);
    } catch {
      throw new Error("عنوان محفظة سولانا غير صالح");
    }
    const normalized = pubkey.toBase58();

    if (normalized === this.currentWallet) {
      return normalized;
    }

    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
    }
    const previous = this.currentWallet;
    this.currentWallet = normalized;
    this.subscriptionId = watchWallet(this.connection, normalized, this.onSwap);
    runtimeConfig.set({ targetWallet: normalized });

    logger.info(`Switched target wallet from ${previous} to ${normalized}`);
    eventLog.add("info", `تم تغيير المحفظة المستهدفة إلى ${normalized}`, {
      previous,
      next: normalized,
    });

    return normalized;
  }
}
