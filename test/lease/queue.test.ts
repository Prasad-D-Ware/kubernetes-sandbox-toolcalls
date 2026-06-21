import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaseManager } from "../../src/lease/LeaseManager.js";
import { SandboxCapacityTimeoutError } from "../../src/lease/types.js";
import { FakeLeaseClient } from "../support/fakeLeaseClient.js";

function pool(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `sandbox-runner-${i}`);
}

function makeManager(client: FakeLeaseClient, pods: string[], maxQueueWaitMs = 15_000) {
  return new LeaseManager({
    client,
    pods,
    serviceInstanceId: "api-test",
    leaseTtlSeconds: 45,
    maxQueueWaitMs,
  });
}

const ctx = (i: number) => ({
  requestId: `req-${i}`,
  sessionId: "session-1",
  toolCallId: `tool-${i}`,
});

describe("LeaseManager capacity queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("queues acquisitions beyond pool capacity instead of failing immediately", async () => {
    const pods = pool(8);
    const client = new FakeLeaseClient(pods);
    const manager = makeManager(client, pods);

    // Fill all 8 pods.
    const held = await Promise.all(pods.map((_, i) => manager.acquire(ctx(i))));

    // The 9th must wait in the queue, not reject.
    const ninth = manager.acquire(ctx(9));
    let settled = false;
    void ninth.then(() => (settled = true)).catch(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // still queued, no capacity

    // Free one pod -> the queued acquisition gets it.
    await manager.release(held[0]);
    const lease9 = await ninth;
    expect(lease9.pod).toBe(held[0].pod);
  });

  it("fails a queued acquisition with sandbox_capacity_timeout after the max wait", async () => {
    const pods = pool(1);
    const client = new FakeLeaseClient(pods);
    const manager = makeManager(client, pods, 15_000);

    await manager.acquire(ctx(0)); // hold the only pod, never release

    const queued = manager.acquire(ctx(1));
    const assertion = expect(queued).rejects.toBeInstanceOf(SandboxCapacityTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("serves queued acquisitions in FIFO order as pods free up", async () => {
    const pods = pool(1);
    const client = new FakeLeaseClient(pods);
    const manager = makeManager(client, pods);

    const first = await manager.acquire(ctx(0)); // holds the only pod

    const order: number[] = [];
    const a = manager.acquire(ctx(1)).then((l) => { order.push(1); return l; });
    const b = manager.acquire(ctx(2)).then((l) => { order.push(2); return l; });
    await Promise.resolve();

    await manager.release(first);
    const la = await a;
    expect(la.pod).toBe(first.pod);
    await manager.release(la);
    await b;

    expect(order).toEqual([1, 2]); // waiter enqueued first is served first
  });
});
