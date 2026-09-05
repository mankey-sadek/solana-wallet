import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../logger";
import { parseSwapForWallet } from "./txParser";
import { SwapEvent } from "../types";
import { eventLog } from "../state/eventLog";

export type SwapHandler = (event: SwapEvent) => Promise<void>;

/**
 * Subscribes to the target wallet's transaction logs over the RPC websocket and forwards
 * detected SOL<->token swaps to `onSwap`. Each signature is processed sequentially to avoid
 * racing overlapping buys/sells against the same position.
 */
export function watchWallet(connection: Connection, walletAddress: string, onSwap: SwapHandler): number {
  const pubkey = new PublicKey(walletAddress);
  let queue: Promise<void> = Promise.resolve();

  const subscriptionId = connection.onLogs(
    pubkey,
    (logInfo) => {
      if (logInfo.err) return; // ignore failed transactions
      const signature = logInfo.signature;
      queue = queue
        .then(async () => {
          try {
            const event = await parseSwapForWallet(connection, signature, walletAddress);
            if (event) await onSwap(event);
          } catch (err) {
            logger.error(`Failed to process tx ${signature}:`, err);
            eventLog.add("error", `Failed to process tx ${signature}: ${(err as Error).message ?? err}`, {
              signature,
            });
          }
        })
        .catch((err) => logger.error("Unexpected error in swap queue:", err));
    },
    // "processed" fires as soon as a leader accepts the tx, well before "confirmed" - the tx
    // fetch in txParser retries until the data is available at "confirmed" commitment.
    "processed"
  );

  logger.info(`Subscribed to logs for ${walletAddress} (subscription id ${subscriptionId})`);
  return subscriptionId;
}
