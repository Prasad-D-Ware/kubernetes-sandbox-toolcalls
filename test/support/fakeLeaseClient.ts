import type { KubeLeaseClient, LeaseRecord, LeaseSpec } from "../../src/lease/types.js";
import { LeaseConflictError } from "../../src/lease/types.js";

/**
 * In-memory fake of the Kubernetes coordination.k8s.io Lease API surface we use.
 *
 * It faithfully simulates the one property our concurrency design depends on:
 * optimistic concurrency via resourceVersion. `replaceLease` only succeeds if the
 * caller passes the current resourceVersion; otherwise it throws LeaseConflictError
 * (the equivalent of an HTTP 409 from the real API server).
 */
export class FakeLeaseClient implements KubeLeaseClient {
  private leases = new Map<string, LeaseRecord>();
  /** Counts conflicts thrown, for assertions. */
  public conflicts = 0;

  constructor(podNames: string[]) {
    for (const name of podNames) {
      this.leases.set(name, {
        name,
        holderIdentity: null,
        acquireTime: null,
        renewTime: null,
        leaseDurationSeconds: null,
        resourceVersion: "1",
      });
    }
  }

  async readLease(name: string): Promise<LeaseRecord> {
    const lease = this.leases.get(name);
    if (!lease) throw new Error(`lease not found: ${name}`);
    // Hand back a copy so callers can't mutate our store directly.
    return { ...lease };
  }

  async listLeases(): Promise<LeaseRecord[]> {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }

  async replaceLease(name: string, spec: LeaseSpec, expectedResourceVersion: string): Promise<LeaseRecord> {
    const current = this.leases.get(name);
    if (!current) throw new Error(`lease not found: ${name}`);
    if (current.resourceVersion !== expectedResourceVersion) {
      this.conflicts += 1;
      throw new LeaseConflictError(name, expectedResourceVersion, current.resourceVersion);
    }
    const next: LeaseRecord = {
      name,
      holderIdentity: spec.holderIdentity,
      acquireTime: spec.acquireTime,
      renewTime: spec.renewTime,
      leaseDurationSeconds: spec.leaseDurationSeconds,
      resourceVersion: String(Number(current.resourceVersion) + 1),
    };
    this.leases.set(name, next);
    return { ...next };
  }

  /** Test helper: force a lease into a held state without going through acquire. */
  forceHeld(name: string, holderIdentity: string, renewTime: string, leaseDurationSeconds: number): void {
    const current = this.leases.get(name);
    if (!current) throw new Error(`lease not found: ${name}`);
    this.leases.set(name, {
      ...current,
      holderIdentity,
      acquireTime: renewTime,
      renewTime,
      leaseDurationSeconds,
      resourceVersion: String(Number(current.resourceVersion) + 1),
    });
  }
}
