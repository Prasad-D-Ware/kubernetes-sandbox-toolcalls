import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logging.js";
import { LogEvent } from "../logging.js";
import type { SandboxToolRunner } from "../sandbox/SandboxToolRunner.js";
import type { ChatInput, ChatResult, PiClient, ToolCallMeta } from "./types.js";

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
    ) => {
      this.logger.info(
        { event: LogEvent.ToolCallRequested, requestId: input.requestId, sessionId: input.sessionId, toolCallId, tool },
        "tool call requested",
      );
      const result = await this.runner.run(tool, params, {
        requestId: input.requestId,
        sessionId: input.sessionId,
        toolCallId,
      });
      collected.push({ toolCallId, tool: result.tool, pod: result.pod, status: result.status });
      return result;
    };

    const shellRun = defineTool({
      name: "shell.run",
      label: "Run shell command",
      description:
        "Run an allowlisted shell command (pwd, ls, cat, node --version, whoami) inside the sandbox pod.",
      parameters: Type.Object({ command: Type.String({ description: "Allowlisted command" }) }),
      execute: async (toolCallId, params) => {
        const r = await runTool("shell.run", toolCallId, params as Record<string, unknown>);
        return { content: [{ type: "text", text: r.output }], details: r };
      },
    });

    const fsRead = defineTool({
      name: "fs.read",
      label: "Read file",
      description: "Read a file from the allowed directory inside the sandbox pod.",
      parameters: Type.Object({ path: Type.String({ description: "Path relative to the sandbox root" }) }),
      execute: async (toolCallId, params) => {
        const r = await runTool("fs.read", toolCallId, params as Record<string, unknown>);
        return { content: [{ type: "text", text: r.output }], details: r };
      },
    });

    const envInspect = defineTool({
      name: "env.inspect",
      label: "Inspect environment",
      description: "Return pod name, namespace, working directory, user, and runtime versions.",
      parameters: Type.Object({}),
      execute: async (toolCallId, params) => {
        const r = await runTool("env.inspect", toolCallId, params as Record<string, unknown>);
        const text = `pod=${r.pod}\nnamespace=${this.config.namespace}\n${r.output}`;
        return { content: [{ type: "text", text }], details: r };
      },
    });

    return [shellRun, fsRead, envInspect];
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

    await session.prompt(input.message);

    return {
      sessionId: input.sessionId,
      message: extractFinalText(session),
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
