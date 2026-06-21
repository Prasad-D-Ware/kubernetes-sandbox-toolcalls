import type { Executor, ExecRequest, ExecResult } from "../../src/sandbox/types.js";

type Handler = (req: ExecRequest) => Promise<ExecResult> | ExecResult;

/** Scriptable executor for unit tests. Records every exec it received. */
export class FakeExecutor implements Executor {
  public readonly calls: ExecRequest[] = [];
  constructor(private handler: Handler) {}

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    return this.handler(req);
  }

  static ok(stdout: string): FakeExecutor {
    return new FakeExecutor(() => ({ stdout, stderr: "", exitCode: 0, timedOut: false }));
  }
}
