import { describe, it, expect, vi } from "vitest";
import { SandboxToolRunner } from "../../src/sandbox/SandboxToolRunner.js";
import { LeaseManager } from "../../src/lease/LeaseManager.js";
import { ToolExecutionTimeoutError } from "../../src/sandbox/types.js";
import { FakeLeaseClient } from "../support/fakeLeaseClient.js";
import { FakeExecutor } from "../support/fakeExecutor.js";

const POOL = ["sandbox-runner-0", "sandbox-runner-1"];

function setup(executor: FakeExecutor, opts: { demoHoldMs?: number } = {}) {
  const client = new FakeLeaseClient(POOL);
  const leaseManager = new LeaseManager({
    client,
    pods: POOL,
    serviceInstanceId: "api-test",
    leaseTtlSeconds: 45,
    maxQueueWaitMs: 1_000,
  });
  const runner = new SandboxToolRunner({
    leaseManager,
    executor,
    namespace: "pi-sandbox",
    container: "runner",
    fsRoot: "/workspace",
    toolTimeoutMs: 30_000,
    demoHoldMs: opts.demoHoldMs,
  });
  return { client, runner };
}

const ctx = { requestId: "req-1", sessionId: "session-1", toolCallId: "tool-1" };

async function allPodsFree(client: FakeLeaseClient): Promise<boolean> {
  const leases = await client.listLeases();
  return leases.every((l) => l.holderIdentity === null);
}

describe("SandboxToolRunner", () => {
  it("runs shell.run inside a leased pod and reports completed", async () => {
    const executor = FakeExecutor.ok("/workspace\n");
    const { client, runner } = setup(executor);

    const result = await runner.run("shell.run", { command: "pwd" }, ctx);

    expect(result.status).toBe("completed");
    expect(POOL).toContain(result.pod);
    expect(result.output).toContain("/workspace");
    // The argv actually sent to the pod is the allowlisted command, timeout-wrapped.
    expect(executor.calls[0].argv).toEqual(["timeout", "30s", "pwd"]);
    expect(await allPodsFree(client)).toBe(true); // released on success
  });

  it("rejects a non-allowlisted shell command without leasing a pod", async () => {
    const executor = FakeExecutor.ok("");
    const { client, runner } = setup(executor);

    const result = await runner.run("shell.run", { command: "rm -rf /" }, ctx);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("tool_input_rejected");
    expect(executor.calls).toHaveLength(0); // never reached the pod
    expect(await allPodsFree(client)).toBe(true);
  });

  it("releases the pod after a tool execution timeout", async () => {
    const executor = new FakeExecutor(() => {
      throw new ToolExecutionTimeoutError(30_000);
    });
    const { client, runner } = setup(executor);

    const result = await runner.run("shell.run", { command: "ls" }, ctx);

    expect(result.status).toBe("timed_out");
    expect(await allPodsFree(client)).toBe(true); // released despite timeout
  });

  it("builds a safe cat argv for fs.read and rejects traversal", async () => {
    const executor = FakeExecutor.ok("file contents");
    const { runner } = setup(executor);

    const ok = await runner.run("fs.read", { path: "src/index.ts" }, ctx);
    expect(ok.status).toBe("completed");
    expect(executor.calls[0].argv).toEqual(["timeout", "30s", "cat", "/workspace/src/index.ts"]);

    const bad = await runner.run("fs.read", { path: "../etc/passwd" }, ctx);
    expect(bad.status).toBe("failed");
    expect(bad.errorCode).toBe("tool_input_rejected");
  });

  it("keeps the pod leased during demoHoldMs, then releases", async () => {
    vi.useFakeTimers();
    try {
      const executor = FakeExecutor.ok("done");
      const { client, runner } = setup(executor, { demoHoldMs: 1_000 });

      const p = runner.run("shell.run", { command: "ls" }, ctx);
      // Let the exec resolve, but not the hold timer.
      await vi.advanceTimersByTimeAsync(0);
      const duringHold = await client.listLeases();
      expect(duringHold.some((l) => l.holderIdentity !== null)).toBe(true); // still held

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await p;
      expect(result.status).toBe("completed");
      const afterRelease = await client.listLeases();
      expect(afterRelease.every((l) => l.holderIdentity === null)).toBe(true); // released
    } finally {
      vi.useRealTimers();
    }
  });
});
