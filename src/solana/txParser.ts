import { Connection, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { TradeEvent, MintLeg, SOL_MINT } from "../types";
import { logger } from "../logger";
import { eventLog } from "../state/eventLog";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * getTransaction/getParsedTransaction only serve "confirmed" or "finalized" data. Since we now
 * subscribe to logs at "processed" commitment for lower latency, the transaction can briefly be
 * unavailable at "confirmed" right after the notification fires - retry a few times instead of
 * treating that race as a miss.
 */
async function fetchConfirmedTransaction(
  connection: Connection,
  signature: string,
  attempts = 8,
  delayMs = 250
): Promise<ParsedTransactionWithMeta | null> {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    await sleep(delayMs);
  }
  return null;
}

interface TokenBalanceEntry {
  mint: string;
  amountRaw: bigint;
  decimals: number;
}

function extractOwnedBalances(
  entries: readonly TokenBalance[] | null | undefined,
  owner: string
): Map<string, TokenBalanceEntry> {
  const map = new Map<string, TokenBalanceEntry>();
  for (const e of entries ?? []) {
    if (e.owner !== owner) continue;
    if (e.mint === SOL_MINT) continue; // wrapped SOL is tracked via native lamport balances instead
    const prev = map.get(e.mint);
    const amountRaw = BigInt(e.uiTokenAmount.amount);
    if (prev) {
      prev.amountRaw += amountRaw;
    } else {
      map.set(e.mint, { mint: e.mint, amountRaw, decimals: e.uiTokenAmount.decimals });
    }
  }
  return map;
}

/**
 * Fetches and parses a confirmed transaction into every non-zero balance change ("leg") on `owner`
 * - native SOL plus any SPL tokens. Returns null only if the tx failed, isn't available, or the
 * owner had literally no balance change (nothing to copy either way).
 */
export async function parseTradeForWallet(
  connection: Connection,
  signature: string,
  owner: string
): Promise<TradeEvent | null> {
  const tx = await fetchConfirmedTransaction(connection, signature);

  if (!tx) {
    logger.warn(`Gave up waiting for tx ${signature} to become available at "confirmed" commitment.`);
    return null;
  }
  if (!tx.meta || tx.meta.err) {
    logger.info(`Tx ${signature} failed on-chain (err=${JSON.stringify(tx?.meta?.err)}); skipping.`);
    return null;
  }

  const accountKeys = tx.transaction.message.accountKeys;
  const ownerIndex = accountKeys.findIndex((a) => a.pubkey.toBase58() === owner);
  if (ownerIndex === -1) {
    logger.warn(`Tx ${signature}: target wallet ${owner} not found in account keys; skipping.`);
    return null;
  }

  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;
  let solBefore = BigInt(preBalances[ownerIndex]);
  let solAfter = BigInt(postBalances[ownerIndex]);
  if (ownerIndex === 0) {
    // fee payer: add the network fee back so the delta reflects only the trade itself
    solAfter += BigInt(tx.meta.fee);
  }
  const solDelta = solAfter - solBefore;

  const before = extractOwnedBalances(tx.meta.preTokenBalances, owner);
  const after = extractOwnedBalances(tx.meta.postTokenBalances, owner);
  const mints = new Set<string>([...before.keys(), ...after.keys()]);

  const legs: MintLeg[] = [];
  if (solDelta !== 0n) {
    legs.push({ mint: SOL_MINT, decimals: 9, beforeRaw: solBefore, afterRaw: solAfter, deltaRaw: solDelta });
  }
  for (const mint of mints) {
    const b = before.get(mint)?.amountRaw ?? 0n;
    const a = after.get(mint)?.amountRaw ?? 0n;
    const decimals = after.get(mint)?.decimals ?? before.get(mint)?.decimals ?? 0;
    const delta = a - b;
    if (delta !== 0n) {
      legs.push({ mint, decimals, beforeRaw: b, afterRaw: a, deltaRaw: delta });
    }
  }

  if (legs.length === 0) {
    const msg = `Tx ${signature}: target wallet had no net balance change; skipping.`;
    logger.info(msg);
    eventLog.add("skip", msg, { signature });
    return null;
  }

  logger.info(
    `Parsed trade on tx ${signature}: ${legs.map((l) => `${l.mint}:${l.deltaRaw}`).join(", ")}`
  );

  return { signature, legs };
}
