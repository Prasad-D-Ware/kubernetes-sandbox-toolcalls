import { describe, it, expect } from "vitest";
import { PoolStateReader } from "../../src/kube/PoolStateReader.js";
import { FakeLeaseClient } from "../support/fakeLeaseClient.js";

const POOL = ["sandbox-runner-0", "sandbox-runner-1"];

describe("PoolStateReader", () => {
  it("reports free vs leased status reflecting current Lease state", async () => {
    const client = new FakeLeaseClient(POOL);
    const renew = new Date().toISOString();
    client.forceHeld("sandbox-runner-1", "api-1:req-123:session-abc:tool-xyz", renew, 45);

    const reader = new PoolStateReader({
      leaseClient: client,
      pods: POOL,
      // All pods reported ready by the fake readiness probe.
      podReadiness: async () => new Map(POOL.map((p) => [p, true])),
      now: () => new Date(renew).getTime(),
    });

    const state = await reader.read();

    const free = state.pods.find((p) => p.name === "sandbox-runner-0")!;
    expect(free.ready).toBe(true);
    expect(free.lease.status).toBe("free");

    const leased = state.pods.find((p) => p.name === "sandbox-runner-1")!;
    expect(leased.lease.status).toBe("leased");
    expect(leased.lease.holderIdentity).toBe("api-1:req-123:session-abc:tool-xyz");
    expect(leased.lease.expiresAt).toBe(new Date(new Date(renew).getTime() + 45_000).toISOString());
  });

  it("reports an expired lease as free (recoverable)", async () => {
    const client = new FakeLeaseClient(POOL);
    const staleRenew = new Date(Date.now() - 100_000).toISOString();
    client.forceHeld("sandbox-runner-0", "api-dead:r:s:t", staleRenew, 45);

    const reader = new PoolStateReader({
      leaseClient: client,
      pods: POOL,
      podReadiness: async () => new Map(POOL.map((p) => [p, true])),
    });

    const state = await reader.read();
    expect(state.pods.find((p) => p.name === "sandbox-runner-0")!.lease.status).toBe("free");
  });
});
