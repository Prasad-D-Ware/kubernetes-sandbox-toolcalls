import "dotenv/config";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../src/config.js";

/**
 * Standalone Pi diagnostic. Bypasses vitest output capture and Kubernetes:
 * uses a FAKE tool that just records it was called, so we can see clearly
 * whether the LLM actually invokes our custom tool.
 *
 *   npx tsx scripts/pi-debug.ts
 */
async function main() {
  const config = loadConfig();
  console.log("\n=== config ===");
  console.log("provider:", config.provider);
  console.log("PI_MODEL:", config.model);

  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(config.provider, config.providerApiKey);
  const modelRegistry = ModelRegistry.create(authStorage);

  const available = modelRegistry.getAvailable();
  console.log("\n=== available models (this provider) ===");
  console.log(
    available
      .filter((m: any) => (m.provider ?? "").includes(config.provider) || true)
      .map((m: any) => `${m.provider ?? "?"}/${m.id ?? m.name ?? "?"}`)
      .slice(0, 40),
  );

  const found = modelRegistry.find(config.provider, config.model);
  const model = found ?? available[0];
  console.log("\n=== resolved model ===");
  console.log("found exact match?", Boolean(found));
  console.log("using:", (model as any)?.id ?? (model as any)?.name, "provider:", (model as any)?.provider);

  let toolCalled = false;
  const shellRun = defineTool({
    name: "shell_run",
    label: "Run shell command",
    description: "Run an allowlisted shell command (pwd, ls, cat, node --version, whoami) inside the sandbox pod.",
    parameters: Type.Object({ command: Type.String({ description: "Allowlisted command" }) }),
    execute: async (_id, params) => {
      toolCalled = true;
      console.log("\n>>> TOOL CALLED: shell.run", JSON.stringify(params));
      return { content: [{ type: "text", text: "package.json\nsrc" }], details: {} };
    },
  });

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
    customTools: [shellRun],
  });

  console.log("\n=== events (all) ===");
  session.subscribe((event: any) => {
    const extra = event.errorMessage ?? event.reason ?? event.toolName ?? "";
    console.log("EVENT", event.type, typeof extra === "string" ? extra : JSON.stringify(extra));
  });

  try {
    await session.prompt("Use the shell.run tool to run `ls` in the sandbox, then tell me what files you see.");
  } catch (err) {
    console.log("\n!!! prompt threw:", err);
  }

  const messages: any[] = session.agent.state.messages as any[];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  console.log("\n=== result ===");
  console.log("tool called?", toolCalled);
  console.log("total messages:", messages.length);
  console.log("\n=== last assistant message (full) ===");
  console.log(JSON.stringify(lastAssistant, null, 2)?.slice(0, 2000));
  process.exit(0);
}

main().catch((err) => {
  console.error("DEBUG ERROR:", err);
  process.exit(1);
});
