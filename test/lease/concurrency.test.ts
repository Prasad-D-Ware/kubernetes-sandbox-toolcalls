import { describe, it, expect } from "vitest";
import { LeaseManager } from "../../src/lease/LeaseManager.js";
import { FakeLeaseClient } from "../support/fakeLeaseClient.js";

function pool(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `sandbox-runner-${i}`);
}

function makeManager(client: FakeLeaseClient, pods: string[]) {
  return new LeaseManager({
    client,
    pods,
    serviceInstanceId: "api-test",
    leaseTtlSeconds: 45,
    maxQueueWaitMs: 15_000,
  });
}

const ctx = (i: number) => ({
  requestId: `req-${i}`,
  sessionId: "session-1",
  toolCallId: `tool-${i}`,
});

describe("LeaseManager concurrency", () => {
  it("never grants the same pod to two concurrent acquisitions", async () => {
    const pods = pool(8);
    const client = new FakeLeaseClient(pods);
    const manager = makeManager(client, pods);

    // Real concurrency pressure: 8 simultaneous acquisitions for 8 pods.
    const leases = await Promise.all(pods.map((_, i) => manager.acquire(ctx(i))));

    const grantedPods = leases.map((l) => l.pod);
    expect(new Set(grantedPods).size).toBe(8); // all distinct
    expect(new Set(grantedPods)).toEqual(new Set(pods)); // exactly the pool
  });
});
