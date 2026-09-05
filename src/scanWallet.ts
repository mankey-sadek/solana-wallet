import { PublicKey } from "@solana/web3.js";
import { createConnection } from "./solana/connection";
import { extractLegs } from "./solana/txParser";
import { verdictFor, bucketLamports } from "./discoverWallets";
import { SOL_MINT } from "./types";

type Category = "SWAP" | "TIP_OR_FEE" | "RECEIVED_ONLY" | "NO_CHANGE" | "FAILED" | "UNAVAILABLE";

function short(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;
}

function legsSummary(legs: import("./types").MintLeg[]): string {
  return legs.map((l) => `${l.deltaRaw > 0n ? "+" : ""}${l.deltaRaw} ${short(l.mint)}`).join(", ");
}

async function main() {
  const address = process.argv[2];
  const limit = Number(process.argv[3]) || 40;

  if (!address) {
    console.error("Usage: npm run scan -- <wallet-address> [limit]");
    console.error("Example: npm run scan -- Cw9YHB19L6hdiCBaF9sXPAQNp9Wr1P9n5MrarZsZhYxC 50");
    process.exit(1);
  }

  const connection = createConnection();
  const pubkey = new PublicKey(address);

  console.log(`Fetching last ${limit} signatures for ${address}...`);
  const sigInfos = await connection.getSignaturesForAddress(pubkey, { limit });
  console.log(`Got ${sigInfos.length} signatures. Analyzing (this costs one RPC call per signature)...\n`);

  const counts: Record<Category, number> = {
    SWAP: 0,
    TIP_OR_FEE: 0,
    RECEIVED_ONLY: 0,
    NO_CHANGE: 0,
    FAILED: 0,
    UNAVAILABLE: 0,
  };
  const solAmountCounts = new Map<string, number>();

  for (const info of sigInfos) {
    const when = info.blockTime ? new Date(info.blockTime * 1000).toLocaleString() : "?";
    const sigShort = `${info.signature.slice(0, 10)}...`;

    if (info.err) {
      counts.FAILED++;
      console.log(`[${"FAILED".padEnd(13)}] ${when}  ${sigShort}  tx failed on-chain`);
      continue;
    }

    const tx = await connection.getParsedTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) {
      counts.UNAVAILABLE++;
      console.log(`[${"UNAVAILABLE".padEnd(13)}] ${when}  ${sigShort}  tx not returned by RPC`);
      continue;
    }

    const legs = extractLegs(tx, address);
    if (legs === null || legs.length === 0) {
      counts.NO_CHANGE++;
      console.log(`[${"NO_CHANGE".padEnd(13)}] ${when}  ${sigShort}  no net balance change for this wallet`);
      continue;
    }

    const sold = legs.filter((l) => l.deltaRaw < 0n);
    const bought = legs.filter((l) => l.deltaRaw > 0n);

    if (sold.length > 0 && bought.length > 0) {
      counts.SWAP++;
      const solLeg = legs.find((l) => l.mint === SOL_MINT);
      if (solLeg) {
        const bucket = bucketLamports(solLeg.deltaRaw).toString();
        solAmountCounts.set(bucket, (solAmountCounts.get(bucket) ?? 0) + 1);
      }
      console.log(`[${"SWAP".padEnd(13)}] ${when}  ${sigShort}  ${legsSummary(legs)}`);
    } else if (sold.length === 1 && sold[0].mint === SOL_MINT && bought.length === 0) {
      counts.TIP_OR_FEE++;
      console.log(`[${"TIP_OR_FEE".padEnd(13)}] ${when}  ${sigShort}  ${legsSummary(legs)}`);
    } else {
      counts.RECEIVED_ONLY++;
      console.log(`[${"RECEIVED_ONLY".padEnd(13)}] ${when}  ${sigShort}  ${legsSummary(legs)} (free/airdrop-like, no cost)`);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Total signatures analyzed: ${sigInfos.length}`);
  console.log(`  SWAP (real two-sided trades): ${counts.SWAP}`);
  console.log(`  TIP_OR_FEE (SOL out, nothing in - MEV tips, fees): ${counts.TIP_OR_FEE}`);
  console.log(`  RECEIVED_ONLY (free/airdrop, no cost): ${counts.RECEIVED_ONLY}`);
  console.log(`  NO_CHANGE (mentioned wallet but didn't affect it): ${counts.NO_CHANGE}`);
  console.log(`  FAILED: ${counts.FAILED}`);
  console.log(`  UNAVAILABLE: ${counts.UNAVAILABLE}`);

  const oldest = sigInfos[sigInfos.length - 1]?.blockTime;
  const newest = sigInfos[0]?.blockTime;
  if (oldest && newest && newest > oldest) {
    const spanHours = (newest - oldest) / 3600;
    const swapsPerDay = counts.SWAP / (spanHours / 24);
    console.log(`\nTime span covered: ~${spanHours.toFixed(1)} hours`);
    console.log(`Estimated real-trade rate: ~${swapsPerDay.toFixed(1)} swaps/day`);
  }

  const swapRatio = sigInfos.length > 0 ? counts.SWAP / sigInfos.length : 0;
  const maxSolAmountCount = Math.max(0, ...solAmountCounts.values());
  const fixedStakeRatio = counts.SWAP > 0 ? maxSolAmountCount / counts.SWAP : 0;
  console.log(`\nFixed-stake check: ${(fixedStakeRatio * 100).toFixed(0)}% of its swaps cluster around the same ~0.01 SOL-rounded stake size.`);
  console.log(`Signal quality: ${(swapRatio * 100).toFixed(1)}% of fetched transactions were real swaps.`);
  console.log(`=> ${verdictFor(swapRatio, fixedStakeRatio, counts.SWAP)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
