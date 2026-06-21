import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { AppLogger } from "../logging.js";
import { LogEvent } from "../logging.js";
import type { PiClient } from "../pi/types.js";
import type { PoolStateReader } from "../kube/PoolStateReader.js";
import { SandboxCapacityTimeoutError } from "../lease/types.js";

export interface HealthChecker {
  check(): Promise<{ ok: boolean; kubernetes: "connected" | "disconnected"; sandboxPodsReady: number }>;
}

export interface AppDeps {
  piClient: PiClient;
  poolStateReader: PoolStateReader;
  healthChecker: HealthChecker;
  logger: AppLogger;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());

  app.post("/chat", asyncHandler(async (req: Request, res: Response) => {
    const { sessionId, message } = req.body ?? {};
    if (typeof sessionId !== "string" || typeof message !== "string") {
      return res.status(400).json({ error: { code: "bad_request", message: "sessionId and message are required strings." } });
    }
    const requestId = randomUUID();
    const log = deps.logger.child({ requestId, sessionId });
    log.info({ event: LogEvent.ChatRequestStarted }, "chat request started");
    try {
      const result = await deps.piClient.runChat({ sessionId, message, requestId });
      log.info({ event: LogEvent.ChatRequestCompleted, toolCalls: result.toolCalls.length }, "chat request completed");
      return res.json(result);
    } catch (err) {
      if (err instanceof SandboxCapacityTimeoutError) {
        log.warn({ event: LogEvent.ChatRequestFailed, code: err.code }, "chat request capacity timeout");
        return res.status(503).json({ error: { code: err.code, message: err.message } });
      }
      log.error({ event: LogEvent.ChatRequestFailed, err: String(err) }, "chat request failed");
      return res.status(500).json({ error: { code: "internal_error", message: "Unexpected error handling chat request." } });
    }
  }));

  app.get("/pods", asyncHandler(async (_req: Request, res: Response) => {
    res.json(await deps.poolStateReader.read());
  }));

  app.get("/health", asyncHandler(async (_req: Request, res: Response) => {
    const health = await deps.healthChecker.check();
    res.status(health.ok ? 200 : 503).json(health);
  }));

  return app;
}

/** Wrap an async Express handler so rejections reach the error path. */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
