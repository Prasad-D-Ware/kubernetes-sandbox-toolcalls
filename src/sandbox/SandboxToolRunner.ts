import type { LeaseManager } from "../lease/LeaseManager.js";
import type { LeaseContext } from "../lease/types.js";
import { type AppLogger, LogEvent } from "../logging.js";
import { resolveSandboxPath, validateShellCommand, ToolValidationError } from "../tools/allowlist.js";
import { type Executor, type ToolResult, ToolExecutionTimeoutError } from "./types.js";

export interface SandboxToolRunnerOptions {
  leaseManager: LeaseManager;
  executor: Executor;
  namespace: string;
  container: string;
  fsRoot: string;
  toolTimeoutMs: number;
  /** Optional structured logger for tool.execution.* events. */
  logger?: AppLogger;
  /** Demo-only: hold the lease this many ms after exec, to make the FIFO queue /
   * capacity timeout observable live with fast tools. Default 0. A function lets
   * the value change at runtime (the dashboard tunes it via /demo/run). */
  demoHoldMs?: number | (() => number);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const SANDBOX_TOOL_NAMES = ["shell.run", "fs.read", "env.inspect"] as const;
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

/**
 * Validates a tool call's input against the allowlist, then runs it inside a
 * just-in-time leased pod via the executor. Always releases the lease (the
 * LeaseManager.withLease finally), on success, failure, or timeout.
 */
export class SandboxToolRunner {
  constructor(private readonly opts: SandboxToolRunnerOptions) {}

  /** Build the argv to exec for a given tool + params (throws ToolValidationError). */
  private buildArgv(tool: SandboxToolName, params: Record<string, unknown>): string[] {
    switch (tool) {
      case "shell.run": {
        const command = String(params.command ?? "");
        return validateShellCommand(command);
      }
      case "fs.read": {
        const requested = String(params.path ?? "");
        if (!requested) throw new ToolValidationError("fs.read requires a path");
        return ["cat", resolveSandboxPath(this.opts.fsRoot, requested)];
      }
      case "env.inspect": {
        // Our own fixed inspection script — no user input is interpolated.
        return [
          "sh",
          "-c",
          'printf "cwd=%s\\nuser=%s\\nnode=%s\\n" "$(pwd)" "$(whoami)" "$(node --version 2>/dev/null || echo none)"',
        ];
      }
      default:
        throw new ToolValidationError(`unknown tool: ${tool}`);
    }
  }

  async run(
    tool: string,
    params: Record<string, unknown>,
    ctx: LeaseContext,
  ): Promise<ToolResult> {
    if (!SANDBOX_TOOL_NAMES.includes(tool as SandboxToolName)) {
      return { toolCallId: ctx.toolCallId, tool, pod: null, status: "failed", output: `unknown tool: ${tool}`, errorCode: "tool_input_rejected" };
    }
    const toolName = tool as SandboxToolName;

    let argv: string[];
    try {
      argv = this.buildArgv(toolName, params);
    } catch (err) {
      if (err instanceof ToolValidationError) {
        // Input rejected before any pod is leased.
        return { toolCallId: ctx.toolCallId, tool, pod: null, status: "failed", output: err.message, errorCode: err.code };
      }
      throw err;
    }

    const timeoutSeconds = Math.max(1, Math.round(this.opts.toolTimeoutMs / 1000));
    const wrappedArgv = ["timeout", `${timeoutSeconds}s`, ...argv];

    const log = this.opts.logger;
    const logBase = { requestId: ctx.requestId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId, tool };
    try {
      return await this.opts.leaseManager.withLease(ctx, async (pod) => {
        log?.info({ event: LogEvent.ToolExecutionStarted, ...logBase, pod }, "tool execution started");
        const exec = await this.opts.executor.exec({
          pod,
          container: this.opts.container,
          argv: wrappedArgv,
          timeoutMs: this.opts.toolTimeoutMs,
        });
        // Demo-only artificial hold so fast tools can still saturate the pool.
        const holdMs = typeof this.opts.demoHoldMs === "function" ? this.opts.demoHoldMs() : this.opts.demoHoldMs;
        if (holdMs && holdMs > 0) await delay(holdMs);
        // `timeout` exits 124 when it kills the command.
        if (exec.timedOut || exec.exitCode === 124) {
          log?.warn({ event: LogEvent.ToolExecutionTimedOut, ...logBase, pod }, "tool execution timed out");
          return { toolCallId: ctx.toolCallId, tool, pod, status: "timed_out" as const, output: exec.stderr || "tool timed out", errorCode: "tool_execution_timeout" };
        }
        const status = exec.exitCode === 0 ? ("completed" as const) : ("failed" as const);
        if (status === "completed") {
          log?.info({ event: LogEvent.ToolExecutionCompleted, ...logBase, pod }, "tool execution completed");
        } else {
          log?.warn({ event: LogEvent.ToolExecutionFailed, ...logBase, pod, exitCode: exec.exitCode }, "tool execution failed");
        }
        return {
          toolCallId: ctx.toolCallId,
          tool,
          pod,
          status,
          output: exec.exitCode === 0 ? exec.stdout : exec.stderr || exec.stdout,
          ...(status === "failed" ? { errorCode: "tool_execution_failed" } : {}),
        };
      });
    } catch (err) {
      if (err instanceof ToolExecutionTimeoutError) {
        log?.warn({ event: LogEvent.ToolExecutionTimedOut, ...logBase }, "tool execution timed out");
        return { toolCallId: ctx.toolCallId, tool, pod: null, status: "timed_out", output: err.message, errorCode: err.code };
      }
      throw err;
    }
  }
}
