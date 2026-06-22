# Pi Agent with Kubernetes-Leased Sandbox Execution

A TypeScript backend that runs a chat agent on the **real Pi TypeScript SDK**
(`@earendil-works/pi-coding-agent`). The agent replies normally, but whenever the LLM
calls a tool, that tool executes inside a **Kubernetes sandbox pod** that is leased
just-in-time, locked while the tool runs, and released the instant it finishes, fails,
or times out.

The service owns a fixed pool of **8 warm sandbox pods**. Pods are never permanently
assigned to a user or session; a Kubernetes `Lease` is the source of truth for locking.

- Tool execution mechanism: **`pods/exec`** (see [tradeoff](#tool-execution-podsexec-vs-in-pod-runner)).
- Lock: **`coordination.k8s.io/v1` Lease** per pod, with optimistic concurrency.
- Overflow: **process-local bounded FIFO queue**, 15s max wait, then `sandbox_capacity_timeout`.
- A live **ops dashboard** at `http://localhost:3000/` visualizes the pool, task→pod
  assignment, queue dynamics, and metrics — and can drive demo load (see [§12](#12-ops-dashboard)).

> Design rationale lives in Architecture Decision Records under `docs/adr/` (kept local;
> the key tradeoffs are summarized in this README).

---

## Evaluate in 5 minutes

Prerequisites: **Node ≥ 20**, **Docker** (running), **kubectl**, **kind**, and one LLM
provider key (OpenAI or Anthropic — see [Configure credentials](#10-configure-real-pi-sdk-credentials)).

```bash
# 1. install + credentials
npm install --ignore-scripts
cp .env.example .env          # set OPENAI_API_KEY=... and PI_MODEL=gpt-4o-mini

# 2. fast offline checks — no cluster, no credentials needed
npm test                      # 74 unit tests (lease/queue/cleanup, allowlists, HTTP, dashboard)

# 3. stand up the cluster (8 pods + 8 leases) and run the service
bash scripts/setup-kind.sh
npm run dev                   # API + dashboard on http://localhost:3000/

# 4. full integration incl. the real Pi-backed smoke test (needs the cluster + key)
RUN_INTEGRATION=1 npm run test:integration

# 5. see it work: open the dashboard, then either click "▶ launch burst"
#    or run the script below, and watch the pool / queue / task→pod table react
bash scripts/demo-9-concurrent.sh
```

Open **http://localhost:3000/** while step 5 runs. To see the FIFO queue and capacity
timeout on screen, set the dashboard **hold** to `20s` and **conc** to `9`, then launch.

---

## Contents

- [Evaluate in 5 minutes](#evaluate-in-5-minutes)
- [Architecture at a glance](#architecture-at-a-glance)
1. [Run locally](#1-run-locally)
2. [Create the local Kubernetes cluster](#2-create-the-local-kubernetes-cluster)
3. [Apply manifests](#3-apply-manifests)
4. [Run the API service](#4-run-the-api-service)
5. [Run tests](#5-run-tests)
6. [Call `/chat` with curl](#6-call-chat-with-curl)
7. [How the Lease model works](#7-how-the-lease-model-works)
8. [How the FIFO queue and max wait work](#8-how-the-fifo-queue-and-max-wait-work)
9. [How timeouts and cleanup work](#9-how-timeouts-and-cleanup-work)
10. [Configure real Pi SDK credentials](#10-configure-real-pi-sdk-credentials)
- [9 concurrent tool calls example](#9-concurrent-tool-calls-example)
12. [Ops dashboard](#12-ops-dashboard)
- [Tool execution: pods/exec vs in-pod runner](#tool-execution-podsexec-vs-in-pod-runner)
- [Security](#security)
11. [What would change in production](#11-what-would-change-in-production)

---

## Architecture at a glance

```
POST /chat ─▶ Express (requestId + pino logger)
                 │
                 ▼
            RealPiClient.runChat()  ── @earendil-works/pi-coding-agent
                 │  createAgentSession({ customTools: [shell.run, fs.read, env.inspect] })
                 │  session.prompt(message)
                 ▼
            tool.execute()         ◀── the single Pi⇄Kubernetes junction
                 ▼
        SandboxToolRunner.run()    ── allowlist validation
                 ▼
        LeaseManager.withLease()   ── acquire (CAS on resourceVersion, 409→retry/next)
                 │                     FIFO queue (15s) when all 8 busy
                 │                     release in finally{} (success|fail|timeout|cancel|error)
                 ▼
        KubeExecutor.exec()        ── pods/exec, command wrapped in `timeout 30s`
                 ▼
        sandbox-runner-0..7        ── StatefulSet, minimal hardened image
```

| Endpoint | Purpose |
|----------|---------|
| `POST /chat` | Run a chat request + any tool calls; returns final message + `toolCalls[]`. |
| `GET /pods` | Current pool state derived from Lease objects + pod readiness. |
| `GET /health` | Service health: K8s connectivity + ready sandbox pod count. |
| `GET /` | The live **ops dashboard** (static page). |
| `GET /metrics` | JSON snapshot the dashboard seeds from (pool, counters, latency, task→pod). |
| `GET /events` | Server-Sent Events stream of every lifecycle event (drives the dashboard). |
| `POST /demo/run` | Drive demo load: fire N concurrent tool-calling chats + set the lease hold. |

The dashboard, metrics, and event stream are **pure consumers of the structured logs** the
service already emits — no existing logic was changed to add them.

---

## 1. Run locally

Prerequisites: **Node ≥ 20**, **Docker**, **kubectl**, and **kind**.

```bash
npm install --ignore-scripts        # --ignore-scripts: skip a native dep's postinstall
cp .env.example .env                 # then add a provider key (see §10)
```

> `--ignore-scripts` is recommended by Pi itself; one transitive dependency has a native
> build step we don't need.

End-to-end happy path:

```bash
bash scripts/setup-kind.sh           # create cluster + apply manifests + wait Ready
npm run dev                          # run the API on :3000 against the cluster
```

## 2. Create the local Kubernetes cluster

```bash
kind create cluster --name pi-sandbox
# or just run scripts/setup-kind.sh which does this plus everything below
```

The API connects via your default kubeconfig when run on the host, or via the in-cluster
ServiceAccount when deployed as the `pi-api` Deployment.

## 3. Apply manifests

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/10-rbac.yaml
kubectl apply -f k8s/20-leases.yaml
kubectl apply -f k8s/30-sandbox-statefulset.yaml
kubectl -n pi-sandbox rollout status statefulset/sandbox-runner --timeout=120s
```

This creates the namespace, scoped RBAC, **8 Lease objects**, and the **8 sandbox pods**
(`sandbox-runner-0 .. sandbox-runner-7`). The API Deployment/Service (`k8s/40-api.yaml`)
is optional for the local demo — running the API on your host is simpler.

## 4. Run the API service

```bash
npm run dev          # tsx watch, reads .env
# or
npm run build && npm start
```

This serves the API **and** the ops dashboard on `http://localhost:3000/`. If no provider
credential is set, the service **fails fast at startup** with a clear message and a non-zero
exit — there is no mock fallback.

## 5. Run tests

```bash
npm test                 # fast unit tests (no cluster, no credentials)
npm run test:integration # real-cluster + Pi-backed tests (see below)
```

Unit tests cover the full lease/queue/cleanup state machine, the security allowlists,
the tool runner, the pool-state reader, the HTTP API, and the dashboard metrics store —
**74 tests**, including a real 8-way concurrency pressure test. They run offline in ~1s.

Integration tests are guarded by `RUN_INTEGRATION=1` and need a running kind cluster
(and, for the Pi smoke test, a provider key):

```bash
bash scripts/setup-kind.sh
RUN_INTEGRATION=1 ANTHROPIC_API_KEY=sk-ant-... npm run test:integration
```

Required-behavior coverage:

| # | Behavior | Test |
|---|----------|------|
| 1 | Acquire a free pod | `test/lease/leaseManager.test.ts` |
| 2 | Release after success | `test/lease/leaseManager.test.ts` |
| 3 | Release after tool failure | `test/lease/leaseManager.test.ts`, `sandboxToolRunner.test.ts` |
| 4 | Release after timeout | `test/sandbox/sandboxToolRunner.test.ts` |
| 5 | Two concurrent calls never share a pod | `test/lease/concurrency.test.ts` |
| 6 | >8 concurrent → queue | `test/lease/queue.test.ts` |
| 7 | Queued call runs when a pod frees | `test/lease/queue.test.ts` |
| 8 | Queued call fails after max wait | `test/lease/queue.test.ts` |
| 9 | Expired-lease recovery | `test/lease/recovery.test.ts`, integration |
| 10 | `/pods` reflects lease state | `test/kube/poolStateReader.test.ts` |
| 11 | Real Pi SDK triggers sandbox exec | `test/integration/pi-smoke.integration.test.ts` |

## 6. Call `/chat` with curl

```bash
curl -s -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-123","message":"list the files in the sandbox"}' | jq
```

```json
{
  "sessionId": "session-123",
  "message": "The sandbox contains package.json and src/.",
  "toolCalls": [
    { "toolCallId": "tool-abc", "tool": "shell.run", "pod": "sandbox-runner-3", "status": "completed" }
  ]
}
```

Inspect the pool and health:

```bash
curl -s http://localhost:3000/pods   | jq
curl -s http://localhost:3000/health | jq
```

## 7. How the Lease model works

Each pod has a same-named `coordination.k8s.io/v1` **Lease**, which is the **only**
authoritative lock (pod annotations may mirror state for humans but are never the lock).

- **Holder identity:** `"<serviceInstanceId>:<requestId>:<sessionId>:<toolCallId>"`,
  e.g. `api-1:req-123:session-abc:tool-xyz` — enough to debug who holds what.
- **Acquire:** read a Lease, check it's acquirable, then `replace` it carrying the observed
  `resourceVersion`. Kubernetes **optimistic concurrency** means two racers can't both win:
  the loser gets HTTP **409** and we retry or try another pod. We never rely on in-memory
  locks for correctness.
- **Acquirable = free OR expired.** A Lease is acquirable if it has no holder *or* if
  `renewTime + leaseDurationSeconds` is in the past. Expiry is how we **recover after a
  crash**: if the API process dies holding a Lease, a future request reclaims the pod once
  the TTL (default 45s) elapses — no reaper, no manual cleanup.
- **Release:** set the Lease free again, `resourceVersion`-guarded so we never stomp a Lease
  we no longer own. Runs in a `finally` on success, tool failure, timeout, cancellation,
  and unexpected error.

Defaults: max queue wait **15s**, tool timeout **30s**, Lease TTL **45s** (TTL > tool
timeout so a healthy tool never needs renewal within assignment bounds).

## 8. How the FIFO queue and max wait work

When all 8 pods are busy, a tool call joins a **process-local bounded FIFO queue**:

1. The queue is process-local (single API replica — see [production](#11-what-would-change-in-production)).
2. It is strictly FIFO: waiters are served in arrival order by a single serialized "pump",
   so two waiters never race for the same pod.
3. Each queued call has a **15s** max wait.
4. If a pod frees up first (a release wakes the pump), the head waiter acquires it and runs.
5. Otherwise the call fails with a capacity timeout:

```json
{ "error": { "code": "sandbox_capacity_timeout", "message": "No sandbox pod became available within 15 seconds." } }
```

Why a process-local queue is acceptable here: with a single API replica, the in-process
queue observes *every* request, so FIFO ordering and the 8-pod capacity limit are globally
correct. The Lease layer still guards against any out-of-band contender (e.g. a recovering
crashed replica), so correctness never depends on the queue being distributed.

## 9. How timeouts and cleanup work

- **Tool execution timeout (30s):** every command is executed as `timeout 30s <cmd>` inside
  the pod, so a hung process is killed pod-side even if the exec stream is torn down. The
  executor additionally enforces a client-side deadline. On timeout the tool result is
  `timed_out` and the Lease is released.
- **Queue timeout (15s):** see above — `sandbox_capacity_timeout`.
- **Cleanup is unconditional:** `LeaseManager.withLease` releases in a `finally`, so the pod
  is freed on success, failure, timeout, cancellation, and unexpected error.
- **Crash recovery:** if the API crashes mid-tool, the Lease's TTL (45s) makes the pod
  acquirable again automatically.

## 10. Configure real Pi SDK credentials

The agent loop uses the real Pi SDK. Pi resolves a provider API key from the environment;
the service requires **one** of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`.

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
PI_MODEL=claude-sonnet-4-6
```

The injected key is set as Pi's runtime API key (highest priority), so no on-disk
`auth.json` is needed. Missing credentials → **hard startup failure** (`exit 1`), never a
mock. See `.env.example` for all settings.

For the in-cluster Deployment, supply the key via a Secret (never commit it):

```bash
kubectl -n pi-sandbox create secret generic pi-credentials \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...
```

## 9 concurrent tool calls example

With 8 pods, the 9th concurrent tool call must queue, then either acquire a freed pod or
time out.

The real tools (`ls`, `pwd`, …) run in ~30ms, so 8 pods absorb 9 staggered calls without
ever queueing. To make the queue and capacity timeout **observable live**, hold each lease a
bit longer (demo-only; default 0).

**Easiest — from the dashboard:** open `http://localhost:3000/`, set **conc** `9` and **hold**
`20s`, click **launch burst**. Watch 8 tiles go amber, the 9th log `queue.wait.started`, and a
red `capacity_timeout` row appear.

**Or from the CLI** via the `DEMO_TOOL_HOLD_MS` env (the same knob the dashboard sets):

```bash
# terminal 1: hold each lease 3s so 8 pods saturate
DEMO_TOOL_HOLD_MS=3000 npm run dev

# terminal 2: fire 9 concurrent tool-calling chats
bash scripts/demo-9-concurrent.sh
```

Now the logs show the 9th request queueing — `queue.wait.started` → `queue.wait.completed`
once a pod frees. Push it further (e.g. `DEMO_TOOL_HOLD_MS=20000`, which exceeds the 15s max
wait) and the later requests return the capacity timeout:

```json
{ "error": { "code": "sandbox_capacity_timeout", "message": "No sandbox pod became available within 15 seconds." } }
```

The deterministic proof of all three queue behaviors (queueing, FIFO hand-off on free, and
capacity timeout) lives in `test/lease/queue.test.ts` and runs in `npm test` with no cluster.

Watch the pool transition while it runs (macOS has no `watch`; use a loop):

```bash
while true; do clear; curl -s http://localhost:3000/pods \
  | jq -c '.pods[] | {name, status: .lease.status}'; sleep 0.3; done
```

## 12. Ops dashboard

A live operations dashboard ships with the service at **`http://localhost:3000/`** (no build,
no separate app — one static page served by the same Express process). It is the fastest way
to *see* the system work and the recommended surface for a demo.

It shows:

- **Sandbox pool** — 8 instrument tiles, lit amber while leased, with the holder
  (`session:tool`), TTL countdown, and per-pod calls-served. Click a tile to inspect that
  pod's recent calls.
- **Telemetry** — a segmented utilization bar (busy/8), tool-call / queue / latency /
  conflict readouts, and a utilization sparkline.
- **Event feed** — the live, color-coded lifecycle stream (`lease.acquired`,
  `tool.execution.*`, `queue.wait.*`, …); filter by `lease / tool / queue / errors`.
- **Tool Call → Pod** — exactly which call ran on which pod, with status and timing; click a
  row to expand the command, request id, holder, queue wait, and exec duration.

It can also **drive load**: the launch deck fires N concurrent tool-calling chats and tunes
the lease hold (`POST /demo/run`), so a recording needs no terminal.

How it works: the dashboard, `GET /metrics`, and the `GET /events` SSE stream are **pure
consumers of the structured logs** the service already emits — a pino multistream tap feeds an
in-process event bus that drives the live stream and an in-memory metrics store. No existing
lease/queue/tool code was modified to add observability.

## Tool execution: pods/exec vs in-pod runner

We run tools via Kubernetes **`pods/exec`** rather than an HTTP tool-runner inside each pod.

| | `pods/exec` (chosen) | In-pod HTTP runner |
|---|---|---|
| Code/artifacts | None extra | A second app + image + Service + probes |
| Latency / scale | API server in the hot path | Pod-to-pod, control plane decoupled |
| Timeout/cancel | `timeout 30s` wrapper kills pod-side | Server owns the PID (but you build it) |
| RBAC | needs `create pods/exec` | no exec RBAC, but adds a listener to lock down |
| Production fit | quick path | what real sandboxes use |

**Why exec here:** the runner's only real wins (lower latency, control-plane decoupling)
are dormant on a single-replica local demo, while it would cost an entire extra application
to build and test inside the time budget. We keep equivalent timeout safety with the
`timeout` wrapper and enforce the command allowlist API-side. **In production we would
migrate** to an in-pod runner (or per-call ephemeral pods) + a NetworkPolicy and drop
`pods/exec`. Full analysis: `docs/adr/0002-tool-execution-mechanism.md`.

## Security

This is not production-grade security, but it avoids obvious unsafe behavior:

- **No arbitrary shell execution.** `shell.run` uses a strict allowlist (`pwd`, `ls`, `cat`,
  `node --version`, `whoami`); shell metacharacters (`; | & \` $ ( ) < >` …) are rejected, so
  command chaining/substitution/redirection is impossible. `node` is restricted to `--version`.
- **Path allowlist for `fs.read`.** Absolute paths, `..` traversal, and anything escaping the
  sandbox root (`/workspace`) are rejected.
- **Namespace-scoped RBAC**, no cluster-admin, no cluster-wide permissions.
- **Pod hardening:** non-root (`runAsUser 1000`), `allowPrivilegeEscalation: false`, no
  privileged containers, `readOnlyRootFilesystem`, `capabilities: drop [ALL]`, no hostPath
  mounts, CPU/memory **resource limits**.
- **Network egress:** sandbox pods need no outbound network for the required tools; in
  production they should be isolated with a default-deny `NetworkPolicy` (documented below).

## 11. What would change in production

- **Process-local queue is insufficient for multiple API replicas.** Each replica has its own
  queue → no global FIFO/fairness and more Lease 409 churn. Move the queue out of process:
  a Redis-backed FIFO (Streams or list + `BRPOPLPUSH`), a real queue (NATS/SQS) feeding a
  scheduler, or a Kubernetes-native scheduler/operator. The Lease stays the lock.
- **Lease renewal for long-running tools.** Today tool timeout (30s) < TTL (45s), so no
  renewal is needed. For longer tools, run a heartbeat that periodically bumps `renewTime`
  while the tool runs, and shorten the TTL so crash recovery stays fast.
- **API process crashes** are handled by TTL-based expiry; in production shorten the TTL and
  add active renewal so stranded pods recover in seconds, plus liveness probes + restarts.
- **Execution history / audit.** Persist every tool call (who, what, pod, exit, duration,
  output hash) to an append-only store; emit audit events alongside the structured logs.
- **Pod image hardening.** Replace `node:20-alpine` with a pinned, minimal, distroless-style
  image scanned in CI; drop every binary not needed by the tools; read-only rootfs (already on).
- **Network isolation.** Default-deny `NetworkPolicy` for sandbox pods (no egress, ingress
  only from the API if a runner is used); if migrating to an in-pod runner, allow only API→runner.
- **Per-user / per-tenant limits.** Token-bucket rate limits and max concurrent leases per
  tenant; fair-share scheduling so one tenant can't starve the pool.
- **Metrics & alerts.** Export Prometheus metrics: pool utilization, queue depth + wait time
  histogram, capacity-timeout rate, lease conflict rate, tool latency/error rate, pod
  readiness. Alert on sustained saturation, rising capacity timeouts, and any pod NotReady.

## Observability

Structured (pino) JSON logs are emitted for every lifecycle event: chat request
started/completed, tool call requested, queue wait started/completed/timed out, lease
acquire attempted/acquired/conflict/released, and tool execution started/completed/failed/
timed out — each carrying `requestId`, `sessionId`, `toolCallId`, and `pod` where relevant.

```json
{ "level": "info", "event": "sandbox.lease.acquired", "requestId": "req-123",
  "sessionId": "session-abc", "toolCallId": "tool-xyz", "pod": "sandbox-runner-3",
  "leaseDurationSeconds": 45 }
```
