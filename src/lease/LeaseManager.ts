import {
  type AcquiredLease,
  type KubeLeaseClient,
  type LeaseContext,
  type LeaseRecord,
  LeaseConflictError,
  SandboxCapacityTimeoutError,
} from "./types.js";

interface Waiter {
  ctx: LeaseContext;
  resolve: (lease: AcquiredLease) => void;
  reject: (err: Error) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface LeaseManagerOptions {
  client: KubeLeaseClient;
  pods: string[];
  serviceInstanceId: string;
  leaseTtlSeconds: number;
  maxQueueWaitMs: number;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

export class LeaseManager {
  private readonly client: KubeLeaseClient;
  private readonly pods: string[];
  private readonly serviceInstanceId: string;
  private readonly leaseTtlSeconds: number;
  private readonly maxQueueWaitMs: number;
  private readonly now: () => number;

  /** Process-local FIFO queue of pending acquisitions (ADR-0004). */
  private readonly waiters: Waiter[] = [];
  private pumping = false;
  /** Set when a pump is requested while one is already running (e.g. a release
   * frees a pod mid-pump). Forces the running pump to make another pass so the
   * freed capacity is never missed. */
  private pumpAgain = false;

  constructor(opts: LeaseManagerOptions) {
    this.client = opts.client;
    this.pods = opts.pods;
    this.serviceInstanceId = opts.serviceInstanceId;
    this.leaseTtlSeconds = opts.leaseTtlSeconds;
    this.maxQueueWaitMs = opts.maxQueueWaitMs;
    this.now = opts.now ?? Date.now;
  }

  private holderIdentity(ctx: LeaseContext): string {
    return `${this.serviceInstanceId}:${ctx.requestId}:${ctx.sessionId}:${ctx.toolCallId}`;
  }

  /**
   * A pod is acquirable if its lease is free (no holder) OR expired — i.e. the
   * holder never renewed within the TTL (crash recovery). See ADR-0003.
   */
  private isAcquirable(lease: LeaseRecord, now: number): boolean {
    if (!lease.holderIdentity) return true;
    if (!lease.renewTime || lease.leaseDurationSeconds == null) return false;
    const expiresAt = new Date(lease.renewTime).getTime() + lease.leaseDurationSeconds * 1000;
    return expiresAt < now;
  }

  /**
   * Acquire a pod's lease. If a pod is free it is claimed immediately; otherwise
   * the request joins a bounded FIFO queue and waits up to maxQueueWaitMs before
   * failing with SandboxCapacityTimeoutError.
   */
  acquire(ctx: LeaseContext): Promise<AcquiredLease> {
    return new Promise<AcquiredLease>((resolve, reject) => {
      const waiter: Waiter = {
        ctx,
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new SandboxCapacityTimeoutError(this.maxQueueWaitMs));
        }, this.maxQueueWaitMs),
      };
      this.waiters.push(waiter);
      void this.pump();
    });
  }

  /**
   * Serially serve queued waiters in FIFO order. Claims are attempted one at a
   * time (guarded by `pumping`) so ordering is deterministic and two waiters
   * never race for the same pod. Triggered on every acquire and every release.
   */
  private async pump(): Promise<void> {
    if (this.pumping) {
      // A pump is already in flight; ask it to make another pass once it settles
      // so capacity freed during its awaits is not missed.
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (this.waiters.length > 0) {
          const waiter = this.waiters[0];
          if (waiter.settled) {
            this.waiters.shift();
            continue;
          }
          const claimed = await this.tryClaimAnyPod(waiter.ctx);
          if (!claimed) break; // no capacity right now; wait for a release or timeout
          if (waiter.settled) {
            // Waiter timed out while we were claiming — hand the pod back.
            await this.release(claimed);
            this.waiters.shift();
            continue;
          }
          waiter.settled = true;
          clearTimeout(waiter.timer);
          this.waiters.shift();
          waiter.resolve(claimed);
        }
      } while (this.pumpAgain && this.waiters.length > 0);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Acquire a pod, run `work` with it, and always release afterwards — on
   * success, failure, timeout, cancellation, or unexpected error.
   */
  async withLease<T>(ctx: LeaseContext, work: (pod: string) => Promise<T>): Promise<T> {
    const lease = await this.acquire(ctx);
    try {
      return await work(lease.pod);
    } finally {
      await this.release(lease);
    }
  }

  /**
   * Release a held lease back to free. Best-effort and resourceVersion-guarded:
   * if we no longer own the lease (e.g. it expired and was reclaimed), we do not
   * stomp the new holder. Must be safe to call on success, failure, timeout,
   * cancellation, and unexpected error.
   */
  async release(lease: AcquiredLease): Promise<void> {
    try {
      const current = await this.client.readLease(lease.pod);
      // Only release if we still own this exact lease version.
      if (current.holderIdentity !== lease.holderIdentity) return;
      await this.client.replaceLease(
        lease.pod,
        {
          holderIdentity: null,
          acquireTime: null,
          renewTime: new Date(this.now()).toISOString(),
          leaseDurationSeconds: null,
        },
        current.resourceVersion,
      );
    } catch (err) {
      if (!(err instanceof LeaseConflictError)) throw err;
      // someone else changed it; leave it alone
    } finally {
      // A pod may have freed up — wake the next queued waiter.
      void this.pump();
    }
  }

  /** One pass over the pool: claim the first acquirable pod, or return null. */
  private async tryClaimAnyPod(ctx: LeaseContext): Promise<AcquiredLease | null> {
    const holderIdentity = this.holderIdentity(ctx);
    const now = this.now();
    for (const pod of this.pods) {
      const lease = await this.client.readLease(pod);
      if (!this.isAcquirable(lease, now)) continue; // held and still valid — skip
      const nowIso = new Date(now).toISOString();
      try {
        const updated = await this.client.replaceLease(
          pod,
          {
            holderIdentity,
            acquireTime: nowIso,
            renewTime: nowIso,
            leaseDurationSeconds: this.leaseTtlSeconds,
          },
          lease.resourceVersion,
        );
        return { pod, holderIdentity, resourceVersion: updated.resourceVersion };
      } catch (err) {
        if (err instanceof LeaseConflictError) continue; // lost the race — try next
        throw err;
      }
    }
    return null;
  }
}
