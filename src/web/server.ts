import express from "express";
import * as path from "path";
import { config } from "../config";
import { logger } from "../logger";
import { PositionStore } from "../state/positionStore";
import { eventLog } from "../state/eventLog";
import { Executor } from "../trading/executor";
import { MonitorManager } from "../solana/monitorManager";

export function startDashboard(
  executor: Executor,
  positions: PositionStore,
  monitor: MonitorManager,
  startedAt: Date
): void {
  const app = express();
  app.use(express.json());

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
      targetWallet: monitor.targetWallet,
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

  app.post("/api/target-wallet", async (req, res) => {
    const address = typeof req.body?.address === "string" ? req.body.address : "";
    if (!address.trim()) {
      res.status(400).json({ error: "لازم تدخل عنوان محفظة" });
      return;
    }
    try {
      const targetWallet = await monitor.setTarget(address);
      const openPositions = positions.all().length;
      res.json({
        targetWallet,
        note:
          openPositions > 0
            ? `عندك ${openPositions} مركز مفتوح من قبل التبديل - لسه متابع، لكن هيتقفل بس لو المحفظة الجديدة تداولت نفس التوكن، أو تقفله يدويًا.`
            : undefined,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.listen(config.dashboardPort, () => {
    logger.info(`Dashboard running at http://localhost:${config.dashboardPort}`);
  });
}
