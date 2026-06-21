import pino, { type Logger } from "pino";

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

export function createLogger(level: string): AppLogger {
  return pino({
    level,
    base: undefined, // omit pid/hostname; keep lines focused on our fields
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
