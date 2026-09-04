import { config } from "../config";
import { logger } from "../logger";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  // Jupiter returns a lot more fields; we pass the object through untouched to /swap.
  [key: string]: unknown;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint
): Promise<JupiterQuote> {
  const url = new URL(`${config.jupiterApiUrl}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw.toString());
  url.searchParams.set("slippageBps", String(config.slippageBps));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Jupiter quote failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as JupiterQuote;
}

export async function getSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string
): Promise<string> {
  const res = await fetch(`${config.jupiterApiUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) {
    throw new Error(`Jupiter swap build failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { swapTransaction: string };
  return body.swapTransaction; // base64-encoded VersionedTransaction
}

export function logQuoteSummary(label: string, quote: JupiterQuote): void {
  logger.trade(
    `${label}: in=${quote.inAmount} (${quote.inputMint}) -> out=${quote.outAmount} (${quote.outputMint}), priceImpact=${quote.priceImpactPct}%`
  );
}
