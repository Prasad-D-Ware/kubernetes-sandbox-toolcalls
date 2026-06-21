import { describe, it, expect, beforeAll } from "vitest";
import { CoordinationV1Api, KubeConfig } from "@kubernetes/client-node";
import { K8sLeaseClient } from "../../src/kube/KubeLeaseClient.js";
import { LeaseManager } from "../../src/lease/LeaseManager.js";

/**
 * Integration tests against a real local Kubernetes cluster (kind).
 * Requires: `bash scripts/setup-kind.sh` first, then RUN_INTEGRATION=1.
 * These exercise the real coordination.k8s.io Lease API and optimistic concurrency.
 */
const ENABLED = process.env.RUN_INTEGRATION === "1";
const NS = process.env.SANDBOX_NAMESPACE ?? "pi-sandbox";
const POOL = Array.from({ length: 8 }, (_, i) => `sandbox-runner-${i}`);

describe.skipIf(!ENABLED)("lease manager against real Kubernetes", () => {
  let manager: LeaseManager;
  let client: K8sLeaseClient;

  beforeAll(() => {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    client = new K8sLeaseClient(kc.makeApiClient(CoordinationV1Api), NS);
    manager = new LeaseManager({
      client,
      pods: POOL,
      serviceInstanceId: "itest",
      leaseTtlSeconds: 45,
      maxQueueWaitMs: 15_000,
    });
  });

  it("acquires and releases a real Lease", async () => {
    const lease = await manager.acquire({ requestId: "it-req", sessionId: "it-s", toolCallId: "it-t" });
    expect(POOL).toContain(lease.pod);
    const held = await client.readLease(lease.pod);
    expect(held.holderIdentity).toBe("itest:it-req:it-s:it-t");

    await manager.release(lease);
    const freed = await client.readLease(lease.pod);
    expect(freed.holderIdentity).toBeNull();
  });

  it("8 concurrent acquisitions claim 8 distinct real pods", async () => {
    const leases = await Promise.all(
      POOL.map((_, i) => manager.acquire({ requestId: `it-${i}`, sessionId: "it", toolCallId: `t-${i}` })),
    );
    try {
      expect(new Set(leases.map((l) => l.pod)).size).toBe(8);
    } finally {
      await Promise.all(leases.map((l) => manager.release(l)));
    }
  });
});
