import { ApiException, type CoordinationV1Api, type V1Lease } from "@kubernetes/client-node";
import { type KubeLeaseClient, type LeaseRecord, type LeaseSpec, LeaseConflictError } from "../lease/types.js";

/**
 * Kubernetes Lease acquireTime/renewTime are `MicroTime` — the API server's parser
 * requires microsecond precision (6 fractional digits). JS `Date.toISOString()`
 * emits milliseconds (3 digits), which the server rejects with HTTP 400. Pad to
 * microseconds. e.g. "2026-06-21T15:25:31.178Z" -> "2026-06-21T15:25:31.178000Z".
 */
export function toMicroTimeString(iso: string): string {
  return new Date(iso).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

/**
 * Real KubeLeaseClient backed by the Kubernetes coordination.k8s.io/v1 API.
 * Translates V1Lease <-> LeaseRecord and maps HTTP 409 to LeaseConflictError so
 * the LeaseManager's optimistic-concurrency retry logic stays K8s-agnostic.
 */
export class K8sLeaseClient implements KubeLeaseClient {
  constructor(
    private readonly api: CoordinationV1Api,
    private readonly namespace: string,
  ) {}

  private toRecord(lease: V1Lease): LeaseRecord {
    const spec = lease.spec ?? {};
    const toIso = (t: Date | string | undefined): string | null =>
      t == null ? null : t instanceof Date ? t.toISOString() : new Date(t).toISOString();
    return {
      name: lease.metadata?.name ?? "",
      holderIdentity: spec.holderIdentity ?? null,
      acquireTime: toIso(spec.acquireTime as Date | undefined),
      renewTime: toIso(spec.renewTime as Date | undefined),
      leaseDurationSeconds: spec.leaseDurationSeconds ?? null,
      resourceVersion: lease.metadata?.resourceVersion ?? "",
    };
  }

  async readLease(name: string): Promise<LeaseRecord> {
    const lease = await this.api.readNamespacedLease({ name, namespace: this.namespace });
    return this.toRecord(lease);
  }

  async listLeases(): Promise<LeaseRecord[]> {
    const list = await this.api.listNamespacedLease({ namespace: this.namespace });
    return (list.items ?? []).map((l) => this.toRecord(l));
  }

  async replaceLease(name: string, spec: LeaseSpec, expectedResourceVersion: string): Promise<LeaseRecord> {
    const body: V1Lease = {
      metadata: { name, resourceVersion: expectedResourceVersion },
      spec: {
        holderIdentity: spec.holderIdentity ?? undefined,
        // Send MicroTime as a microsecond-precision string (cast: the typed field
        // is Date, but the serializer passes MicroTime through unchanged).
        acquireTime: (spec.acquireTime ? toMicroTimeString(spec.acquireTime) : undefined) as unknown as Date,
        renewTime: (spec.renewTime ? toMicroTimeString(spec.renewTime) : undefined) as unknown as Date,
        leaseDurationSeconds: spec.leaseDurationSeconds ?? undefined,
      },
    };
    try {
      const updated = await this.api.replaceNamespacedLease({ name, namespace: this.namespace, body });
      return this.toRecord(updated);
    } catch (err) {
      if (err instanceof ApiException && err.code === 409) {
        throw new LeaseConflictError(name, expectedResourceVersion, "stale");
      }
      throw err;
    }
  }
}
