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

/**
 * One asset (native SOL or an SPL token) whose balance changed for the target wallet in a
 * transaction. Native SOL is represented as a leg with mint = SOL_MINT so every trade - SOL<->token,
 * token<->token, or a transaction touching several mints at once - is just a list of legs with no
 * special-casing needed for "the" traded pair.
 */
export interface MintLeg {
  mint: string;
  decimals: number;
  beforeRaw: bigint;
  afterRaw: bigint;
  /** Signed: afterRaw - beforeRaw. Negative = sold/spent, positive = bought/received. */
  deltaRaw: bigint;
}

/** A detected transaction on the target wallet with at least one non-zero balance change. */
export interface TradeEvent {
  signature: string;
  legs: MintLeg[];
}

export interface OpenPosition {
  tokenMint: string;
  tokenDecimals: number;
  /** Our current raw token balance attributed to this copied position. */
  ourAmountRaw: string;
  openedAt: string;
  entrySignature: string;
}
