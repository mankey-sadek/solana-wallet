export type Mode = "dry-run" | "live";

export interface AppConfig {
  targetWallet: string;
  rpcHttpUrl: string;
  rpcWsUrl: string;
  mode: Mode;
  myWalletPrivateKey: string | undefined;
  copyRatio: number;
  minTradeSol: number;
  maxTradeSol: number;
  reserveSol: number;
  minSourceTradeSol: number;
  slippageBps: number;
  jupiterApiUrl: string;
  dashboardPort: number;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** A buy or sell detected on the target wallet, normalized to SOL <-> token terms. */
export interface SwapEvent {
  signature: string;
  side: "buy" | "sell";
  tokenMint: string;
  tokenDecimals: number;
  /** Raw token amount (smallest unit) that changed hands on the target wallet. */
  tokenAmountRaw: bigint;
  /** SOL involved in the trade, in lamports (spent on a buy, received on a sell). */
  solAmountLamports: bigint;
  /** Target wallet's SOL balance immediately before this trade, in lamports. */
  targetSolBalanceBeforeLamports: bigint;
  /** Target wallet's balance of tokenMint before/after this trade, raw units. */
  targetTokenBalanceBeforeRaw: bigint;
  targetTokenBalanceAfterRaw: bigint;
}

export interface OpenPosition {
  tokenMint: string;
  tokenDecimals: number;
  /** Our current raw token balance attributed to this copied position. */
  ourAmountRaw: string;
  openedAt: string;
  entrySignature: string;
}
