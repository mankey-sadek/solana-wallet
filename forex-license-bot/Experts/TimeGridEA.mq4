//+------------------------------------------------------------------+
//|                                                  TimeGridEA.mq4  |
//| Time/box-breakout grid EA with basket & daily risk management,   |
//| trend/ATR/stochastic/news filters, and an offline account-bound   |
//| license key.                                                       |
//|                                                                    |
//| This is an original implementation built from a feature/settings  |
//| description, not a decompiled copy of any third-party EA.         |
//| Test thoroughly on a demo account before running it live -- a     |
//| grid/recovery strategy can accumulate large drawdown in a strong   |
//| trend.                                                             |
//+------------------------------------------------------------------+
#property strict
#property copyright "Your Name"
#property version   "1.00"
#property description "TIME GRID EA - box breakout grid with basket/daily management and license check"

#include <Sha256.mqh>
#include <License.mqh>

//--------------------------- License ---------------------------------
input string InpLicenseKey    = "";                          // Activation Key (ACCOUNT-YYYYMMDD-SIGNATURE)
input string InpLicenseSecret = "REPLACE_WITH_YOUR_SECRET";  // Must match tools/keygen.py LICENSE_SECRET

//--------------------------- Core / Box -------------------------------
input int    InpMagicNumber        = 123456;   // Magic Number
input int    InpBoxLookback         = 0;        // Box Lookback (Candles)
input int    InpBoxMaxHeightPoints  = 0;        // Box Max Height (Points)
input bool   InpBlockRangingMarket  = false;    // Block Trades in Ranging Market
input string InpTradeSymbol         = "";       // Symbol to trade ("" = current chart symbol)

//--------------------------- Trend filter -----------------------------
input bool            InpEnableEMATrendBreaker = true;        // Enable EMA Trend Breaker
input ENUM_TIMEFRAMES InpEMATimeframe          = PERIOD_M1;   // EMA Trend Breaker TF
input int              InpEMAPeriod             = 50;          // EMA period

//--------------------------- Lot sizes ---------------------------------
input double InpGoldLot   = 0.30;  // Gold Lot (XAU)
input double InpForexLot  = 0.05;  // Forex Lot (Pairs)
input double InpCryptoLot = 0.08;  // Crypto Lot (BTC)

//--------------------------- Recovery / grid ---------------------------
input int InpGoldDistPoints   = 800; // Gold Dist (Points)
input int InpForexDistPoints  = 0;   // Forex Dist (Points)
input int InpCryptoDistPoints = 0;   // Crypto Dist (Points)
input int InpGridCooldownMin  = 30;  // Grid Cooldown (Min)
input int InpMaxGridLevels    = 3;   // Max recovery levels per basket (safety cap)

//--------------------------- General ------------------------------------
input ENUM_TIMEFRAMES InpEntryTimeframe = PERIOD_M1; // Entry Analysis TF
input double InpBasketTarget   = 20;   // Basket Target ($)
input double InpBasketStopLoss = 20;   // Basket Stop Loss ($)
input double InpDailyTarget    = 40;   // Daily Target ($)
input double InpDailyStopLoss  = 100;  // Daily Stop Loss ($)

enum ENUM_START_TRIGGER
{
   TRIGGER_AUTO_E_SECURE, // Auto: E SECURE
   TRIGGER_MANUAL         // Manual
};
input ENUM_START_TRIGGER InpStartTrigger = TRIGGER_AUTO_E_SECURE; // Start Triggers

//--------------------------- Filters / protection ------------------------
input bool InpGlobalEVRSProtection  = false; // Global EVRS Protection (extreme-volatility pause)
input bool InpGlobalStochProtection = false; // Global Stoch Protection
input int  InpStochPeriod           = 14;
input int  InpStochOverbought       = 80;
input int  InpStochOversold         = 20;

input bool InpNewsFilter            = true;  // News Filter
input bool InpAutoCloseBeforeNews   = true;  // Auto-Close Trades Before News
input int  InpNewsBufferMinutes     = 30;    // Minutes to block/close around news
input string InpNewsFile            = "NewsTimes.csv"; // File in MQL4/Files, one "YYYY.MM.DD HH:MM" per line

input bool InpTrendFilterH4 = false; // Trend Filter (H4)
input int  InpTrendEMAPeriodH4 = 50;

input bool InpATRFilter      = true; // ATR Filter
input int  InpATRPeriod      = 14;
input double InpATRMinPoints = 300;  // below this = too quiet, skip (gold-scale points, not forex pips)
input double InpATRMaxPoints = 3000; // above this = too wild (news spike), skip (gold-scale points, not forex pips)

input bool InpDailyProtection        = false; // Daily Protection
input int  InpDailyProtectionCloseMin = 30;   // Close(-min) before daily boundary
input int  InpDailyProtectionOpenMin  = 30;   // Open(+min) after daily boundary

//--------------------------- Globals -------------------------------------
string   g_symbol;
bool     g_licenseValid   = false;
datetime g_lastGridTime   = 0;
double   g_dayStartEquity = 0;
int      g_dayOfYear      = -1;
bool     g_dayLocked      = false;
datetime g_newsTimes[];

//+------------------------------------------------------------------+
int OnInit()
{
   g_symbol = (InpTradeSymbol == "") ? Symbol() : InpTradeSymbol;

   string err;
   g_licenseValid = License_Validate(InpLicenseKey, (long)AccountNumber(), InpLicenseSecret, err);
   if(!g_licenseValid)
   {
      Alert("TimeGridEA license check failed: ", err);
      Comment("TimeGridEA STOPPED - invalid license.\n", err);
      return(INIT_SUCCEEDED); // keep EA attached so the error stays visible, but OnTick will refuse to trade
   }

   Comment("TimeGridEA licensed to account ", AccountNumber(), " - running.");
   LoadNewsTimes();
   ResetDailyTrackingNow(); // any (re)load - fresh attach or an input change - starts a clean daily baseline
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   Comment("");
}

//+------------------------------------------------------------------+
void OnTick()
{
   if(!g_licenseValid) return;

   ResetDailyTrackingIfNeeded();

   if(g_dayLocked) return;
   if(InpDailyProtection && InDailyProtectionWindow()) { CloseAllBasket("daily protection window"); return; }

   double basketProfit = GetBasketProfit();
   if(basketProfit >= InpBasketTarget)  { CloseAllBasket("basket target hit"); return; }
   if(basketProfit <= -InpBasketStopLoss) { CloseAllBasket("basket stop loss hit"); return; }

   double dayProfit = AccountEquity() - g_dayStartEquity;
   if(dayProfit >= InpDailyTarget)
   {
      CloseAllBasket("daily target hit");
      g_dayLocked = true;
      return;
   }
   if(dayProfit <= -InpDailyStopLoss)
   {
      CloseAllBasket("daily stop loss hit");
      g_dayLocked = true;
      return;
   }

   if(InpNewsFilter && IsNewsBlackout())
   {
      if(InpAutoCloseBeforeNews) CloseAllBasket("closing ahead of news");
      return;
   }

   if(InpGlobalEVRSProtection && IsExtremeVolatility()) return;

   ManageGrid();

   if(CountBasketOrders() == 0)
      TryOpenInitialTrade();
}

//+------------------------------------------------------------------+
//| Lot / distance selection by asset class                          |
//+------------------------------------------------------------------+
double GetLotForSymbol()
{
   if(StringFind(g_symbol, "XAU") >= 0) return InpGoldLot;
   if(StringFind(g_symbol, "BTC") >= 0) return InpCryptoLot;
   return InpForexLot;
}

int GetGridDistancePoints()
{
   if(StringFind(g_symbol, "XAU") >= 0) return InpGoldDistPoints;
   if(StringFind(g_symbol, "BTC") >= 0) return InpCryptoDistPoints;
   return InpForexDistPoints;
}

//+------------------------------------------------------------------+
//| Entry logic                                                      |
//+------------------------------------------------------------------+
bool GetTrendDirectionM1(int &direction) // 1 = up, -1 = down, 0 = flat/blocked
{
   if(!InpEnableEMATrendBreaker) { direction = 0; return true; }

   double ema = iMA(g_symbol, InpEMATimeframe, InpEMAPeriod, 0, MODE_EMA, PRICE_CLOSE, 0);
   double price = iClose(g_symbol, InpEMATimeframe, 0);

   direction = (price > ema) ? 1 : (price < ema ? -1 : 0);
   return true;
}

bool PassesTrendFilterH4(int direction)
{
   if(!InpTrendFilterH4) return true;
   double emaH4 = iMA(g_symbol, PERIOD_H4, InpTrendEMAPeriodH4, 0, MODE_EMA, PRICE_CLOSE, 0);
   double priceH4 = iClose(g_symbol, PERIOD_H4, 0);
   int h4Direction = (priceH4 > emaH4) ? 1 : -1;
   return (direction == 0) || (direction == h4Direction);
}

bool PassesATRFilter()
{
   if(!InpATRFilter) return true;
   double atr = iATR(g_symbol, InpEntryTimeframe, InpATRPeriod, 0);
   double atrPoints = atr / Point;
   return (atrPoints >= InpATRMinPoints && atrPoints <= InpATRMaxPoints);
}

bool PassesStochProtection()
{
   if(!InpGlobalStochProtection) return true;
   double k = iStochastic(g_symbol, InpEntryTimeframe, InpStochPeriod, 3, 3, MODE_SMA, 0, MODE_MAIN, 0);
   return (k > InpStochOversold && k < InpStochOverbought);
}

bool IsRangingMarket()
{
   if(InpBoxLookback <= 0) return false;

   double hi = iHigh(g_symbol, InpEntryTimeframe, iHighest(g_symbol, InpEntryTimeframe, MODE_HIGH, InpBoxLookback, 1));
   double lo = iLow(g_symbol, InpEntryTimeframe, iLowest(g_symbol, InpEntryTimeframe, MODE_LOW, InpBoxLookback, 1));
   double boxPoints = (hi - lo) / Point;

   if(InpBoxMaxHeightPoints <= 0) return false; // 0 = no ranging check
   return boxPoints <= InpBoxMaxHeightPoints;
}

void TryOpenInitialTrade()
{
   if(InpBlockRangingMarket && IsRangingMarket()) return;
   if(!PassesATRFilter()) return;
   if(!PassesStochProtection()) return;

   int direction;
   GetTrendDirectionM1(direction);
   if(!PassesTrendFilterH4(direction)) return;

   if(InpStartTrigger == TRIGGER_MANUAL) return; // wait for manual/external trigger

   if(direction > 0) OpenOrder(OP_BUY, "TimeGrid init buy");
   else if(direction < 0) OpenOrder(OP_SELL, "TimeGrid init sell");
   // direction == 0 (no trend filter enabled): no signal to act on in this simplified entry model
}

//+------------------------------------------------------------------+
//| Grid / recovery management                                       |
//+------------------------------------------------------------------+
void ManageGrid()
{
   int total = CountBasketOrders();
   if(total == 0 || total >= InpMaxGridLevels) return;

   if(TimeCurrent() - g_lastGridTime < InpGridCooldownMin * 60) return;

   int distPoints = GetGridDistancePoints();
   if(distPoints <= 0) return; // 0 = recovery grid disabled

   int lastTicket = GetLastBasketTicket();
   if(lastTicket < 0 || !OrderSelect(lastTicket, SELECT_BY_TICKET)) return;

   double dist = distPoints * Point;
   int type = OrderType();

   if(type == OP_BUY && Bid <= OrderOpenPrice() - dist)
      OpenOrder(OP_BUY, "TimeGrid recovery buy");
   else if(type == OP_SELL && Ask >= OrderOpenPrice() + dist)
      OpenOrder(OP_SELL, "TimeGrid recovery sell");
}

bool OpenOrder(int type, string comment)
{
   double lot = GetLotForSymbol();
   double price = (type == OP_BUY) ? Ask : Bid;

   int ticket = OrderSend(g_symbol, type, lot, price, 3, 0, 0, comment, InpMagicNumber, 0,
                           (type == OP_BUY) ? clrBlue : clrRed);
   if(ticket < 0)
   {
      Print("OrderSend failed: ", GetLastError());
      return false;
   }

   g_lastGridTime = TimeCurrent();
   return true;
}

//+------------------------------------------------------------------+
//| Basket helpers                                                   |
//+------------------------------------------------------------------+
int CountBasketOrders()
{
   int count = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS)) continue;
      if(OrderSymbol() == g_symbol && OrderMagicNumber() == InpMagicNumber)
         count++;
   }
   return count;
}

int GetLastBasketTicket()
{
   int lastTicket = -1;
   datetime lastTime = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS)) continue;
      if(OrderSymbol() != g_symbol || OrderMagicNumber() != InpMagicNumber) continue;
      if(OrderOpenTime() >= lastTime)
      {
         lastTime = OrderOpenTime();
         lastTicket = OrderTicket();
      }
   }
   return lastTicket;
}

double GetBasketProfit()
{
   double profit = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS)) continue;
      if(OrderSymbol() != g_symbol || OrderMagicNumber() != InpMagicNumber) continue;
      profit += OrderProfit() + OrderSwap() + OrderCommission();
   }
   return profit;
}

void CloseAllBasket(string reason)
{
   Print("Closing basket: ", reason);
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS)) continue;
      if(OrderSymbol() != g_symbol || OrderMagicNumber() != InpMagicNumber) continue;

      bool ok;
      if(OrderType() == OP_BUY)
         ok = OrderClose(OrderTicket(), OrderLots(), Bid, 3, clrYellow);
      else if(OrderType() == OP_SELL)
         ok = OrderClose(OrderTicket(), OrderLots(), Ask, 3, clrYellow);
      else
         continue;

      if(!ok) Print("OrderClose failed for ticket ", OrderTicket(), ": ", GetLastError());
   }
}

//+------------------------------------------------------------------+
//| Daily tracking                                                   |
//+------------------------------------------------------------------+
void ResetDailyTrackingNow()
{
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   g_dayOfYear = t.day_of_year;
   g_dayStartEquity = AccountEquity();
   g_dayLocked = false;
}

// Called every tick to catch the natural midnight rollover. Global variables
// (g_dayLocked included) survive an input-parameter reinit in MQL4, so
// OnInit() calls ResetDailyTrackingNow() directly instead of relying on this
// day-of-year check - otherwise changing an input while still locked out
// from an earlier daily target/stop-loss hit would silently keep the EA
// locked for the rest of the calendar day.
void ResetDailyTrackingIfNeeded()
{
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   if(t.day_of_year != g_dayOfYear)
      ResetDailyTrackingNow();
}

bool InDailyProtectionWindow()
{
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   int minutesSinceMidnight = t.hour * 60 + t.min;
   int minutesInDay = 24 * 60;

   bool nearClose = minutesSinceMidnight >= (minutesInDay - InpDailyProtectionCloseMin);
   bool nearOpen  = minutesSinceMidnight < InpDailyProtectionOpenMin;
   return nearClose || nearOpen;
}

//+------------------------------------------------------------------+
//| News filter - reads MQL4/Files/<InpNewsFile>, one                |
//| "YYYY.MM.DD HH:MM" (broker/server time) per line                 |
//+------------------------------------------------------------------+
void LoadNewsTimes()
{
   ArrayResize(g_newsTimes, 0);
   int handle = FileOpen(InpNewsFile, FILE_READ | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      Print("News file '", InpNewsFile, "' not found in MQL4/Files - news filter has nothing to block.");
      return;
   }

   while(!FileIsEnding(handle))
   {
      string line = FileReadString(handle);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringLen(line) == 0) continue;
      if(StringGetCharacter(line, 0) == '#') continue; // comment line
      datetime dt = StringToTime(line);
      if(dt > 0)
      {
         int n = ArraySize(g_newsTimes);
         ArrayResize(g_newsTimes, n + 1);
         g_newsTimes[n] = dt;
      }
   }
   FileClose(handle);
}

bool IsNewsBlackout()
{
   int bufferSec = InpNewsBufferMinutes * 60;
   datetime now = TimeCurrent();
   for(int i = 0; i < ArraySize(g_newsTimes); i++)
   {
      if(MathAbs((long)(now - g_newsTimes[i])) <= bufferSec)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| "EVRS" isn't a known standard term - its exact original meaning  |
//| is unknown, so this is a best-guess stand-in: flags a spread/ATR |
//| spike (a common proxy for "market just went haywire"). Replace   |
//| this function's body if you learn what EVRS is meant to check.   |
//+------------------------------------------------------------------+
bool IsExtremeVolatility()
{
   double atr = iATR(g_symbol, InpEntryTimeframe, InpATRPeriod, 0);
   double spreadPoints = (Ask - Bid) / Point;
   double atrPoints = atr / Point;
   return spreadPoints > atrPoints * 2.0 && atrPoints > 0;
}
