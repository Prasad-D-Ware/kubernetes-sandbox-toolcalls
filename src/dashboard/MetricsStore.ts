import type {
  DashboardEvent,
  MetricsSnapshot,
  PodView,
  ToolCallRecord,
  ToolCallStatus,
} from "./types.js";

const MAX_RECENT = 100;
const MAX_UTIL = 120;
const MAX_SAMPLES = 500;

interface PodState extends PodView {}

/**
 * Pure reducer over the structured-log event stream. `apply(event)` mutates
 * in-memory state; `snapshot()` returns the dashboard view. No I/O, so it is
 * fully testable with synthetic events.
 */
export class MetricsStore {
  private pods = new Map<string, PodState>();
  private counters = {
    toolCalls: { total: 0, completed: 0, failed: 0, timedOut: 0 },
    queue: { depth: 0, waitsStarted: 0, waitsCompleted: 0, timeouts: 0 },
    leases: { acquired: 0, released: 0, conflicts: 0 },
    chat: { started: 0, completed: 0, failed: 0 },
  };
  private execMs: number[] = [];
  private queueWaitMs: number[] = [];
  private recent: ToolCallRecord[] = [];
  private util: { t: number; busy: number }[] = [];
  /** toolCallId -> in-flight execution context (pod + start time). */
  private inflight = new Map<string, { pod: string; startMs: number }>();
  /** toolCallId -> side details collected across events (command, queue wait). */
  private meta = new Map<string, { detail?: string; queueWaitMs?: number }>();

  constructor(podNames: string[]) {
    for (const name of podNames) {
      this.pods.set(name, { name, status: "free", callsServed: 0 });
    }
  }

  private busyCount(): number {
    let n = 0;
    for (const p of this.pods.values()) if (p.status === "leased") n += 1;
    return n;
  }

  private sampleUtilization(at: number): void {
    this.util.push({ t: at, busy: this.busyCount() });
    if (this.util.length > MAX_UTIL) this.util.shift();
  }

  private pushRecent(rec: ToolCallRecord): void {
    this.recent.unshift(rec);
    if (this.recent.length > MAX_RECENT) this.recent.pop();
  }

  private timeOf(e: DashboardEvent): number {
    return e.time ? Date.parse(e.time) : Date.now();
  }

  apply(e: DashboardEvent): void {
    const now = this.timeOf(e);
    switch (e.event) {
      case "chat.request.started":
        this.counters.chat.started += 1;
        break;
      case "chat.request.completed":
        this.counters.chat.completed += 1;
        break;
      case "chat.request.failed":
        this.counters.chat.failed += 1;
        break;

      case "tool.call.requested": {
        this.counters.toolCalls.total += 1;
        if (e.toolCallId && typeof e.detail === "string") {
          this.meta.set(e.toolCallId, { ...this.meta.get(e.toolCallId), detail: e.detail });
        }
        break;
      }

      case "sandbox.lease.acquire.attempted":
        break;
      case "sandbox.lease.acquired": {
        const pod = e.pod && this.pods.get(e.pod);
        if (pod) {
          pod.status = "leased";
          pod.session = e.sessionId;
          pod.tool = e.toolCallId;
          pod.holderIdentity = `${e.sessionId ?? ""}:${e.toolCallId ?? ""}`;
          if (e.leaseDurationSeconds) pod.expiresAt = new Date(now + e.leaseDurationSeconds * 1000).toISOString();
        }
        this.counters.leases.acquired += 1;
        if (e.toolCallId && e.pod) this.inflight.set(e.toolCallId, { pod: e.pod, startMs: now });
        this.sampleUtilization(now);
        break;
      }
      case "sandbox.lease.conflict":
        this.counters.leases.conflicts += 1;
        break;
      case "sandbox.lease.released": {
        const pod = e.pod && this.pods.get(e.pod);
        if (pod) {
          pod.status = "free";
          pod.session = undefined;
          pod.tool = undefined;
          pod.holderIdentity = undefined;
          pod.expiresAt = undefined;
        }
        this.counters.leases.released += 1;
        this.sampleUtilization(now);
        break;
      }

      case "tool.execution.started": {
        const pod = e.pod && this.pods.get(e.pod);
        if (pod) pod.callsServed += 1;
        if (e.toolCallId && e.pod && !this.inflight.has(e.toolCallId)) {
          this.inflight.set(e.toolCallId, { pod: e.pod, startMs: now });
        }
        break;
      }
      case "tool.execution.completed":
        this.counters.toolCalls.completed += 1;
        this.finishToolCall(e, now, "completed");
        break;
      case "tool.execution.failed":
        this.counters.toolCalls.failed += 1;
        this.finishToolCall(e, now, "failed");
        break;
      case "tool.execution.timed_out":
        this.counters.toolCalls.timedOut += 1;
        this.finishToolCall(e, now, "timed_out");
        break;

      case "queue.wait.started":
        this.counters.queue.depth += 1;
        this.counters.queue.waitsStarted += 1;
        break;
      case "queue.wait.completed":
        this.counters.queue.depth = Math.max(0, this.counters.queue.depth - 1);
        this.counters.queue.waitsCompleted += 1;
        if (typeof e.waitMs === "number") {
          this.pushSample(this.queueWaitMs, e.waitMs);
          if (e.toolCallId) this.meta.set(e.toolCallId, { ...this.meta.get(e.toolCallId), queueWaitMs: e.waitMs });
        }
        break;
      case "queue.wait.timed_out":
        this.counters.queue.depth = Math.max(0, this.counters.queue.depth - 1);
        this.counters.queue.timeouts += 1;
        this.pushRecent({
          time: e.time ?? new Date(now).toISOString(),
          sessionId: e.sessionId,
          requestId: e.requestId,
          tool: typeof e.tool === "string" ? e.tool : undefined,
          detail: e.toolCallId ? this.meta.get(e.toolCallId)?.detail : undefined,
          pod: null,
          status: "capacity_timeout",
          durationMs: typeof e.waitMs === "number" ? e.waitMs : null,
          queueWaitMs: typeof e.waitMs === "number" ? e.waitMs : undefined,
        });
        if (e.toolCallId) this.meta.delete(e.toolCallId);
        break;
    }
  }

  private finishToolCall(e: DashboardEvent, now: number, status: ToolCallStatus): void {
    const ctx = e.toolCallId ? this.inflight.get(e.toolCallId) : undefined;
    const meta = e.toolCallId ? this.meta.get(e.toolCallId) : undefined;
    const pod = e.pod ?? ctx?.pod ?? null;
    const durationMs = ctx ? Math.max(0, now - ctx.startMs) : null;
    if (status === "completed" && durationMs != null) this.pushSample(this.execMs, durationMs);
    if (e.toolCallId) {
      this.inflight.delete(e.toolCallId);
      this.meta.delete(e.toolCallId);
    }
    this.pushRecent({
      time: e.time ?? new Date(now).toISOString(),
      sessionId: e.sessionId,
      requestId: e.requestId,
      tool: typeof e.tool === "string" ? e.tool : undefined,
      detail: meta?.detail,
      pod,
      status,
      durationMs,
      queueWaitMs: meta?.queueWaitMs,
    });
  }

  private pushSample(arr: number[], value: number): void {
    arr.push(value);
    if (arr.length > MAX_SAMPLES) arr.shift();
  }

  snapshot(): MetricsSnapshot {
    return {
      pods: [...this.pods.values()].map((p) => ({ ...p })),
      counters: {
        toolCalls: { ...this.counters.toolCalls },
        queue: { ...this.counters.queue },
        leases: { ...this.counters.leases },
        chat: { ...this.counters.chat },
      },
      latency: {
        execMsP95: percentile(this.execMs, 95),
        execMsAvg: avg(this.execMs),
        queueWaitMsAvg: avg(this.queueWaitMs),
      },
      recentToolCalls: this.recent.map((r) => ({ ...r })),
      utilization: this.util.map((u) => ({ ...u })),
    };
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
}
