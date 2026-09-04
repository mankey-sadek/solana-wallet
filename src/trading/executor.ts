import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config";
import { logger } from "../logger";
import { getQuote, getSwapTransaction, logQuoteSummary, JupiterQuote } from "./jupiter";
import { SOL_MINT } from "../types";

export interface SwapResult {
  quote: JupiterQuote;
  executed: boolean;
  signature?: string;
}

export class Executor {
  private keypair: Keypair | undefined;

  constructor(private connection: Connection) {
    if (config.mode === "live") {
      if (!config.myWalletPrivateKey) {
        throw new Error("MY_WALLET_PRIVATE_KEY is required in live mode");
      }
      this.keypair = Keypair.fromSecretKey(bs58.decode(config.myWalletPrivateKey));
      logger.info(`Live mode: trading from wallet ${this.keypair.publicKey.toBase58()}`);
    } else {
      logger.info("Dry-run mode: no real transactions will be sent.");
    }
  }

  get publicKeyBase58(): string {
    if (this.keypair) return this.keypair.publicKey.toBase58();
    // Dry-run with no wallet configured: quotes still work without a real public key,
    // but a placeholder is required by the Jupiter API shape. Use system program as filler.
    return "11111111111111111111111111111111";
  }

  async getSolBalanceLamports(): Promise<bigint> {
    if (!this.keypair) return 0n;
    const bal = await this.connection.getBalance(this.keypair.publicKey, "confirmed");
    return BigInt(bal);
  }

  private async run(
    label: string,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint
  ): Promise<SwapResult> {
    const quote = await getQuote(inputMint, outputMint, amountRaw);
    logQuoteSummary(label, quote);

    if (config.mode === "dry-run" || !this.keypair) {
      logger.trade(`[DRY-RUN] Would swap ${amountRaw} raw units ${inputMint} -> ${outputMint}`);
      return { quote, executed: false };
    }

    const swapTxB64 = await getSwapTransaction(quote, this.keypair.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
    tx.sign([this.keypair]);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    logger.trade(`[LIVE] Sent swap tx: ${signature}`);

    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const confirmation = await this.connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed"
    );
    if (confirmation.value.err) {
      throw new Error(`Swap tx ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    logger.trade(`[LIVE] Swap confirmed: ${signature}`);

    return { quote, executed: true, signature };
  }

  /** Buy `tokenMint` by spending `solLamports` of native SOL. Returns the (estimated) token amount received. */
  async buy(tokenMint: string, solLamports: bigint): Promise<SwapResult> {
    return this.run(`BUY ${tokenMint}`, SOL_MINT, tokenMint, solLamports);
  }

  /** Sell `amountRaw` of `tokenMint` for native SOL. */
  async sell(tokenMint: string, amountRaw: bigint): Promise<SwapResult> {
    return this.run(`SELL ${tokenMint}`, tokenMint, SOL_MINT, amountRaw);
  }
}
