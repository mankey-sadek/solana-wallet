import { Connection, PublicKey } from "@solana/web3.js";
import { createConnection } from "./solana/connection";
import { extractLegs } from "./solana/txParser";
import { SOL_MINT } from "./types";

interface WalletStats {
  total: number;
  swap: number;
  tip: number;
  received: number;
  noChange: number;
  failed: number;
  unavailable: number;
  swapRatio: number;
}

async function classifyWallet(connection: Connection, address: string, sampleLimit: number): Promise<WalletStats> {
  const pubkey = new PublicKey(address);
  const sigInfos = await connection.getSignaturesForAddress(pubkey, { limit: sampleLimit });

  let swap = 0;
  let tip = 0;
  let received = 0;
  let noChange = 0;
  let failed = 0;
  let unavailable = 0;

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
    const sold = legs.filter((l) => l.deltaRaw < 0n);
    const bought = legs.filter((l) => l.deltaRaw > 0n);
    if (sold.length > 0 && bought.length > 0) {
      swap++;
    } else if (sold.length === 1 && sold[0].mint === SOL_MINT && bought.length === 0) {
      tip++;
    } else {
      received++;
    }
  }

  const total = sigInfos.length;
  return { total, swap, tip, received, noChange, failed, unavailable, swapRatio: total > 0 ? swap / total : 0 };
}

async function main() {
  const tokenMint = process.argv[2];
  const txSampleSize = Number(process.argv[3]) || 60;
  const topN = Number(process.argv[4]) || 5;
  const vetSampleSize = Number(process.argv[5]) || 15;

  if (!tokenMint) {
    console.error("Usage: npm run discover -- <token-mint> [txSampleSize=60] [topN=5] [vetSampleSize=15]");
    console.error("Give it any token's contract address (from gmgn's Trending page, for example).");
    console.error(
      `Cost: roughly ${60} + ${5 * 15} RPC calls with defaults - tune the numbers down on a tight free-tier quota.`
    );
    process.exit(1);
  }

  const connection = createConnection();
  const mintPubkey = new PublicKey(tokenMint);

  console.log(`Fetching last ${txSampleSize} signatures touching token ${tokenMint}...`);
  const sigInfos = await connection.getSignaturesForAddress(mintPubkey, { limit: txSampleSize });
  console.log(`Got ${sigInfos.length}. Finding the most active signer wallets (one RPC call per signature)...\n`);

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
  if (ranked.length === 0) {
    console.log("No signer wallets found touching this token in the sampled window. Try a bigger txSampleSize.");
    return;
  }

  console.log(`Top ${ranked.length} most active wallets on this token:`);
  ranked.forEach(([addr, count], i) => console.log(`  ${i + 1}. ${addr} - appeared in ${count} of the sampled tx(s)`));

  console.log(`\nVetting each candidate's own trade history (last ${vetSampleSize} of their own signatures)...\n`);

  const results: (WalletStats & { addr: string; mentionCount: number })[] = [];
  for (const [addr, mentionCount] of ranked) {
    const stats = await classifyWallet(connection, addr, vetSampleSize);
    results.push({ addr, mentionCount, ...stats });
    const verdict = stats.swapRatio < 0.05 ? "mostly noise" : stats.swapRatio < 0.3 ? "usable" : "clean signal";
    console.log(
      `${addr}\n  seen ${mentionCount}x on this token | own history: ${stats.swap} SWAP / ${stats.total} sampled (${(stats.swapRatio * 100).toFixed(1)}%) -> ${verdict}\n`
    );
  }

  const best = results.filter((r) => r.swapRatio >= 0.1).sort((a, b) => b.swapRatio - a.swapRatio);
  console.log("=== Recommended candidates (>=10% of sampled tx were real swaps) ===");
  if (best.length === 0) {
    console.log("None of the top wallets on this token looked like clean traders (mostly bots/tips/noise).");
    console.log("Try a different, less bot-infested token, or increase txSampleSize/topN.");
  } else {
    best.forEach((r, i) => console.log(`${i + 1}. ${r.addr}  (${(r.swapRatio * 100).toFixed(1)}% real swaps)`));
    console.log("\nPlug the top address into the dashboard's \"switch wallet\" field, or set TARGET_WALLET in .env.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
