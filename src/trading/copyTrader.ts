import { config } from "../config";
import { logger } from "../logger";
import { SwapEvent } from "../types";
import { PositionStore } from "../state/positionStore";
import { eventLog } from "../state/eventLog";
import { Executor } from "./executor";

const LAMPORTS_PER_SOL = 1_000_000_000n;

function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));
}

function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

export class CopyTrader {
  constructor(private executor: Executor, private positions: PositionStore) {}

  async onSwap(event: SwapEvent): Promise<void> {
    const sourceSol = lamportsToSol(event.solAmountLamports);
    eventLog.add("swap_detected", `Target ${event.side} ${event.tokenMint} for ${sourceSol.toFixed(4)} SOL`, {
      signature: event.signature,
      side: event.side,
      tokenMint: event.tokenMint,
      sourceSol,
    });

    if (sourceSol < config.minSourceTradeSol) {
      const msg = `Ignoring ${event.side} of ${sourceSol.toFixed(9)} SOL (${event.solAmountLamports} lamports) on ${event.tokenMint} (below MIN_SOURCE_TRADE_SOL=${config.minSourceTradeSol})`;
      logger.info(msg);
      eventLog.add("skip", msg);
      return;
    }

    if (event.side === "buy") {
      await this.handleBuy(event);
    } else {
      await this.handleSell(event);
    }
  }

  private async handleBuy(event: SwapEvent): Promise<void> {
    if (event.targetSolBalanceBeforeLamports <= 0n) {
      logger.warn(`Skipping buy on ${event.signature}: target's pre-trade SOL balance is 0.`);
      return;
    }

    // Match the *percentage of balance* the target risked, scaled by our own balance and COPY_RATIO.
    const sourceRatio =
      Number(event.solAmountLamports) / Number(event.targetSolBalanceBeforeLamports);

    const ourSolBalance = await this.executor.getSolBalanceLamports();
    const spendableLamports = ourSolBalance - solToLamports(config.reserveSol);
    if (config.mode === "live" && spendableLamports <= 0n) {
      logger.warn("Skipping buy: no spendable SOL balance above RESERVE_SOL.");
      return;
    }

    // In dry-run without a funded wallet, size the simulated buy against a notional 1 SOL balance so
    // the ratio math is still exercised and logged meaningfully.
    const notionalBalanceLamports = config.mode === "live" ? ourSolBalance : solToLamports(1);
    const ourSolToSpend = sourceRatio * config.copyRatio * Number(notionalBalanceLamports);
    let ourLamportsToSpend = BigInt(Math.round(ourSolToSpend));

    const minLamports = solToLamports(config.minTradeSol);
    const maxLamports = solToLamports(config.maxTradeSol);
    if (ourLamportsToSpend < minLamports) ourLamportsToSpend = minLamports;
    if (ourLamportsToSpend > maxLamports) ourLamportsToSpend = maxLamports;
    if (config.mode === "live" && ourLamportsToSpend > spendableLamports) {
      ourLamportsToSpend = spendableLamports;
    }

    const ourSolToSpendLog = lamportsToSol(ourLamportsToSpend);
    logger.trade(
      `Target bought ${event.tokenMint} with ${lamportsToSol(event.solAmountLamports).toFixed(4)} SOL ` +
        `(${(sourceRatio * 100).toFixed(2)}% of its balance). ` +
        `Copying with ${ourSolToSpendLog.toFixed(4)} SOL.`
    );

    const result = await this.executor.buy(event.tokenMint, ourLamportsToSpend);
    const receivedRaw = BigInt(result.quote.outAmount);

    const existing = this.positions.get(event.tokenMint);
    const newAmountRaw = (existing ? BigInt(existing.ourAmountRaw) : 0n) + receivedRaw;

    this.positions.upsert({
      tokenMint: event.tokenMint,
      tokenDecimals: event.tokenDecimals,
      ourAmountRaw: newAmountRaw.toString(),
      openedAt: existing?.openedAt ?? new Date().toISOString(),
      entrySignature: event.signature,
    });

    eventLog.add(
      "buy",
      `${result.executed ? "Bought" : "[dry-run] Would buy"} ${event.tokenMint} with ${ourSolToSpendLog.toFixed(4)} SOL`,
      { tokenMint: event.tokenMint, solSpent: ourSolToSpendLog, receivedRaw: receivedRaw.toString(), signature: result.signature, executed: result.executed }
    );
  }

  private async handleSell(event: SwapEvent): Promise<void> {
    const position = this.positions.get(event.tokenMint);
    if (!position) {
      const msg = `Target sold ${event.tokenMint} but we have no copied position; ignoring.`;
      logger.info(msg);
      eventLog.add("skip", msg);
      return;
    }

    const targetBalanceBefore = event.targetTokenBalanceBeforeRaw;
    if (targetBalanceBefore <= 0n) {
      logger.warn(`Skipping sell on ${event.signature}: target's pre-trade token balance is 0.`);
      return;
    }

    // Proportion of their position they just closed; mirror the same proportion of ours.
    let proportion = Number(event.tokenAmountRaw) / Number(targetBalanceBefore);
    if (proportion > 1) proportion = 1;
    if (proportion <= 0) return;

    const ourAmountRaw = BigInt(position.ourAmountRaw);
    let amountToSell = BigInt(Math.round(Number(ourAmountRaw) * proportion));
    if (amountToSell > ourAmountRaw) amountToSell = ourAmountRaw;
    if (amountToSell <= 0n) return;

    logger.trade(
      `Target closed ${(proportion * 100).toFixed(2)}% of its ${event.tokenMint} position. ` +
        `Mirroring: selling ${amountToSell} raw units of ours.`
    );

    const result = await this.executor.sell(event.tokenMint, amountToSell);

    eventLog.add(
      "sell",
      `${result.executed ? "Sold" : "[dry-run] Would sell"} ${(proportion * 100).toFixed(2)}% of our ${event.tokenMint} position`,
      { tokenMint: event.tokenMint, proportion, amountToSell: amountToSell.toString(), signature: result.signature, executed: result.executed }
    );

    const remaining = ourAmountRaw - amountToSell;
    if (remaining <= 0n || proportion >= 0.999) {
      this.positions.remove(event.tokenMint);
      logger.trade(`Position closed for ${event.tokenMint}.`);
      eventLog.add("position_closed", `Position closed for ${event.tokenMint}`, { tokenMint: event.tokenMint });
    } else {
      this.positions.upsert({ ...position, ourAmountRaw: remaining.toString() });
    }
  }
}
