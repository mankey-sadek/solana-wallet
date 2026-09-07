//+------------------------------------------------------------------+
//|                                                     Sha256.mqh   |
//| Minimal, dependency-free SHA-256 / HMAC-SHA256 for MQL4.         |
//| Used only for offline license-key verification (see License.mqh)|
//+------------------------------------------------------------------+
#property strict

uint Sha256_K[64] =
{
   0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
   0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
   0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
   0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
   0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
   0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
   0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
   0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

uint Sha256_Rotr(uint x, int n) { return (x >> n) | (x << (32 - n)); }

void Sha256_Transform(uint &h[], const uchar &chunk[], int offset)
{
   uint w[64];
   for(int i = 0; i < 16; i++)
      w[i] = ((uint)chunk[offset + i*4] << 24) | ((uint)chunk[offset + i*4 + 1] << 16) |
             ((uint)chunk[offset + i*4 + 2] << 8) | ((uint)chunk[offset + i*4 + 3]);

   for(int i = 16; i < 64; i++)
   {
      uint s0 = Sha256_Rotr(w[i-15], 7) ^ Sha256_Rotr(w[i-15], 18) ^ (w[i-15] >> 3);
      uint s1 = Sha256_Rotr(w[i-2], 17) ^ Sha256_Rotr(w[i-2], 19) ^ (w[i-2] >> 10);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
   }

   uint a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];

   for(int i = 0; i < 64; i++)
   {
      uint S1 = Sha256_Rotr(e, 6) ^ Sha256_Rotr(e, 11) ^ Sha256_Rotr(e, 25);
      uint ch = (e & f) ^ ((~e) & g);
      uint temp1 = hh + S1 + ch + Sha256_K[i] + w[i];
      uint S0 = Sha256_Rotr(a, 2) ^ Sha256_Rotr(a, 13) ^ Sha256_Rotr(a, 22);
      uint maj = (a & b) ^ (a & c) ^ (b & c);
      uint temp2 = S0 + maj;

      hh = g; g = f; f = e; e = d + temp1;
      d = c; c = b; b = a; a = temp1 + temp2;
   }

   h[0] += a; h[1] += b; h[2] += c; h[3] += d;
   h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

void Sha256_Compute(const uchar &data[], int len, uchar &out[])
{
   uint h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};

   int totalLen = ((len + 8) / 64 + 1) * 64;
   uchar msg[];
   ArrayResize(msg, totalLen);
   ArrayInitialize(msg, 0);
   for(int i = 0; i < len; i++) msg[i] = data[i];
   msg[len] = 0x80;

   ulong bitLen = (ulong)len * 8;
   for(int i = 0; i < 8; i++)
      msg[totalLen - 1 - i] = (uchar)(bitLen >> (8 * i));

   for(int offset = 0; offset < totalLen; offset += 64)
      Sha256_Transform(h, msg, offset);

   ArrayResize(out, 32);
   for(int i = 0; i < 8; i++)
   {
      out[i*4]   = (uchar)(h[i] >> 24);
      out[i*4+1] = (uchar)(h[i] >> 16);
      out[i*4+2] = (uchar)(h[i] >> 8);
      out[i*4+3] = (uchar)(h[i]);
   }
}

void Sha256_StringToBytes(string s, uchar &out[])
{
   int len = StringLen(s);
   uchar tmp[];
   StringToCharArray(s, tmp);
   ArrayResize(out, len);
   for(int i = 0; i < len; i++) out[i] = tmp[i];
}

void Sha256_HmacCompute(const uchar &key[], int keyLen, const uchar &msg[], int msgLen, uchar &out[])
{
   uchar k[64];
   ArrayInitialize(k, 0);

   if(keyLen > 64)
   {
      uchar khash[];
      Sha256_Compute(key, keyLen, khash);
      for(int i = 0; i < 32; i++) k[i] = khash[i];
   }
   else
   {
      for(int i = 0; i < keyLen; i++) k[i] = key[i];
   }

   uchar ipad[64], opad[64];
   for(int i = 0; i < 64; i++)
   {
      ipad[i] = (uchar)(k[i] ^ 0x36);
      opad[i] = (uchar)(k[i] ^ 0x5c);
   }

   uchar inner[];
   ArrayResize(inner, 64 + msgLen);
   for(int i = 0; i < 64; i++) inner[i] = ipad[i];
   for(int i = 0; i < msgLen; i++) inner[64 + i] = msg[i];

   uchar innerHash[];
   Sha256_Compute(inner, 64 + msgLen, innerHash);

   uchar outer[];
   ArrayResize(outer, 64 + 32);
   for(int i = 0; i < 64; i++) outer[i] = opad[i];
   for(int i = 0; i < 32; i++) outer[64 + i] = innerHash[i];

   Sha256_Compute(outer, 96, out);
}

string Sha256_BytesToHex(const uchar &b[], int len)
{
   string hexChars = "0123456789ABCDEF";
   string res = "";
   for(int i = 0; i < len; i++)
   {
      res += StringSubstr(hexChars, (b[i] >> 4) & 0xF, 1);
      res += StringSubstr(hexChars, b[i] & 0xF, 1);
   }
   return res;
}

// Convenience: HMAC-SHA256(secret, message) -> uppercase hex string
string Sha256_HmacHex(string secret, string message)
{
   uchar keyBytes[], msgBytes[], mac[];
   Sha256_StringToBytes(secret, keyBytes);
   Sha256_StringToBytes(message, msgBytes);
   Sha256_HmacCompute(keyBytes, ArraySize(keyBytes), msgBytes, ArraySize(msgBytes), mac);
   return Sha256_BytesToHex(mac, 32);
}
