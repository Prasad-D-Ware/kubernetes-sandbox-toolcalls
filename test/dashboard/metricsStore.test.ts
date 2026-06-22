import { describe, it, expect } from "vitest";
import { MetricsStore } from "../../src/dashboard/MetricsStore.js";
import type { DashboardEvent } from "../../src/dashboard/types.js";

const POOL = ["sandbox-runner-0", "sandbox-runner-1"];

function store() {
  return new MetricsStore(POOL);
}

const ev = (event: string, extra: Partial<DashboardEvent> = {}): DashboardEvent => ({
  event,
  time: new Date().toISOString(),
  ...extra,
});

describe("MetricsStore", () => {
  it("starts with all pods free and zeroed counters", () => {
    const snap = store().snapshot();
    expect(snap.pods.map((p) => p.name)).toEqual(POOL);
    expect(snap.pods.every((p) => p.status === "free" && p.callsServed === 0)).toBe(true);
    expect(snap.counters.toolCalls.total).toBe(0);
  });

  it("marks a pod leased on sandbox.lease.acquired with holder breakdown", () => {
    const s = store();
    s.apply(ev("sandbox.lease.acquired", {
      pod: "sandbox-runner-0",
      sessionId: "demo-9",
      toolCallId: "tool-x",
      leaseDurationSeconds: 45,
    }));
    const snap = s.snapshot();
    const pod = snap.pods.find((p) => p.name === "sandbox-runner-0")!;
    expect(pod.status).toBe("leased");
    expect(pod.session).toBe("demo-9");
    expect(pod.tool).toBe("tool-x");
    expect(snap.counters.leases.acquired).toBe(1);
  });

  it("tracks a full tool-call lifecycle: leased -> executing -> completed -> freed", () => {
    const s = store();
    const t0 = new Date("2026-06-21T12:00:00.000Z").toISOString();
    const t1 = new Date("2026-06-21T12:00:00.030Z").toISOString();
    s.apply(ev("tool.call.requested", { tool: "shell.run", toolCallId: "t1" }));
    s.apply({ event: "sandbox.lease.acquired", time: t0, pod: "sandbox-runner-0", sessionId: "demo-1", toolCallId: "t1", leaseDurationSeconds: 45 });
    s.apply({ event: "tool.execution.started", time: t0, pod: "sandbox-runner-0", tool: "shell.run", toolCallId: "t1" });
    s.apply({ event: "tool.execution.completed", time: t1, pod: "sandbox-runner-0", tool: "shell.run", toolCallId: "t1", sessionId: "demo-1" });
    s.apply({ event: "sandbox.lease.released", time: t1, pod: "sandbox-runner-0", toolCallId: "t1" });

    const snap = s.snapshot();
    expect(snap.pods.find((p) => p.name === "sandbox-runner-0")!.status).toBe("free");
    expect(snap.pods.find((p) => p.name === "sandbox-runner-0")!.callsServed).toBe(1);
    expect(snap.counters.toolCalls).toMatchObject({ total: 1, completed: 1 });
    expect(snap.latency.execMsAvg).toBe(30); // 30ms exec
    const rec = snap.recentToolCalls[0];
    expect(rec).toMatchObject({ tool: "shell.run", pod: "sandbox-runner-0", status: "completed", durationMs: 30, sessionId: "demo-1" });
    expect(snap.utilization.length).toBeGreaterThanOrEqual(2); // sampled on acquire + release
  });

  it("records a capacity timeout as a pod-less task->pod row", () => {
    const s = store();
    s.apply(ev("queue.wait.started", { sessionId: "demo-9", toolCallId: "t9" }));
    s.apply(ev("queue.wait.timed_out", { sessionId: "demo-9", toolCallId: "t9", waitMs: 15000 }));

    const snap = s.snapshot();
    expect(snap.counters.queue.timeouts).toBe(1);
    expect(snap.counters.queue.depth).toBe(0);
    expect(snap.recentToolCalls[0]).toMatchObject({ pod: null, status: "capacity_timeout", durationMs: 15000, sessionId: "demo-9" });
  });

  it("counts queue depth up on wait start and down on completion", () => {
    const s = store();
    s.apply(ev("queue.wait.started", { toolCallId: "a" }));
    s.apply(ev("queue.wait.started", { toolCallId: "b" }));
    expect(s.snapshot().counters.queue.depth).toBe(2);
    s.apply(ev("queue.wait.completed", { toolCallId: "a", waitMs: 2000, pod: "sandbox-runner-0" }));
    const snap = s.snapshot();
    expect(snap.counters.queue.depth).toBe(1);
    expect(snap.counters.queue.waitsCompleted).toBe(1);
    expect(snap.latency.queueWaitMsAvg).toBe(2000);
  });
});
