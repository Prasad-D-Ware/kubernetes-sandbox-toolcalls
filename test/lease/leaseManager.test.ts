import { describe, it, expect } from "vitest";
import { LeaseManager } from "../../src/lease/LeaseManager.js";
import { FakeLeaseClient } from "../support/fakeLeaseClient.js";

const POOL = ["sandbox-runner-0", "sandbox-runner-1"];

function makeManager(client: FakeLeaseClient) {
  return new LeaseManager({
    client,
    pods: POOL,
    serviceInstanceId: "api-test",
    leaseTtlSeconds: 45,
    maxQueueWaitMs: 15_000,
  });
}

const ctx = (toolCallId: string) => ({
  requestId: "req-1",
  sessionId: "session-1",
  toolCallId,
});

describe("LeaseManager.acquire", () => {
  it("acquires a free pod and records holder identity on its Lease", async () => {
    const client = new FakeLeaseClient(POOL);
    const manager = makeManager(client);

    const lease = await manager.acquire(ctx("tool-1"));

    expect(POOL).toContain(lease.pod);
    const record = await client.readLease(lease.pod);
    expect(record.holderIdentity).toBe("api-test:req-1:session-1:tool-1");
    expect(record.leaseDurationSeconds).toBe(45);
  });
});

describe("LeaseManager.release", () => {
  it("frees the Lease so the pod can be acquired again", async () => {
    const client = new FakeLeaseClient(POOL);
    const manager = makeManager(client);

    const lease = await manager.acquire(ctx("tool-1"));
    await manager.release(lease);

    const record = await client.readLease(lease.pod);
    expect(record.holderIdentity).toBeNull();

    // The freed pod is acquirable again.
    const again = await manager.acquire(ctx("tool-2"));
    expect(again.pod).toBe(lease.pod);
  });
});

describe("LeaseManager.withLease", () => {
  it("runs the work with a leased pod and releases on success", async () => {
    const client = new FakeLeaseClient(POOL);
    const manager = makeManager(client);

    const result = await manager.withLease(ctx("tool-1"), async (pod) => {
      const record = await client.readLease(pod);
      expect(record.holderIdentity).toBe("api-test:req-1:session-1:tool-1");
      return "ok";
    });

    expect(result).toBe("ok");
    // All pods free again.
    for (const pod of POOL) {
      expect((await client.readLease(pod)).holderIdentity).toBeNull();
    }
  });

  it("releases the pod when the work throws (tool failure)", async () => {
    const client = new FakeLeaseClient(POOL);
    const manager = makeManager(client);

    await expect(
      manager.withLease(ctx("tool-1"), async () => {
        throw new Error("tool blew up");
      }),
    ).rejects.toThrow("tool blew up");

    // No pod left leaked.
    for (const pod of POOL) {
      expect((await client.readLease(pod)).holderIdentity).toBeNull();
    }
  });
});
