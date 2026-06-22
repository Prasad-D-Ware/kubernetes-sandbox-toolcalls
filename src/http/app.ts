import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { AppLogger } from "../logging.js";
import { LogEvent } from "../logging.js";
import type { PiClient } from "../pi/types.js";
import type { PoolStateReader } from "../kube/PoolStateReader.js";
import { SandboxCapacityTimeoutError } from "../lease/types.js";
import type { EventBus } from "../dashboard/EventBus.js";
import type { MetricsStore } from "../dashboard/MetricsStore.js";
import type { RuntimeControls } from "../runtimeControls.js";

export interface HealthChecker {
  check(): Promise<{ ok: boolean; kubernetes: "connected" | "disconnected"; sandboxPodsReady: number }>;
}

export interface AppDeps {
  piClient: PiClient;
  poolStateReader: PoolStateReader;
  healthChecker: HealthChecker;
  logger: AppLogger;
  /** Ops dashboard: live event source + metrics snapshot. */
  eventBus: EventBus;
  metricsStore: MetricsStore;
  /** Mutable demo knobs the dashboard can drive (lease hold). */
  runtimeControls: RuntimeControls;
  /** When set, the static dashboard page is served from here at `/`. */
  publicDir?: string;
}

const DEFAULT_DEMO_MESSAGE = "Use the shell.run tool to run `ls` in the sandbox, then tell me what files you see.";
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());

  // ── Ops dashboard ──────────────────────────────────────────────────────────
  app.get("/metrics", (_req: Request, res: Response) => {
    res.json(deps.metricsStore.snapshot());
  });

  // Drive demo load from the dashboard: fire N concurrent tool-calling chats and
  // (optionally) set the lease hold so the queue/timeout behavior is visible. The
  // chats run in the background; the dashboard observes via /events + /metrics.
  app.post("/demo/run", (req: Request, res: Response) => {
    const count = clampInt(req.body?.count, 1, 50, 9);
    const holdMs = clampInt(req.body?.holdMs, 0, 60_000, deps.runtimeControls.demoHoldMs);
    const message = typeof req.body?.message === "string" && req.body.message.trim() ? req.body.message : DEFAULT_DEMO_MESSAGE;
    deps.runtimeControls.demoHoldMs = holdMs;
    const batch = Date.now().toString(36);
    for (let i = 0; i < count; i++) {
      const sessionId = `ui-${batch}-${i + 1}`;
      void deps.piClient
        .runChat({ sessionId, message, requestId: randomUUID() })
        .catch((err) => deps.logger.warn({ event: "demo.run.error", sessionId, err: String(err) }, "demo run chat error"));
    }
    res.status(202).json({ launched: count, holdMs });
  });

  // Live event stream (Server-Sent Events) consumed by the dashboard.
  app.get("/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsubscribe = deps.eventBus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

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

  // Static dashboard page (served last so it never shadows the API routes).
  if (deps.publicDir) {
    app.use(express.static(deps.publicDir));
  }

  return app;
}

/** Wrap an async Express handler so rejections reach the error path. */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
