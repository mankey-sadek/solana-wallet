import { Connection, ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { SwapEvent, SOL_MINT } from "../types";
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
  owner?: string;
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
    if (e.mint === SOL_MINT) continue; // native SOL is tracked via lamport balances, not wrapped-SOL token accounts
    const prev = map.get(e.mint);
    const amountRaw = BigInt(e.uiTokenAmount.amount);
    if (prev) {
      prev.amountRaw += amountRaw;
    } else {
      map.set(e.mint, { mint: e.mint, owner, amountRaw, decimals: e.uiTokenAmount.decimals });
    }
  }
  return map;
}

/**
 * Fetches and parses a confirmed transaction, looking for a net SOL<->SPL-token swap on `owner`.
 * Returns null if the tx failed, doesn't involve `owner`, or isn't a recognizable single-token swap
 * (e.g. token<->token swaps or multi-hop trades touching several mints are skipped for safety).
 */
export async function parseSwapForWallet(
  connection: Connection,
  signature: string,
  owner: string
): Promise<SwapEvent | null> {
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
  let solDeltaLamports = BigInt(postBalances[ownerIndex]) - BigInt(preBalances[ownerIndex]);
  if (ownerIndex === 0) {
    // fee payer: add the network fee back so the delta reflects only the swap itself
    solDeltaLamports += BigInt(tx.meta.fee);
  }

  const before = extractOwnedBalances(tx.meta.preTokenBalances, owner);
  const after = extractOwnedBalances(tx.meta.postTokenBalances, owner);

  const mints = new Set<string>([...before.keys(), ...after.keys()]);
  const changed = [...mints]
    .map((mint) => {
      const b = before.get(mint)?.amountRaw ?? 0n;
      const a = after.get(mint)?.amountRaw ?? 0n;
      const decimals = after.get(mint)?.decimals ?? before.get(mint)?.decimals ?? 0;
      return { mint, before: b, after: a, delta: a - b, decimals };
    })
    .filter((m) => m.delta !== 0n);

  if (changed.length === 0) {
    const msg = `Tx ${signature}: target wallet had no net SPL-token balance change (not a token swap from its perspective); skipping.`;
    logger.info(msg);
    eventLog.add("skip", msg, { signature });
    return null;
  }

  if (changed.length > 1) {
    const mintList = changed.map((m) => m.mint).join(", ");
    const msg = `Tx ${signature} touches ${changed.length} token mints (${mintList}) for target wallet; skipping (not a simple SOL<->token swap).`;
    logger.warn(msg);
    eventLog.add("skip", msg, { signature, mints: changed.map((m) => m.mint) });
    return null;
  }

  const t = changed[0];
  const side: "buy" | "sell" = t.delta > 0n ? "buy" : "sell";

  logger.info(
    `Parsed swap on tx ${signature}: ${side} ${t.mint}, tokenDelta=${t.delta}, solDeltaLamports=${solDeltaLamports}, preSol=${preBalances[ownerIndex]}`
  );

  return {
    signature,
    side,
    tokenMint: t.mint,
    tokenDecimals: t.decimals,
    tokenAmountRaw: t.delta > 0n ? t.delta : -t.delta,
    solAmountLamports: solDeltaLamports > 0n ? solDeltaLamports : -solDeltaLamports,
    targetSolBalanceBeforeLamports: BigInt(preBalances[ownerIndex]),
    targetTokenBalanceBeforeRaw: t.before,
    targetTokenBalanceAfterRaw: t.after,
  };
}
