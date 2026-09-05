# Solana Copy-Trading Bot

Watches a target Solana wallet's swaps in real time and mirrors them from your own wallet at a
different (configurable) size, then mirrors position closes so you exit alongside the wallet you're
following.

Target wallet in this setup (from the gmgn.ai link): `Cw9YHB19L6hdiCBaF9sXPAQNp9Wr1P9n5MrarZsZhYxC`

## Scanning a wallet before you commit to it

Not every "top trader" wallet is actually worth copying — some are MEV/sniper bots whose own balance
barely moves, others rack up thousands of unrelated "mentions" (e.g. a pump.fun referral link) that
would burn through your RPC provider's free quota for nothing. Before pointing the live bot at a
wallet, check its signal quality cheaply (one RPC call per recent signature, no streaming):

```bash
npm run scan -- <wallet-address> [limit]
# e.g.
npm run scan -- Cw9YHB19L6hdiCBaF9sXPAQNp9Wr1P9n5MrarZsZhYxC 50
```

It fetches the wallet's last `limit` transactions (default 40) and classifies each one:

- `SWAP` — a real two-sided trade (something sold, something bought). This is what gets copied.
- `TIP_OR_FEE` — SOL left the wallet with nothing coming back (MEV/Jito tips, plain fees). Never copied.
- `RECEIVED_ONLY` — tokens/SOL arrived for free (airdrops, referral seeds, dev allocations). Never copied.
- `NO_CHANGE` — the transaction just mentioned this wallet without affecting its balance at all.
- `FAILED` / `UNAVAILABLE` — self-explanatory.

It ends with a summary and a verdict (mostly noise / usable / clean signal) based on what fraction of
transactions were real swaps. A wallet worth copying should show up mostly `SWAP` at a sane frequency
(e.g. tens per day, not thousands) — that's also roughly how many `getParsedTransaction` calls per day
the live bot will cost you against your RPC provider's quota if you switch to it.

## How it works

1. **Monitor** (`src/solana/walletMonitor.ts`): subscribes to the target wallet's transaction logs
   directly over a Solana RPC websocket (`logsSubscribe`) — no scraping of gmgn.ai, all data comes
   straight from the chain. The subscription uses `processed` commitment (fires as soon as a leader
   accepts the tx) instead of `confirmed`, trading a small amount of certainty for lower detection
   latency; `txParser` retries fetching the full transaction at `confirmed` commitment for a couple
   seconds to cover the race between the two commitment levels. Jupiter's automatic priority fee
   (`prioritizationFeeLamports: "auto"`) is enabled on our own swaps so they land quickly too.
2. **Parse** (`src/solana/txParser.ts`): for each confirmed transaction, diffs the target wallet's
   pre/post SOL and SPL-token balances into a list of "legs" — every asset (native SOL or an SPL token)
   whose balance changed, negative for what it sold/spent and positive for what it received. A plain
   SOL↔token swap is just a 2-leg trade; nothing is skipped for touching more than one mint.
3. **Mirror the trade** (`src/trading/copyTrader.ts`): every trade, however many legs it has, is
   copied the same way:
   - For each **sold** leg: if it's SOL, contribute a share of your own SOL balance sized by the same
     *percentage of balance* the target risked (scaled by `COPY_RATIO` — target spends 10% of its SOL,
     `COPY_RATIO=0.1` → you spend 1% of yours). If it's a token you hold a copied position in, sell the
     same proportion of your holdings for SOL. Either way the SOL raised becomes a shared buy budget.
     A token leg you hold no position for contributes nothing (you can't sell what you never bought).
   - For each **bought** leg (other than SOL itself): split the buy budget evenly across them and buy
     each with Jupiter. If nothing was raised (e.g. a token↔token swap in an asset you didn't hold), it
     falls back to a nominal `MIN_TRADE_SOL` buy so the trade still gets mirrored instead of skipped.
   - A pure exit to SOL (nothing bought but SOL) needs no buy step — the position is simply closed.
   All caps still apply: each buy is clamped between `MIN_TRADE_SOL` and `MAX_TRADE_SOL`, and `RESERVE_SOL`
   is never touched in `live` mode.
4. **Execute** (`src/trading/executor.ts`): gets a quote and swap transaction from the Jupiter
   aggregator API and, in `live` mode, signs and sends it with your wallet. In `dry-run` mode it only
   fetches the quote and logs what *would* happen.
5. **Close together**: a sold leg you hold a position in is always sold in the same proportion the
   target sold it in, so a full exit by the target fully closes your matching position too.

Open positions are persisted to `data/positions.json` so the bot survives restarts.

## Web dashboard

While the bot is running (`npm run dev` / `npm start`) it also serves a live monitoring dashboard at
`http://localhost:3001` (configurable via `DASHBOARD_PORT`). It shows:

- current mode, target wallet, your wallet's SOL balance (in `live` mode), and sizing config
- open positions (`data/positions.json`) in a table
- a live feed of detected swaps, copy buys/sells, skips, and errors (polls every 3s)

Open the URL in any browser on the same machine while the bot is running.

**Switching the target wallet**: the dashboard has a field to switch which wallet is being copied,
without restarting the bot. It validates the address, unsubscribes from the old wallet, subscribes to
the new one, and persists the choice to `data/runtime-config.json` (survives restarts; takes priority
over `TARGET_WALLET` in `.env` once set). Any position opened while copying the previous wallet stays
tracked as-is — switching doesn't auto-close it, since that position was mirroring trades of a wallet
the bot is no longer watching. Close it manually (e.g. sell via a wallet app) if you don't want to hold
it, or switch back to the original wallet so its sells continue to be mirrored.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `TARGET_WALLET` — already set to the address from your gmgn.ai link.
- `RPC_HTTP_URL` / `RPC_WS_URL` — **use a real RPC provider** (Helius, QuickNode, Triton, etc.).
  Public endpoints reject or throttle websocket subscriptions, which is required here.
- `MODE` — leave as `dry-run` until you've watched it log simulated trades and you're confident in the
  behavior.
- `MY_WALLET_PRIVATE_KEY` — only needed for `MODE=live`. Base58 secret key. **Never commit this file**
  (it's already gitignored). Use a dedicated wallet funded only with what you're willing to risk.
- `COPY_RATIO`, `MIN_TRADE_SOL`, `MAX_TRADE_SOL`, `RESERVE_SOL`, `MIN_SOURCE_TRADE_SOL`,
  `SLIPPAGE_BPS` — sizing and safety knobs, see comments in `.env.example`.

Run it:

```bash
npm run dev        # ts-node, good for development
# or
npm run build && npm start
```

## Safety notes

- **Start in `dry-run`.** Watch the logs for a while and sanity-check the sizing math before switching
  to `MODE=live`.
- Use a **dedicated wallet** for the bot, funded only with risk capital — never your main wallet's key.
- Every trade with at least one sold leg and one bought leg is mirrored — SOL↔token, token↔token, and
  transactions touching several mints at once. A one-sided balance change with nothing on the other
  side (an airdrop, a fee-only transaction, rent reclaim) has no "trade" to mirror and is skipped. When
  a bought leg has no sizing basis (you held none of what was sold), it falls back to a nominal
  `MIN_TRADE_SOL` buy rather than being skipped, so you still end up holding what the target holds —
  at reduced sizing precision for that leg.
- The bot uses on-chain data and the public Jupiter aggregator API only. It does not call or depend on
  gmgn.ai in any way — that link was just the source of the target wallet address.
- Copy trading is inherently risky: you'll always trail the source wallet by at least one confirmation,
  slippage and liquidity can differ between your trade size and theirs, and nothing here is financial
  advice.
