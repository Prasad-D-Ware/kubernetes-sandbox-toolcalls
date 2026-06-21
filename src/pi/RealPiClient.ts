import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { AppConfig } from "../config.js";
import type { SandboxToolName } from "../sandbox/SandboxToolRunner.js";
import type { AppLogger } from "../logging.js";
import { LogEvent } from "../logging.js";
import type { SandboxToolRunner } from "../sandbox/SandboxToolRunner.js";
import { SandboxCapacityTimeoutError } from "../lease/types.js";
import type { ToolResult } from "../sandbox/types.js";
import type { ChatInput, ChatResult, PiClient, ToolCallMeta } from "./types.js";

interface SandboxToolSpec {
  /** Name registered with the LLM provider. Must match OpenAI's ^[a-zA-Z0-9_-]+$. */
  llmName: string;
  /** Canonical (assignment) name used for validation + toolCalls[] metadata. */
  canonical: SandboxToolName;
  label: string;
  description: string;
  parameters: TSchema;
}

/**
 * Tool registry. The LLM sees dot-free names (OpenAI rejects dots in tool names);
 * everything internal/observable uses the canonical dotted names from the spec.
 */
export const SANDBOX_TOOL_SPECS: SandboxToolSpec[] = [
  {
    llmName: "shell_run",
    canonical: "shell.run",
    label: "Run shell command",
    description: "Run an allowlisted shell command (pwd, ls, cat, node --version, whoami) inside the sandbox pod.",
    parameters: Type.Object({ command: Type.String({ description: "Allowlisted command, e.g. 'ls' or 'pwd'" }) }),
  },
  {
    llmName: "fs_read",
    canonical: "fs.read",
    label: "Read file",
    description: "Read a file from the allowed directory inside the sandbox pod.",
    parameters: Type.Object({ path: Type.String({ description: "Path relative to the sandbox root" }) }),
  },
  {
    llmName: "env_inspect",
    canonical: "env.inspect",
    label: "Inspect environment",
    description: "Return pod name, namespace, working directory, user, and runtime versions.",
    parameters: Type.Object({}),
  },
];

/**
 * RealPiClient — the production agent loop, backed by the real Pi TypeScript SDK
 * (@earendil-works/pi-coding-agent). It registers our 3 sandbox tools so that
 * every tool the LLM calls is executed inside a just-in-time leased pod via the
 * SandboxToolRunner. There is no mock fallback (ADR-0005).
 */
export class RealPiClient implements PiClient {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly runner: SandboxToolRunner,
    private readonly logger: AppLogger,
  ) {
    this.authStorage = AuthStorage.create();
    // Inject the resolved provider key at runtime (highest priority in Pi's
    // credential resolution) so we never depend on an on-disk auth.json.
    this.authStorage.setRuntimeApiKey(config.provider, config.providerApiKey);
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  /** Resolve the configured model, falling back to the first available one. */
  private resolveModel() {
    const found = this.modelRegistry.find(this.config.provider, this.config.model);
    if (found) return found;
    const available = this.modelRegistry.getAvailable();
    if (available.length === 0) {
      throw new Error(
        `No Pi model available for provider "${this.config.provider}". Check credentials and PI_MODEL.`,
      );
    }
    return available[0];
  }

  /** Build the 3 sandbox tools, closing over this request's context + collector. */
  private buildTools(input: ChatInput, collected: ToolCallMeta[]): ToolDefinition[] {
    const runTool = async (
      tool: string,
      toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> => {
      this.logger.info(
        { event: LogEvent.ToolCallRequested, requestId: input.requestId, sessionId: input.sessionId, toolCallId, tool },
        "tool call requested",
      );
      try {
        const result = await this.runner.run(tool, params, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          toolCallId,
        });
        collected.push({ toolCallId, tool: result.tool, pod: result.pod, status: result.status });
        return result;
      } catch (err) {
        // Capacity timeout or unexpected error: record the call and surface a tool
        // error to the model rather than aborting the whole agent turn.
        const errorCode = err instanceof SandboxCapacityTimeoutError ? err.code : "tool_execution_error";
        const message = err instanceof Error ? err.message : String(err);
        collected.push({ toolCallId, tool, pod: null, status: "failed" });
        return { toolCallId, tool, pod: null, status: "failed", output: message, errorCode };
      }
    };

    // Register OpenAI-safe names with the LLM (no dots — OpenAI requires
    // ^[a-zA-Z0-9_-]+$), but keep the canonical dotted names for validation and
    // for the toolCalls[] metadata the API contract requires.
    return SANDBOX_TOOL_SPECS.map((spec) =>
      defineTool({
        name: spec.llmName,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (toolCallId, params) => {
          const r = await runTool(spec.canonical, toolCallId, params as Record<string, unknown>);
          const text =
            spec.canonical === "env.inspect"
              ? `pod=${r.pod}\nnamespace=${this.config.namespace}\n${r.output}`
              : r.output;
          return { content: [{ type: "text", text }], details: r };
        },
      }),
    );
  }

  async runChat(input: ChatInput): Promise<ChatResult> {
    const collected: ToolCallMeta[] = [];
    const { session } = await createAgentSession({
      model: this.resolveModel(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
      // Only our sandbox tools — no local filesystem/bash built-ins.
      noTools: "builtin",
      customTools: this.buildTools(input, collected),
    });

    const logBase = { requestId: input.requestId, sessionId: input.sessionId };
    const unsubscribe = session.subscribe((event: { type: string; errorMessage?: string; reason?: string }) => {
      if (event.type === "error") {
        this.logger.error(
          { event: "pi.agent.error", ...logBase, reason: event.reason, errorMessage: event.errorMessage },
          "pi agent error",
        );
      }
    });

    try {
      await session.prompt(input.message);
    } finally {
      unsubscribe();
    }

    const message = extractFinalText(session);
    this.logger.debug({ ...logBase, toolCalls: collected.length, messageLength: message.length }, "pi chat finished");

    return {
      sessionId: input.sessionId,
      message,
      toolCalls: collected,
    };
  }
}

/** Pull the final assistant message text out of the session state. */
function extractFinalText(session: { agent: { state: { messages: unknown[] } } }): string {
  const messages = session.agent.state.messages as Array<{
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      if (text.trim().length > 0) return text;
    }
  }
  return "";
}
