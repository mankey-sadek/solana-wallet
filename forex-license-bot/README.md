# TimeGridEA - MT4 grid EA with offline license keys

An original MQL4 Expert Advisor built to match the feature set you described
(box/time grid entries on XAUUSD-style symbols, EMA trend filter, per-asset
lot sizes, recovery grid, basket + daily profit/loss management, news/ATR/
stochastic filters), plus an offline, account-bound activation-key system.

This is a fresh implementation, not a decompiled copy of any third-party EA.

## Layout

```
forex-license-bot/
  Experts/TimeGridEA.mq4   # the EA
  Include/Sha256.mqh       # SHA-256 / HMAC-SHA256 (pure MQL4, no external libs)
  Include/License.mqh      # license key parsing + validation
  tools/keygen.py          # generates/verifies license keys from your machine
```

## Installing in MetaTrader 4

1. Copy `Include/Sha256.mqh` and `Include/License.mqh` into
   `MQL4/Include/` in your MT4 data folder.
2. Copy `Experts/TimeGridEA.mq4` into `MQL4/Experts/`.
3. Open MetaEditor, open `TimeGridEA.mq4`, and compile (F7). Fix any
   MetaEditor build warnings for your MT4 build if it flags syntax
   differences (this was written for a modern MQL4 compiler, build 600+).
4. Attach the EA to a chart, allow live trading / AutoTrading.

## License key system

- Format: `ACCOUNT-YYYYMMDD-SIGNATURE`, e.g. `12345678-20261007-5E09162B28F482F2`.
- The EA reads `InpLicenseKey` and compares it against the terminal's own
  `AccountNumber()` and the compiled-in `InpLicenseSecret`. If the account,
  expiry, and HMAC-SHA256 signature don't all check out, the EA logs the
  reason and refuses to place any trades (it stays attached so you can see
  the error in the chart comment / Experts log).
- **Before compiling for real use**, change `InpLicenseSecret` in
  `TimeGridEA.mq4` to your own random secret string, and set the same value
  as `LICENSE_SECRET` in `tools/keygen.py`. Keep both private.

### Generating a key

```bash
python3 tools/keygen.py generate 12345678 --days 365
# -> 12345678-20271007-XXXXXXXXXXXXXXXX
```

Paste the output into the EA's `InpLicenseKey` input for that specific
MT4 account number.

### Verifying a key

```bash
python3 tools/keygen.py verify 12345678-20271007-XXXXXXXXXXXXXXXX
```

### Important limitation

This is an **offline** scheme: the secret is compiled into the `.ex4` file.
Anyone with a decompiler can potentially extract the secret and mint their
own keys - this stops casual copying between accounts, not a determined
attacker. If you need stronger protection (e.g. to sell this to other
people), the standard approaches are:
- A server-side check (EA calls `WebRequest` to your own license API on
  `OnInit`), or
- MetaTrader's built-in Product/Market protection when you publish through
  the MQL5 Market, which binds compiled `.ex5`/`.ex4` files to specific
  accounts using MetaQuotes' own infrastructure.

## Strategy inputs

All inputs mirror the settings you described:

| Setting | Input | Notes |
|---|---|---|
| Magic Number | `InpMagicNumber` | Used to isolate this EA's orders |
| Box Lookback / Max Height | `InpBoxLookback`, `InpBoxMaxHeightPoints` | 0 disables the ranging-market box check |
| Block Trades in Ranging Market | `InpBlockRangingMarket` | |
| Trading symbol | `InpTradeSymbol` | Empty = current chart symbol |
| EMA Trend Breaker | `InpEnableEMATrendBreaker`, `InpEMATimeframe`, `InpEMAPeriod` | Price vs EMA sets trade direction |
| Lot sizes | `InpGoldLot`, `InpForexLot`, `InpCryptoLot` | Selected by symbol name (`XAU`/`BTC`/else) |
| Recovery distance | `InpGoldDistPoints`, `InpForexDistPoints`, `InpCryptoDistPoints` | 0 disables the recovery grid for that asset |
| Grid Cooldown | `InpGridCooldownMin` | Minimum minutes between grid additions |
| Entry Analysis TF | `InpEntryTimeframe` | Used for ATR/stochastic/box calculations |
| Basket Target / Stop Loss | `InpBasketTarget`, `InpBasketStopLoss` | Closes all of this EA's open orders on this symbol |
| Daily Target / Stop Loss | `InpDailyTarget`, `InpDailyStopLoss` | Tracked against equity at day start; locks trading for the rest of the day once hit |
| Start Triggers | `InpStartTrigger` | `TRIGGER_MANUAL` disables auto entries entirely |
| Global EVRS Protection | `InpGlobalEVRSProtection` | "EVRS" isn't a known standard term and its original meaning is unconfirmed - implemented as a best-guess spread/ATR spike guard (`IsExtremeVolatility()`). Adjust or rename if you learn what it should actually check. |
| Global Stoch Protection | `InpGlobalStochProtection` | Stochastic overbought/oversold filter |
| News Filter / Auto-Close Before News | `InpNewsFilter`, `InpAutoCloseBeforeNews`, `InpNewsBufferMinutes`, `InpNewsFile` | Reads times from `MQL4/Files/NewsTimes.csv` (one `YYYY.MM.DD HH:MM` per line, broker/server time) - MT4 has no built-in calendar, so populate this file yourself (manually, or export from an economic calendar) |
| Trend Filter (H4) | `InpTrendFilterH4`, `InpTrendEMAPeriodH4` | Blocks entries against the H4 EMA trend |
| ATR Filter | `InpATRFilter`, `InpATRPeriod`, `InpATRMinPoints`, `InpATRMaxPoints` | Skips entries when volatility is too low or spiking |
| Daily Protection | `InpDailyProtection`, `InpDailyProtectionCloseMin`, `InpDailyProtectionOpenMin` | Blocks/closes trades around the daily rollover boundary |

## Before running live

- Backtest and forward-test on a demo account. A grid/recovery strategy can
  accumulate large drawdown during a sustained trend against it - the basket
  stop loss and daily stop loss are your main safety nets, size them
  carefully for your account.
- The entry logic here is intentionally simple (EMA-direction + filters) as
  a working starting point; tune `TryOpenInitialTrade()` /
  `ManageGrid()` in `TimeGridEA.mq4` to match your actual edge before
  trading real money.
