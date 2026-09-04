import "dotenv/config";
import { AppConfig, Mode } from "./types";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function loadConfig(): AppConfig {
  const modeRaw = (process.env.MODE ?? "dry-run").trim();
  if (modeRaw !== "dry-run" && modeRaw !== "live") {
    throw new Error(`MODE must be "dry-run" or "live", got "${modeRaw}"`);
  }
  const mode = modeRaw as Mode;

  const cfg: AppConfig = {
    targetWallet: required("TARGET_WALLET"),
    rpcHttpUrl: required("RPC_HTTP_URL"),
    rpcWsUrl: required("RPC_WS_URL"),
    mode,
    myWalletPrivateKey: process.env.MY_WALLET_PRIVATE_KEY?.trim() || undefined,
    copyRatio: num("COPY_RATIO", 0.1),
    minTradeSol: num("MIN_TRADE_SOL", 0.01),
    maxTradeSol: num("MAX_TRADE_SOL", 1),
    reserveSol: num("RESERVE_SOL", 0.05),
    minSourceTradeSol: num("MIN_SOURCE_TRADE_SOL", 0.02),
    slippageBps: num("SLIPPAGE_BPS", 150),
    jupiterApiUrl: (process.env.JUPITER_API_URL ?? "https://quote-api.jup.ag/v6").trim(),
  };

  if (cfg.mode === "live" && !cfg.myWalletPrivateKey) {
    throw new Error("MODE=live requires MY_WALLET_PRIVATE_KEY to be set");
  }
  if (cfg.copyRatio <= 0) {
    throw new Error("COPY_RATIO must be > 0");
  }
  if (cfg.minTradeSol <= 0 || cfg.maxTradeSol <= 0 || cfg.minTradeSol > cfg.maxTradeSol) {
    throw new Error("MIN_TRADE_SOL/MAX_TRADE_SOL are invalid");
  }

  return cfg;
}

export const config = loadConfig();
