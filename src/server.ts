import {
  CoordinationV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
} from "@kubernetes/client-node";
import { loadConfig, MissingCredentialsError } from "./config.js";
import { createLogger } from "./logging.js";
import { LeaseManager } from "./lease/LeaseManager.js";
import { makeLeaseEventSink } from "./leaseEventSink.js";
import { K8sLeaseClient } from "./kube/KubeLeaseClient.js";
import { KubeExecutor } from "./kube/KubeExecutor.js";
import { PoolStateReader } from "./kube/PoolStateReader.js";
import { SandboxToolRunner } from "./sandbox/SandboxToolRunner.js";
import { RealPiClient } from "./pi/RealPiClient.js";
import { createApp, type HealthChecker } from "./http/app.js";

async function main() {
  const config = (() => {
    try {
      return loadConfig();
    } catch (err) {
      if (err instanceof MissingCredentialsError) {
        // Fail fast and loud — no mock fallback (ADR-0005).
        // eslint-disable-next-line no-console
        console.error(`\n[FATAL] ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
  })();

  const logger = createLogger(config.logLevel);

  // Kubernetes clients (in-cluster when running in a pod, else local kubeconfig).
  const kc = new KubeConfig();
  try {
    kc.loadFromDefault();
  } catch (err) {
    logger.error({ err: String(err) }, "failed to load kubeconfig");
    process.exit(1);
  }
  const coordinationApi = kc.makeApiClient(CoordinationV1Api);
  const coreApi = kc.makeApiClient(CoreV1Api);
  const exec = new Exec(kc);

  const leaseClient = new K8sLeaseClient(coordinationApi, config.namespace);
  const executor = new KubeExecutor(exec, config.namespace);

  const leaseManager = new LeaseManager({
    client: leaseClient,
    pods: config.podNames,
    serviceInstanceId: config.serviceInstanceId,
    leaseTtlSeconds: config.leaseTtlSeconds,
    maxQueueWaitMs: config.maxQueueWaitMs,
    events: makeLeaseEventSink(logger),
  });

  const runner = new SandboxToolRunner({
    leaseManager,
    executor,
    namespace: config.namespace,
    container: config.container,
    fsRoot: config.fsRoot,
    toolTimeoutMs: config.toolTimeoutMs,
    logger,
  });

  const piClient = new RealPiClient(config, runner, logger);

  const podReadiness = async (): Promise<Map<string, boolean>> => {
    const ready = new Map<string, boolean>();
    const list = await coreApi.listNamespacedPod({ namespace: config.namespace });
    for (const pod of list.items ?? []) {
      const name = pod.metadata?.name ?? "";
      const isReady = (pod.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
      ready.set(name, isReady);
    }
    return ready;
  };

  const poolStateReader = new PoolStateReader({
    leaseClient,
    pods: config.podNames,
    podReadiness,
  });

  const healthChecker: HealthChecker = {
    async check() {
      try {
        const readiness = await podReadiness();
        const sandboxPodsReady = config.podNames.filter((p) => readiness.get(p)).length;
        return { ok: true, kubernetes: "connected", sandboxPodsReady };
      } catch {
        return { ok: false, kubernetes: "disconnected", sandboxPodsReady: 0 };
      }
    },
  };

  const app = createApp({ piClient, poolStateReader, healthChecker, logger });
  app.listen(config.port, () => {
    logger.info(
      { event: "server.started", port: config.port, namespace: config.namespace, poolSize: config.poolSize, provider: config.provider, model: config.model },
      `pi-sandbox-service listening on :${config.port}`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error", err);
  process.exit(1);
});
