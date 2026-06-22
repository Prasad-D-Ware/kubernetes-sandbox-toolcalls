/** A parsed structured-log event, as published on the EventBus. */
export interface DashboardEvent {
  event: string;
  time?: string;
  requestId?: string;
  sessionId?: string;
  toolCallId?: string;
  pod?: string;
  waitMs?: number;
  leaseDurationSeconds?: number;
  code?: string;
  [key: string]: unknown;
}

export type PodStatus = "free" | "leased";

export interface PodView {
  name: string;
  status: PodStatus;
  session?: string;
  tool?: string;
  holderIdentity?: string;
  expiresAt?: string;
  callsServed: number;
}

export type ToolCallStatus = "completed" | "failed" | "timed_out" | "capacity_timeout";

export interface ToolCallRecord {
  time: string;
  sessionId?: string;
  requestId?: string;
  tool?: string;
  /** Human summary of the call input (e.g. the shell command or read path). */
  detail?: string;
  pod: string | null;
  status: ToolCallStatus;
  durationMs: number | null;
  /** Time spent waiting in the capacity queue before a pod was acquired, if any. */
  queueWaitMs?: number;
}

export interface MetricsSnapshot {
  pods: PodView[];
  counters: {
    toolCalls: { total: number; completed: number; failed: number; timedOut: number };
    queue: { depth: number; waitsStarted: number; waitsCompleted: number; timeouts: number };
    leases: { acquired: number; released: number; conflicts: number };
    chat: { started: number; completed: number; failed: number };
  };
  latency: { execMsP95: number; execMsAvg: number; queueWaitMsAvg: number };
  recentToolCalls: ToolCallRecord[];
  utilization: { t: number; busy: number }[];
}
