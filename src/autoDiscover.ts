import { createConnection } from "./solana/connection";
import { discoverForToken, isGoodCandidate, verdictFor, WalletCandidate } from "./discoverWallets";

interface DexScreenerBoostedToken {
  chainId?: string;
  tokenAddress?: string;
}

const DEXSCREENER_SOURCES = [
  "https://api.dexscreener.com/token-boosts/top/v1",
  "https://api.dexscreener.com/token-boosts/latest/v1",
];

/**
 * Pulls candidate "trending" token addresses from DexScreener's public API (documented, free, no
 * API key) instead of scraping gmgn.ai. This is a best-effort trending signal (boosted tokens),
 * not a perfect ranking - good enough as a starting point for finding active traders.
 */
async function fetchTrendingSolanaTokens(limit: number): Promise<string[]> {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const url of DEXSCREENER_SOURCES) {
    if (tokens.length >= limit) break;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  (${url} returned ${res.status}, trying next source)`);
        continue;
      }
      const data = (await res.json()) as DexScreenerBoostedToken[];
      for (const t of data) {
        if (t.chainId === "solana" && t.tokenAddress && !seen.has(t.tokenAddress)) {
          seen.add(t.tokenAddress);
          tokens.push(t.tokenAddress);
        }
      }
    } catch (err) {
      console.error(`  (${url} failed: ${(err as Error).message}, trying next source)`);
    }
  }

  return tokens.slice(0, limit);
}

async function main() {
  const tokenLimit = Number(process.argv[2]) || 5;
  const txSampleSize = Number(process.argv[3]) || 40;
  const topNPerToken = Number(process.argv[4]) || 3;
  const vetSampleSize = Number(process.argv[5]) || 12;

  console.log("Fetching trending Solana tokens from DexScreener's public API...");
  const tokens = await fetchTrendingSolanaTokens(tokenLimit);

  if (tokens.length === 0) {
    console.error("\nCouldn't get any trending Solana tokens from DexScreener right now.");
    console.error("Either their API shape changed or it's unreachable from here. Fall back to:");
    console.error("  npm run discover -- <token-mint>");
    console.error("with a contract address copied manually from gmgn.ai's Trending page.");
    process.exit(1);
  }
  console.log(`Got ${tokens.length} trending token(s):\n  ${tokens.join("\n  ")}\n`);

  const connection = createConnection();
  const all: WalletCandidate[] = [];

  for (const mint of tokens) {
    console.log(`--- Scanning active traders of ${mint} ---`);
    try {
      const results = await discoverForToken(connection, mint, txSampleSize, topNPerToken, vetSampleSize);
      if (results.length === 0) {
        console.log("  (no active signer wallets found in the sampled window)");
      }
      for (const r of results) {
        console.log(
          `  ${r.addr}  ${r.swap}/${r.total} swaps (${(r.swapRatio * 100).toFixed(1)}%) -> ${verdictFor(r.swapRatio, r.fixedStakeRatio, r.swap)}`
        );
        all.push(r);
      }
    } catch (err) {
      console.error(`  Failed to scan ${mint}: ${(err as Error).message}`);
    }
    console.log();
  }

  // Merge duplicates (a wallet active across several trending tokens is a good sign), keeping its
  // best-observed swap ratio and counting how many trending tokens it showed up as active on.
  const byAddr = new Map<string, WalletCandidate & { tokenCount: number }>();
  for (const r of all) {
    const existing = byAddr.get(r.addr);
    if (!existing) {
      byAddr.set(r.addr, { ...r, tokenCount: 1 });
    } else {
      byAddr.set(r.addr, {
        ...(r.swapRatio > existing.swapRatio ? r : existing),
        tokenCount: existing.tokenCount + 1,
      });
    }
  }

  const finalists = [...byAddr.values()].filter(isGoodCandidate).sort((a, b) => b.swapRatio - a.swapRatio);

  console.log("=== Final ranked candidates across all trending tokens ===");
  if (finalists.length === 0) {
    console.log("No clean candidates this round - trending tokens change fast, try again shortly,");
    console.log("or increase tokenLimit/txSampleSize for a wider sweep.");
  } else {
    finalists.forEach((r, i) => {
      console.log(
        `${i + 1}. ${r.addr}  -  ${(r.swapRatio * 100).toFixed(1)}% real swaps  (active on ${r.tokenCount} trending token(s))`
      );
    });
    console.log('\nPlug the #1 address into the dashboard\'s "switch wallet" field, or set TARGET_WALLET in .env.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
