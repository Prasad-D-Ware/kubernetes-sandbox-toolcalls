import type { LeaseEventSink } from "./lease/LeaseManager.js";
import type { LeaseContext } from "./lease/types.js";
import { type AppLogger, LogEvent } from "./logging.js";

/** Maps LeaseManager observability hooks to structured (pino) log lines. */
export function makeLeaseEventSink(logger: AppLogger): LeaseEventSink {
  const base = (ctx: LeaseContext) => ({
    requestId: ctx.requestId,
    sessionId: ctx.sessionId,
    toolCallId: ctx.toolCallId,
  });
  return {
    queueWaitStarted: (ctx) => logger.info({ event: LogEvent.QueueWaitStarted, ...base(ctx) }, "queue wait started"),
    queueWaitCompleted: (ctx, i) =>
      logger.info({ event: LogEvent.QueueWaitCompleted, ...base(ctx), waitMs: i.waitMs, pod: i.pod }, "queue wait completed"),
    queueWaitTimedOut: (ctx, i) =>
      logger.warn({ event: LogEvent.QueueWaitTimedOut, ...base(ctx), waitMs: i.waitMs }, "queue wait timed out"),
    acquireAttempted: (ctx) => logger.info({ event: LogEvent.LeaseAcquireAttempted, ...base(ctx) }, "lease acquire attempted"),
    acquired: (ctx, i) =>
      logger.info({ event: LogEvent.LeaseAcquired, ...base(ctx), pod: i.pod, leaseDurationSeconds: i.leaseDurationSeconds }, "lease acquired"),
    conflict: (ctx, i) => logger.info({ event: LogEvent.LeaseConflict, ...base(ctx), pod: i.pod }, "lease conflict"),
    released: (ctx, i) => logger.info({ event: LogEvent.LeaseReleased, ...base(ctx), pod: i.pod }, "lease released"),
  };
}
