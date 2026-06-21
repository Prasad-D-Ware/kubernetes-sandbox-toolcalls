/** A snapshot of a Kubernetes coordination.k8s.io/v1 Lease, reduced to what we use. */
export interface LeaseRecord {
  name: string;
  holderIdentity: string | null;
  /** ISO-8601. */
  acquireTime: string | null;
  /** ISO-8601. */
  renewTime: string | null;
  leaseDurationSeconds: number | null;
  /** Kubernetes optimistic-concurrency token. */
  resourceVersion: string;
}

/** The mutable fields we write when claiming/releasing a Lease. */
export interface LeaseSpec {
  holderIdentity: string | null;
  acquireTime: string | null;
  renewTime: string | null;
  leaseDurationSeconds: number | null;
}

/**
 * The seam over the Kubernetes coordination API. The real impl wraps
 * @kubernetes/client-node CoordinationV1Api; tests use an in-memory fake.
 */
export interface KubeLeaseClient {
  readLease(name: string): Promise<LeaseRecord>;
  listLeases(): Promise<LeaseRecord[]>;
  /**
   * Compare-and-swap update. Must reject with LeaseConflictError when
   * expectedResourceVersion no longer matches the stored object (HTTP 409).
   */
  replaceLease(name: string, spec: LeaseSpec, expectedResourceVersion: string): Promise<LeaseRecord>;
}

/** Identifies who holds a lease: "<serviceInstanceId>:<requestId>:<sessionId>:<toolCallId>". */
export interface LeaseContext {
  requestId: string;
  sessionId: string;
  toolCallId: string;
}

/** A held lease handle returned by acquire(). */
export interface AcquiredLease {
  pod: string;
  holderIdentity: string;
  resourceVersion: string;
  ctx: LeaseContext;
}

/** Thrown by replaceLease when resourceVersion is stale (HTTP 409 equivalent). */
export class LeaseConflictError extends Error {
  constructor(
    public readonly leaseName: string,
    public readonly expectedResourceVersion: string,
    public readonly actualResourceVersion: string,
  ) {
    super(
      `lease ${leaseName} conflict: expected resourceVersion ${expectedResourceVersion}, got ${actualResourceVersion}`,
    );
    this.name = "LeaseConflictError";
  }
}

/** Thrown when no sandbox pod becomes available within the max queue wait. */
export class SandboxCapacityTimeoutError extends Error {
  public readonly code = "sandbox_capacity_timeout";
  constructor(maxQueueWaitMs: number) {
    super(`No sandbox pod became available within ${Math.round(maxQueueWaitMs / 1000)} seconds.`);
    this.name = "SandboxCapacityTimeoutError";
  }
}
