import { describe, it, expect, beforeAll } from "vitest";
import { CoordinationV1Api, CoreV1Api, Exec, KubeConfig } from "@kubernetes/client-node";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { LeaseManager } from "../../src/lease/LeaseManager.js";
import { K8sLeaseClient } from "../../src/kube/KubeLeaseClient.js";
import { KubeExecutor } from "../../src/kube/KubeExecutor.js";
import { SandboxToolRunner } from "../../src/sandbox/SandboxToolRunner.js";
import { RealPiClient } from "../../src/pi/RealPiClient.js";

/**
 * Pi-backed smoke test (assignment requirement #11). Exercises the REAL Pi SDK
 * agent loop end-to-end: a chat message that drives a tool call which executes
 * inside a real leased sandbox pod via pods/exec.
 *
 * Requires: a running kind cluster with manifests applied AND valid Pi credentials
 * (e.g. ANTHROPIC_API_KEY). Enable with RUN_INTEGRATION=1.
 */
const ENABLED = process.env.RUN_INTEGRATION === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!ENABLED)("Pi-backed sandbox smoke test", () => {
  let piClient: RealPiClient;

  beforeAll(() => {
    const config = loadConfig();
    const logger = createLogger("info");
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const leaseClient = new K8sLeaseClient(kc.makeApiClient(CoordinationV1Api), config.namespace);
    const executor = new KubeExecutor(new Exec(kc), config.namespace);
    void kc.makeApiClient(CoreV1Api); // ensure core client constructs
    const leaseManager = new LeaseManager({
      client: leaseClient,
      pods: config.podNames,
      serviceInstanceId: config.serviceInstanceId,
      leaseTtlSeconds: config.leaseTtlSeconds,
      maxQueueWaitMs: config.maxQueueWaitMs,
    });
    const runner = new SandboxToolRunner({
      leaseManager,
      executor,
      namespace: config.namespace,
      container: config.container,
      fsRoot: config.fsRoot,
      toolTimeoutMs: config.toolTimeoutMs,
    });
    piClient = new RealPiClient(config, runner, logger);
  });

  it("runs a chat that triggers a sandbox tool call", async () => {
    const result = await piClient.runChat({
      sessionId: "smoke-1",
      requestId: "smoke-req-1",
      message:
        "Use the shell.run tool to run `ls` in the sandbox, then tell me what files you see.",
    });

    expect(result.toolCalls.length).toBeGreaterThan(0);
    const toolCall = result.toolCalls[0];
    expect(toolCall.pod).toMatch(/^sandbox-runner-\d$/);
    expect(toolCall.status).toBe("completed");
    expect(result.message.length).toBeGreaterThan(0);
  }, 60_000);
});
