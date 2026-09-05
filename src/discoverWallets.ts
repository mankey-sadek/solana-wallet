import { Connection, PublicKey } from "@solana/web3.js";
import { createConnection } from "./solana/connection";
import { extractLegs } from "./solana/txParser";
import { SOL_MINT } from "./types";

export interface WalletStats {
  total: number;
  swap: number;
  tip: number;
  received: number;
  noChange: number;
  failed: number;
  unavailable: number;
  swapRatio: number;
  /**
   * Share of swaps whose SOL leg is the exact same lamport amount as the single most common one
   * seen. A human trader sizes each buy differently; a bot spraying a fixed stake across every new
   * token launch reuses the same amount over and over. High values here are a stronger "not worth
   * copying" signal than a low swapRatio, since the swaps are real but not discretionary.
   */
  fixedStakeRatio: number;
}

// Bucket SOL amounts to the nearest 0.01 SOL before comparing them: bots that "spray" a fixed stake
// rarely land on the exact same lamport count twice (slippage, priority fees), but cluster tightly
// around the same round target (e.g. ~0.1 SOL) - exact-match comparison would miss that pattern.
const STAKE_BUCKET_LAMPORTS = 10_000_000n;

export function bucketLamports(lamports: bigint): bigint {
  const abs = lamports < 0n ? -lamports : lamports;
  return (abs + STAKE_BUCKET_LAMPORTS / 2n) / STAKE_BUCKET_LAMPORTS;
}

/** Classifies a batch of already-fetched swap legs into the WalletStats shape above. */
function summarizeLegs(
  perTx: { sold: import("./types").MintLeg[]; bought: import("./types").MintLeg[] }[]
): { swap: number; tip: number; received: number; fixedStakeRatio: number } {
  let swap = 0;
  let tip = 0;
  let received = 0;
  const solAmountBuckets = new Map<string, number>();

  for (const { sold, bought } of perTx) {
    if (sold.length > 0 && bought.length > 0) {
      swap++;
      const solLeg = [...sold, ...bought].find((l) => l.mint === SOL_MINT);
      if (solLeg) {
        const bucket = bucketLamports(solLeg.deltaRaw).toString();
        solAmountBuckets.set(bucket, (solAmountBuckets.get(bucket) ?? 0) + 1);
      }
    } else if (sold.length === 1 && sold[0].mint === SOL_MINT && bought.length === 0) {
      tip++;
    } else {
      received++;
    }
  }

  const maxCount = Math.max(0, ...solAmountBuckets.values());
  const fixedStakeRatio = swap > 0 ? maxCount / swap : 0;
  return { swap, tip, received, fixedStakeRatio };
}

export interface WalletCandidate extends WalletStats {
  addr: string;
  mentionCount: number;
  tokenMint: string;
}

export async function classifyWallet(connection: Connection, address: string, sampleLimit: number): Promise<WalletStats> {
  const pubkey = new PublicKey(address);
  const sigInfos = await connection.getSignaturesForAddress(pubkey, { limit: sampleLimit });

  let noChange = 0;
  let failed = 0;
  let unavailable = 0;
  const perTx: { sold: import("./types").MintLeg[]; bought: import("./types").MintLeg[] }[] = [];

  for (const info of sigInfos) {
    if (info.err) {
      failed++;
      continue;
    }
    const tx = await connection.getParsedTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta) {
      unavailable++;
      continue;
    }
    const legs = extractLegs(tx, address);
    if (legs === null || legs.length === 0) {
      noChange++;
      continue;
    }
    perTx.push({
      sold: legs.filter((l) => l.deltaRaw < 0n),
      bought: legs.filter((l) => l.deltaRaw > 0n),
    });
  }

  const { swap, tip, received, fixedStakeRatio } = summarizeLegs(perTx);
  const total = sigInfos.length;
  return { total, swap, tip, received, noChange, failed, unavailable, swapRatio: total > 0 ? swap / total : 0, fixedStakeRatio };
}

/**
 * Finds the wallets most actively trading `tokenMint` (by tallying who signs transactions that
 * touch it), then vets each one's *own* trade history with `classifyWallet`. Pure - does no
 * console output - so it can be reused by both the single-token CLI below and the fully-automatic
 * discovery script.
 */
export async function discoverForToken(
  connection: Connection,
  tokenMint: string,
  txSampleSize: number,
  topN: number,
  vetSampleSize: number
): Promise<WalletCandidate[]> {
  const mintPubkey = new PublicKey(tokenMint);
  const sigInfos = await connection.getSignaturesForAddress(mintPubkey, { limit: txSampleSize });

  const freq = new Map<string, number>();
  for (const info of sigInfos) {
    if (info.err) continue;
    const tx = await connection.getParsedTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;
    for (const key of tx.transaction.message.accountKeys) {
      if (!key.signer) continue;
      const addr = key.pubkey.toBase58();
      freq.set(addr, (freq.get(addr) ?? 0) + 1);
    }
  }

  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  const results: WalletCandidate[] = [];
  for (const [addr, mentionCount] of ranked) {
    const stats = await classifyWallet(connection, addr, vetSampleSize);
    results.push({ addr, mentionCount, tokenMint, ...stats });
  }
  return results;
}

const FIXED_STAKE_WARN_THRESHOLD = 0.2;

export function verdictFor(swapRatio: number, fixedStakeRatio: number, swapCount: number): string {
  const base = swapRatio < 0.05 ? "mostly noise" : swapRatio < 0.3 ? "usable" : "clean signal";
  if (swapCount >= 5 && fixedStakeRatio >= FIXED_STAKE_WARN_THRESHOLD) {
    return (
      `${base}, BUT ${(fixedStakeRatio * 100).toFixed(0)}% of its swaps cluster around the same SOL ` +
      "stake size - possible fixed-stake spray bot, not a discretionary trader. Eyeball the trade list before trusting this one."
    );
  }
  return base;
}

/** Real trading signal, without the strongest fixed-stake spray-bot fingerprint. */
export function isGoodCandidate(r: WalletStats): boolean {
  return r.swapRatio >= 0.1 && !(r.swap >= 5 && r.fixedStakeRatio >= FIXED_STAKE_WARN_THRESHOLD);
}

async function main() {
  const tokenMint = process.argv[2];
  const txSampleSize = Number(process.argv[3]) || 60;
  const topN = Number(process.argv[4]) || 5;
  const vetSampleSize = Number(process.argv[5]) || 15;

  if (!tokenMint) {
    console.error("Usage: npm run discover -- <token-mint> [txSampleSize=60] [topN=5] [vetSampleSize=15]");
    console.error("Give it any token's contract address (from gmgn's Trending page, for example).");
    console.error("Or use `npm run auto` instead - it finds trending tokens by itself, no address needed.");
    process.exit(1);
  }

  const connection = createConnection();

  console.log(`Fetching last ${txSampleSize} signatures touching token ${tokenMint}...`);
  const results = await discoverForToken(connection, tokenMint, txSampleSize, topN, vetSampleSize);

  if (results.length === 0) {
    console.log("No signer wallets found touching this token in the sampled window. Try a bigger txSampleSize.");
    return;
  }

  console.log(`\nTop ${results.length} most active wallets on this token, vetted against their own history:\n`);
  for (const r of results) {
    console.log(
      `${r.addr}\n  seen ${r.mentionCount}x on this token | own history: ${r.swap} SWAP / ${r.total} sampled (${(r.swapRatio * 100).toFixed(1)}%) -> ${verdictFor(r.swapRatio, r.fixedStakeRatio, r.swap)}\n`
    );
  }

  const best = results.filter(isGoodCandidate).sort((a, b) => b.swapRatio - a.swapRatio);
  console.log("=== Recommended candidates (real swaps, not a fixed-stake sniping bot) ===");
  if (best.length === 0) {
    console.log("None of the top wallets on this token looked like clean discretionary traders (mostly bots/tips/noise).");
    console.log("Try a different, less bot-infested token, or increase txSampleSize/topN.");
  } else {
    best.forEach((r, i) => console.log(`${i + 1}. ${r.addr}  (${(r.swapRatio * 100).toFixed(1)}% real swaps)`));
    console.log('\nPlug the top address into the dashboard\'s "switch wallet" field, or set TARGET_WALLET in .env.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
