/** A request to run a command inside a leased sandbox pod. */
export interface ExecRequest {
  pod: string;
  container: string;
  /** argv executed directly (no shell) inside the pod. */
  argv: string[];
  /** Hard client-side deadline; the command is also wrapped in `timeout` pod-side. */
  timeoutMs: number;
}

/** The outcome of running a command inside a pod. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** The seam over Kubernetes pods/exec. Real impl wraps @kubernetes/client-node Exec. */
export interface Executor {
  exec(req: ExecRequest): Promise<ExecResult>;
}

export type ToolStatus = "completed" | "failed" | "timed_out";

/** Normalized result of a single tool call, surfaced as toolCalls[] metadata + to the LLM. */
export interface ToolResult {
  toolCallId: string;
  tool: string;
  pod: string | null;
  status: ToolStatus;
  output: string;
  errorCode?: string;
}

export class ToolExecutionTimeoutError extends Error {
  public readonly code = "tool_execution_timeout";
  constructor(public readonly timeoutMs: number) {
    super(`tool execution exceeded ${Math.round(timeoutMs / 1000)}s`);
    this.name = "ToolExecutionTimeoutError";
  }
}
