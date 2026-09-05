import express from "express";
import * as path from "path";
import { config } from "../config";
import { logger } from "../logger";
import { PositionStore } from "../state/positionStore";
import { eventLog } from "../state/eventLog";
import { Executor } from "../trading/executor";

export function startDashboard(executor: Executor, positions: PositionStore, startedAt: Date): void {
  const app = express();

  app.get("/api/status", async (_req, res) => {
    let ourSolBalance: number | null = null;
    if (config.mode === "live") {
      try {
        ourSolBalance = Number(await executor.getSolBalanceLamports()) / 1_000_000_000;
      } catch (err) {
        logger.error("Dashboard: failed to fetch SOL balance:", err);
      }
    }
    res.json({
      mode: config.mode,
      targetWallet: config.targetWallet,
      walletAddress: config.mode === "live" ? executor.publicKeyBase58 : null,
      copyRatio: config.copyRatio,
      minTradeSol: config.minTradeSol,
      maxTradeSol: config.maxTradeSol,
      reserveSol: config.reserveSol,
      minSourceTradeSol: config.minSourceTradeSol,
      startedAt: startedAt.toISOString(),
      ourSolBalance,
    });
  });

  app.get("/api/positions", (_req, res) => {
    res.json(positions.all());
  });

  app.get("/api/events", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    res.json(eventLog.recent(limit));
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.listen(config.dashboardPort, () => {
    logger.info(`Dashboard running at http://localhost:${config.dashboardPort}`);
  });
}
