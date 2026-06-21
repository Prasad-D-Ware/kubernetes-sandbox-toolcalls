import { describe, it, expect } from "vitest";
import { LeaseManager } from "../../src/lease/LeaseManager.js";
import { FakeLeaseClient } from "../support/fakeLeaseClient.js";

const POOL = ["sandbox-runner-0"];

function makeManager(client: FakeLeaseClient) {
  return new LeaseManager({
    client,
    pods: POOL,
    serviceInstanceId: "api-test",
    leaseTtlSeconds: 45,
    maxQueueWaitMs: 1_000,
  });
}

describe("expired-lease recovery", () => {
  it("acquires a pod whose lease is held but expired (crashed holder)", async () => {
    const client = new FakeLeaseClient(POOL);
    // A previous service instance crashed holding this lease 100s ago with a 45s TTL.
    const staleRenew = new Date(Date.now() - 100_000).toISOString();
    client.forceHeld("sandbox-runner-0", "api-dead:req-old:session-old:tool-old", staleRenew, 45);

    const manager = makeManager(client);
    const lease = await manager.acquire({
      requestId: "req-new",
      sessionId: "session-new",
      toolCallId: "tool-new",
    });

    expect(lease.pod).toBe("sandbox-runner-0");
    const record = await client.readLease("sandbox-runner-0");
    expect(record.holderIdentity).toBe("api-test:req-new:session-new:tool-new");
  });

  it("does NOT acquire a pod whose lease is held and still valid", async () => {
    const client = new FakeLeaseClient(POOL);
    const freshRenew = new Date(Date.now()).toISOString();
    client.forceHeld("sandbox-runner-0", "api-other:req:session:tool", freshRenew, 45);

    const manager = makeManager(client);
    await expect(
      manager.acquire({ requestId: "r", sessionId: "s", toolCallId: "t" }),
    ).rejects.toMatchObject({ code: "sandbox_capacity_timeout" });
  });
});
