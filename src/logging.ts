import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import type { DashboardEvent } from "./dashboard/types.js";

/**
 * Canonical event names for structured logs. Centralized so the README's
 * observability table and the code never drift.
 */
export const LogEvent = {
  ChatRequestStarted: "chat.request.started",
  ChatRequestCompleted: "chat.request.completed",
  ChatRequestFailed: "chat.request.failed",
  ToolCallRequested: "tool.call.requested",
  QueueWaitStarted: "queue.wait.started",
  QueueWaitCompleted: "queue.wait.completed",
  QueueWaitTimedOut: "queue.wait.timed_out",
  LeaseAcquireAttempted: "sandbox.lease.acquire.attempted",
  LeaseAcquired: "sandbox.lease.acquired",
  LeaseConflict: "sandbox.lease.conflict",
  LeaseReleased: "sandbox.lease.released",
  ToolExecutionStarted: "tool.execution.started",
  ToolExecutionCompleted: "tool.execution.completed",
  ToolExecutionFailed: "tool.execution.failed",
  ToolExecutionTimedOut: "tool.execution.timed_out",
} as const;

export type AppLogger = Logger;

/**
 * Parse one pino JSON log line into a DashboardEvent, or null if it isn't a
 * structured event line (no `event` field / not JSON). The dashboard taps these.
 */
export function parseLogLine(line: string): DashboardEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && typeof obj.event === "string") {
      return obj as DashboardEvent;
    }
  } catch {
    // not JSON — ignore
  }
  return null;
}

/** A writable that forwards parsed structured events to `onEvent`. */
function tapStream(onEvent: (e: DashboardEvent) => void): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split("\n")) {
        const parsed = parseLogLine(line);
        if (parsed) onEvent(parsed);
      }
      cb();
    },
  });
}

/**
 * Create the app logger. When `onEvent` is provided, log lines are also tapped
 * (via a pino multistream) and structured events are forwarded to it — this is
 * how the ops dashboard consumes the same events we already log, with zero
 * changes to any emit site.
 */
export function createLogger(level: string, onEvent?: (e: DashboardEvent) => void): AppLogger {
  const options = {
    level,
    base: undefined, // omit pid/hostname; keep lines focused on our fields
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (!onEvent) return pino(options);
  return pino(
    options,
    pino.multistream([{ stream: process.stdout }, { stream: tapStream(onEvent) }]),
  );
}
