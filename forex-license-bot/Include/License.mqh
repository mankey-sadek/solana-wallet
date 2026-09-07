//+------------------------------------------------------------------+
//|                                                    License.mqh   |
//| Offline, account-bound activation-key check.                     |
//|                                                                    |
//| Key format:  <account>-<expiryYYYYMMDD>-<signature16hex>          |
//| signature = first 16 hex chars of HMAC-SHA256(secret,             |
//|                                                "<account>|<expiry>")|
//|                                                                    |
//| The same LicenseSecret must be compiled into the EA and used by   |
//| tools/keygen.py when minting keys. Anyone who extracts the        |
//| secret from the compiled .ex4 (e.g. with a decompiler) can forge  |
//| keys -- this offline scheme only stops casual copying, it is not  |
//| tamper-proof. For stronger protection you would need a server-    |
//| side check (see README.md).                                       |
//+------------------------------------------------------------------+
#property strict
#include "Sha256.mqh"

bool License_ParseKey(string key, long &account, string &expiry, string &sig)
{
   string parts[];
   int n = StringSplit(key, '-', parts);
   if(n != 3) return false;

   if(StringLen(parts[0]) == 0 || StringLen(parts[1]) != 8 || StringLen(parts[2]) != 16)
      return false;

   account = StringToInteger(parts[0]);
   expiry  = parts[1];
   sig     = parts[2];
   return true;
}

// Returns true if the key is valid for accountNumber under secret.
// On failure, errorMsg explains why (shown in the Experts log / chart comment).
bool License_Validate(string key, long accountNumber, string secret, string &errorMsg)
{
   long keyAccount;
   string expiry, sig;

   if(!License_ParseKey(key, keyAccount, expiry, sig))
   {
      errorMsg = "Malformed license key. Expected format: ACCOUNT-YYYYMMDD-SIGNATURE";
      return false;
   }

   if(keyAccount != accountNumber)
   {
      errorMsg = StringFormat("License is issued for account %d, this account is %d", keyAccount, accountNumber);
      return false;
   }

   string y = StringSubstr(expiry, 0, 4);
   string m = StringSubstr(expiry, 4, 2);
   string d = StringSubstr(expiry, 6, 2);
   datetime expiryDate = StringToTime(y + "." + m + "." + d + " 23:59:59");

   if(expiryDate == 0)
   {
      errorMsg = "Malformed expiry date in license key";
      return false;
   }

   if(TimeCurrent() > expiryDate)
   {
      errorMsg = "License expired on " + TimeToString(expiryDate, TIME_DATE);
      return false;
   }

   string payload = IntegerToString(keyAccount) + "|" + expiry;
   string expectedSig = StringSubstr(Sha256_HmacHex(secret, payload), 0, 16);

   if(expectedSig != sig)
   {
      errorMsg = "Invalid license signature";
      return false;
   }

   errorMsg = "";
   return true;
}
