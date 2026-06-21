import { PassThrough } from "node:stream";
import type { Exec, V1Status } from "@kubernetes/client-node";
import { type Executor, type ExecRequest, type ExecResult } from "../sandbox/types.js";

/**
 * Real Executor backed by Kubernetes pods/exec (ADR-0002). Streams stdout/stderr
 * from the exec channel and resolves with the command's exit code. A client-side
 * deadline guards against a hung connection; commands are *also* wrapped in
 * `timeout` pod-side by the caller so the process is killed even if we give up.
 */
export class KubeExecutor implements Executor {
  constructor(
    private readonly k8sExec: Exec,
    private readonly namespace: string,
  ) {}

  async exec(req: ExecRequest): Promise<ExecResult> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let errOut = "";
    stdout.on("data", (c) => (out += c.toString()));
    stderr.on("data", (c) => (errOut += c.toString()));

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        finish({ stdout: out, stderr: errOut || "client deadline exceeded", exitCode: 124, timedOut: true });
      }, req.timeoutMs + 1000); // grace over the pod-side `timeout`

      this.k8sExec
        .exec(
          this.namespace,
          req.pod,
          req.container,
          req.argv,
          stdout,
          stderr,
          null,
          false,
          (status: V1Status) => {
            // status.status === "Success" => exit 0; otherwise parse exit code.
            const exitCode = parseExitCode(status);
            finish({ stdout: out, stderr: errOut, exitCode, timedOut: exitCode === 124 });
          },
        )
        .then((ws) => {
          ws.on("error", (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
        })
        .catch(fail);
    });
  }
}

/** Extract a process exit code from a V1Status returned by pods/exec. */
function parseExitCode(status: V1Status): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  if (cause?.message) {
    const n = Number(cause.message);
    if (Number.isFinite(n)) return n;
  }
  return 1;
}
