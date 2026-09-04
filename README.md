# Solana Copy-Trading Bot

Watches a target Solana wallet's swaps in real time and mirrors them from your own wallet at a
different (configurable) size, then mirrors position closes so you exit alongside the wallet you're
following.

Target wallet in this setup (from the gmgn.ai link): `Cw9YHB19L6hdiCBaF9sXPAQNp9Wr1P9n5MrarZsZhYxC`

## How it works

1. **Monitor** (`src/solana/walletMonitor.ts`): subscribes to the target wallet's transaction logs
   directly over a Solana RPC websocket (`logsSubscribe`) — no scraping of gmgn.ai, all data comes
   straight from the chain.
2. **Parse** (`src/solana/txParser.ts`): for each confirmed transaction, diffs the target wallet's
   pre/post SOL and SPL-token balances to detect a plain SOL↔token swap (buy or sell). Token↔token or
   multi-mint transactions are skipped for safety rather than guessed at.
3. **Size the trade** (`src/trading/copyTrader.ts`): computes what *percentage of its own SOL balance*
   the target spent on the buy, then applies that same percentage (scaled by `COPY_RATIO`) to your own
   balance. Example: target spends 10% of its SOL, `COPY_RATIO=0.1` → you spend 1% of yours. Guarded by
   `MIN_TRADE_SOL` / `MAX_TRADE_SOL` / `RESERVE_SOL`.
4. **Execute** (`src/trading/executor.ts`): gets a quote and swap transaction from the Jupiter
   aggregator API and, in `live` mode, signs and sends it with your wallet. In `dry-run` mode it only
   fetches the quote and logs what *would* happen.
5. **Close together**: when the target sells some or all of a token position, the bot computes what
   proportion of *its* holdings that represents and sells the same proportion of your mirrored position
   — so a full exit by the target fully closes your position too.

Open positions are persisted to `data/positions.json` so the bot survives restarts.

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
- This only copies simple SOL↔token swaps. Token↔token swaps, multi-hop routes touching several mints,
  and non-swap transactions (transfers, staking, NFTs, etc.) are intentionally ignored.
- The bot uses on-chain data and the public Jupiter aggregator API only. It does not call or depend on
  gmgn.ai in any way — that link was just the source of the target wallet address.
- Copy trading is inherently risky: you'll always trail the source wallet by at least one confirmation,
  slippage and liquidity can differ between your trade size and theirs, and nothing here is financial
  advice.
