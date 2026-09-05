import { config } from "./config";
import { logger } from "./logger";
import { createConnection } from "./solana/connection";
import { MonitorManager } from "./solana/monitorManager";
import { Executor } from "./trading/executor";
import { CopyTrader } from "./trading/copyTrader";
import { PositionStore } from "./state/positionStore";
import { runtimeConfig } from "./state/runtimeConfig";
import { startDashboard } from "./web/server";

async function main() {
  const initialTargetWallet = runtimeConfig.get().targetWallet ?? config.targetWallet;

  logger.info("=== Solana Copy-Trading Bot ===");
  logger.info(`Mode: ${config.mode.toUpperCase()}`);
  logger.info(`Target wallet: ${initialTargetWallet}`);
  logger.info(`Copy ratio: ${config.copyRatio} (relative to target's balance-% per trade)`);

  if (config.mode === "live") {
    logger.warn(
      "LIVE MODE: this bot will sign and send real transactions with real funds. " +
        "Make sure you tested thoroughly in dry-run first."
    );
  }

  const connection = createConnection();
  const positions = new PositionStore();
  const executor = new Executor(connection);
  const copyTrader = new CopyTrader(executor, positions);

  const openPositions = positions.all();
  if (openPositions.length > 0) {
    logger.info(`Loaded ${openPositions.length} open position(s) from previous run.`);
  }

  const monitor = new MonitorManager(connection, (event) => copyTrader.onTrade(event), initialTargetWallet);
  monitor.start();

  startDashboard(executor, positions, monitor, new Date());

  logger.info("Listening for target wallet activity... (Ctrl+C to stop)");
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  logger.info("Shutting down.");
  process.exit(0);
});
