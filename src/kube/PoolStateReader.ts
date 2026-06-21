import type { KubeLeaseClient, LeaseRecord } from "../lease/types.js";

export interface PodLeaseView {
  status: "free" | "leased";
  holderIdentity?: string;
  expiresAt?: string;
}

export interface PodView {
  name: string;
  ready: boolean;
  lease: PodLeaseView;
}

export interface PoolState {
  pods: PodView[];
}

export interface PoolStateReaderOptions {
  leaseClient: KubeLeaseClient;
  pods: string[];
  /** Returns pod-name -> ready. Real impl reads pod status from the K8s API. */
  podReadiness: () => Promise<Map<string, boolean>>;
  now?: () => number;
}

/**
 * Computes the GET /pods view from the authoritative Lease state plus pod
 * readiness. An expired lease is reported as free (recoverable) — consistent
 * with the LeaseManager's acquire rule (ADR-0003).
 */
export class PoolStateReader {
  private readonly now: () => number;
  constructor(private readonly opts: PoolStateReaderOptions) {
    this.now = opts.now ?? Date.now;
  }

  private leaseView(lease: LeaseRecord | undefined): PodLeaseView {
    if (!lease || !lease.holderIdentity || !lease.renewTime || lease.leaseDurationSeconds == null) {
      return { status: "free" };
    }
    const expiresAtMs = new Date(lease.renewTime).getTime() + lease.leaseDurationSeconds * 1000;
    if (expiresAtMs < this.now()) return { status: "free" }; // expired -> recoverable
    return {
      status: "leased",
      holderIdentity: lease.holderIdentity,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async read(): Promise<PoolState> {
    const [leases, readiness] = await Promise.all([
      this.opts.leaseClient.listLeases(),
      this.opts.podReadiness(),
    ]);
    const byName = new Map(leases.map((l) => [l.name, l]));
    return {
      pods: this.opts.pods.map((name) => ({
        name,
        ready: readiness.get(name) ?? false,
        lease: this.leaseView(byName.get(name)),
      })),
    };
  }
}
