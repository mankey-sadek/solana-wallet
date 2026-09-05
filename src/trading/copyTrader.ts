import { config } from "../config";
import { logger } from "../logger";
import { MintLeg, TradeEvent, SOL_MINT } from "../types";
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

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Mirrors *every* trade the target wallet makes, not just plain SOL<->token swaps: a transaction is
 * a list of "legs" (native SOL plus any SPL tokens whose balance changed). Legs the target sold fund
 * a SOL budget (by selling our matching proportion of that asset, or by scaling our own SOL balance
 * when the sold leg is SOL itself); that budget is then split evenly across whatever they bought.
 * This means token<->token swaps and multi-mint transactions get copied instead of skipped.
 */
export class CopyTrader {
  constructor(private executor: Executor, private positions: PositionStore) {}

  async onTrade(trade: TradeEvent): Promise<void> {
    const soldLegs = trade.legs.filter((l) => l.deltaRaw < 0n);
    const boughtLegs = trade.legs.filter((l) => l.deltaRaw > 0n);

    if (soldLegs.length === 0 || boughtLegs.length === 0) {
      // A one-sided balance change (e.g. an airdrop, a fee, rent reclaim) - nothing to mirror as a trade.
      return;
    }

    const summary = trade.legs.map((l) => `${l.deltaRaw > 0n ? "+" : ""}${l.deltaRaw} ${short(l.mint)}`).join(", ");
    eventLog.add("swap_detected", `Target trade ${trade.signature.slice(0, 8)}...: ${summary}`, {
      signature: trade.signature,
      legs: trade.legs.map((l) => ({ mint: l.mint, deltaRaw: l.deltaRaw.toString() })),
    });

    // A trade whose only sold leg is a dust amount of SOL isn't worth mirroring at all.
    if (soldLegs.length === 1 && soldLegs[0].mint === SOL_MINT) {
      const sourceSol = lamportsToSol(-soldLegs[0].deltaRaw);
      if (sourceSol < config.minSourceTradeSol) {
        const msg = `Ignoring trade ${trade.signature}: only SOL leg is ${sourceSol.toFixed(9)} SOL, below MIN_SOURCE_TRADE_SOL=${config.minSourceTradeSol}`;
        logger.info(msg);
        eventLog.add("skip", msg);
        return;
      }
    }

    let budgetLamports = 0n;
    for (const leg of soldLegs) {
      try {
        budgetLamports += await this.raiseBudgetFromSoldLeg(leg);
      } catch (err) {
        logger.error(`Failed handling sold leg ${leg.mint} on tx ${trade.signature}:`, err);
        eventLog.add("error", `Failed to mirror sell of ${short(leg.mint)}: ${(err as Error).message}`, {
          signature: trade.signature,
          mint: leg.mint,
        });
      }
    }

    const tokenBuyLegs = boughtLegs.filter((l) => l.mint !== SOL_MINT);
    if (tokenBuyLegs.length === 0) {
      // Everything they bought was SOL itself - i.e. a plain sell/exit. Nothing further to buy;
      // any SOL we freed above just stays in our wallet.
      return;
    }

    if (budgetLamports <= 0n) {
      // No basis to size the buy at all (we held none of what they sold, and they spent no SOL of
      // their own, or it was below the dust threshold). Fall back to a nominal minimum buy so we
      // still end up holding what they hold, rather than skipping the trade entirely.
      budgetLamports = solToLamports(config.minTradeSol);
      logger.info(`No sizing basis for tx ${trade.signature}; falling back to MIN_TRADE_SOL nominal buy.`);
    }

    if (config.mode === "live") {
      const ourSolBalance = await this.executor.getSolBalanceLamports();
      const spendable = ourSolBalance - solToLamports(config.reserveSol);
      if (spendable <= 0n) {
        logger.warn("Skipping buy legs: no spendable SOL balance above RESERVE_SOL.");
        eventLog.add("skip", "Skipping buy legs: no spendable SOL balance above RESERVE_SOL.");
        return;
      }
      if (budgetLamports > spendable) budgetLamports = spendable;
    }

    const perLegLamports = budgetLamports / BigInt(tokenBuyLegs.length);
    const minLamports = solToLamports(config.minTradeSol);
    const maxLamports = solToLamports(config.maxTradeSol);

    for (const leg of tokenBuyLegs) {
      const spendLamports = clamp(perLegLamports, minLamports, maxLamports);
      try {
        await this.buyLeg(leg, spendLamports, trade.signature);
      } catch (err) {
        logger.error(`Failed to buy leg ${leg.mint} on tx ${trade.signature}:`, err);
        eventLog.add("error", `Failed to mirror buy of ${short(leg.mint)}: ${(err as Error).message}`, {
          signature: trade.signature,
          mint: leg.mint,
        });
      }
    }
  }

  /** Sells our matching share of a leg the target sold, returning freed SOL (in lamports) for the budget. */
  private async raiseBudgetFromSoldLeg(leg: MintLeg): Promise<bigint> {
    const soldRaw = -leg.deltaRaw;

    if (leg.mint === SOL_MINT) {
      if (leg.beforeRaw <= 0n) return 0n;
      // Match the *percentage of balance* the target risked, scaled by our own balance and COPY_RATIO.
      const sourceRatio = Number(soldRaw) / Number(leg.beforeRaw);
      const ourSolBalance = await this.executor.getSolBalanceLamports();
      // In dry-run without a funded wallet, size against a notional 1 SOL balance so the ratio math
      // is still exercised and logged meaningfully.
      const notionalBalanceLamports = config.mode === "live" ? ourSolBalance : solToLamports(1);
      const contribution = BigInt(Math.round(sourceRatio * config.copyRatio * Number(notionalBalanceLamports)));
      logger.trade(
        `Target spent ${lamportsToSol(soldRaw).toFixed(4)} SOL (${(sourceRatio * 100).toFixed(2)}% of its balance) -> contributing ${lamportsToSol(contribution).toFixed(4)} SOL to our buy budget.`
      );
      return clamp(contribution, 0n, solToLamports(config.maxTradeSol));
    }

    const position = this.positions.get(leg.mint);
    if (!position) {
      const msg = `Target sold ${short(leg.mint)} but we hold no copied position for it; contributes nothing to the buy budget.`;
      logger.info(msg);
      eventLog.add("skip", msg, { mint: leg.mint });
      return 0n;
    }
    if (leg.beforeRaw <= 0n) return 0n;

    let proportion = Number(soldRaw) / Number(leg.beforeRaw);
    proportion = Math.min(Math.max(proportion, 0), 1);
    if (proportion <= 0) return 0n;

    const ourAmountRaw = BigInt(position.ourAmountRaw);
    let sellAmount = BigInt(Math.round(Number(ourAmountRaw) * proportion));
    if (sellAmount > ourAmountRaw) sellAmount = ourAmountRaw;
    if (sellAmount <= 0n) return 0n;

    logger.trade(
      `Target sold ${(proportion * 100).toFixed(2)}% of its ${short(leg.mint)} position. Mirroring: selling ${sellAmount} raw units of ours.`
    );
    const result = await this.executor.sell(leg.mint, sellAmount);
    const freedLamports = BigInt(result.quote.outAmount);

    eventLog.add(
      "sell",
      `${result.executed ? "Sold" : "[dry-run] Would sell"} ${(proportion * 100).toFixed(2)}% of our ${short(leg.mint)} position`,
      { tokenMint: leg.mint, proportion, amountToSell: sellAmount.toString(), signature: result.signature, executed: result.executed }
    );

    const remaining = ourAmountRaw - sellAmount;
    if (remaining <= 0n || proportion >= 0.999) {
      this.positions.remove(leg.mint);
      eventLog.add("position_closed", `Position closed for ${short(leg.mint)}`, { tokenMint: leg.mint });
    } else {
      this.positions.upsert({ ...position, ourAmountRaw: remaining.toString() });
    }

    return freedLamports;
  }

  private async buyLeg(leg: MintLeg, spendLamports: bigint, signature: string): Promise<void> {
    if (spendLamports <= 0n) return;

    const result = await this.executor.buy(leg.mint, spendLamports);
    const receivedRaw = BigInt(result.quote.outAmount);

    const existing = this.positions.get(leg.mint);
    const newAmountRaw = (existing ? BigInt(existing.ourAmountRaw) : 0n) + receivedRaw;

    this.positions.upsert({
      tokenMint: leg.mint,
      tokenDecimals: leg.decimals,
      ourAmountRaw: newAmountRaw.toString(),
      openedAt: existing?.openedAt ?? new Date().toISOString(),
      entrySignature: signature,
    });

    eventLog.add(
      "buy",
      `${result.executed ? "Bought" : "[dry-run] Would buy"} ${short(leg.mint)} with ${lamportsToSol(spendLamports).toFixed(4)} SOL`,
      { tokenMint: leg.mint, solSpent: lamportsToSol(spendLamports), receivedRaw: receivedRaw.toString(), signature: result.signature, executed: result.executed }
    );
  }
}

function short(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;
}
