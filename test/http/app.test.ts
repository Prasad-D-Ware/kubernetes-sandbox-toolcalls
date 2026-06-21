import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, type HealthChecker } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import { SandboxCapacityTimeoutError } from "../../src/lease/types.js";
import type { PiClient, ChatInput } from "../../src/pi/types.js";

const logger = createLogger("silent");

function startApp(piClient: PiClient, podsState: unknown, health: HealthChecker) {
  const app = createApp({
    piClient,
    poolStateReader: { read: async () => podsState } as never,
    healthChecker: health,
    logger,
  });
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("HTTP API", () => {
  let server: Server;
  let base: string;

  const piClient: PiClient = {
    async runChat(input: ChatInput) {
      if (input.message === "boom") throw new SandboxCapacityTimeoutError(15_000);
      return {
        sessionId: input.sessionId,
        message: "The sandbox contains package.json and src/.",
        toolCalls: [{ toolCallId: "tool-abc", tool: "shell.run", pod: "sandbox-runner-3", status: "completed" }],
      };
    },
  };

  const health: HealthChecker = {
    async check() {
      return { ok: true, kubernetes: "connected", sandboxPodsReady: 8 };
    },
  };

  beforeAll(() => {
    const started = startApp(piClient, { pods: [{ name: "sandbox-runner-0", ready: true, lease: { status: "free" } }] }, health);
    server = started.server;
    base = started.base;
  });
  afterAll(() => server.close());

  it("POST /chat returns the assistant message and tool-call metadata", async () => {
    const res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-123", message: "list files" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("session-123");
    expect(body.toolCalls[0]).toMatchObject({ tool: "shell.run", pod: "sandbox-runner-3", status: "completed" });
  });

  it("POST /chat validates input", async () => {
    const res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("POST /chat surfaces capacity timeout with the documented error shape", async () => {
    const res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s", message: "boom" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("sandbox_capacity_timeout");
    expect(body.error.message).toMatch(/15 seconds/);
  });

  it("GET /pods returns the pool state", async () => {
    const res = await fetch(`${base}/pods`);
    expect(res.status).toBe(200);
    expect((await res.json()).pods[0].name).toBe("sandbox-runner-0");
  });

  it("GET /health returns service health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kubernetes: "connected", sandboxPodsReady: 8 });
  });
});
