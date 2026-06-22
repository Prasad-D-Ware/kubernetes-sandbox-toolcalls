import { describe, it, expect, vi } from "vitest";
import { parseLogLine, createLogger } from "../../src/logging.js";

describe("parseLogLine", () => {
  it("returns the event object for a structured line carrying an event field", () => {
    const line = JSON.stringify({ level: 30, time: "t", event: "sandbox.lease.acquired", pod: "sandbox-runner-3" });
    expect(parseLogLine(line)).toMatchObject({ event: "sandbox.lease.acquired", pod: "sandbox-runner-3" });
  });

  it("ignores a line with no event field", () => {
    expect(parseLogLine(JSON.stringify({ level: 30, msg: "hello" }))).toBeNull();
  });

  it("ignores a non-JSON line", () => {
    expect(parseLogLine("not json")).toBeNull();
  });
});

describe("createLogger tap", () => {
  it("publishes structured events to the tap as they are logged", async () => {
    const onEvent = vi.fn();
    const logger = createLogger("info", onEvent);
    logger.info({ event: "tool.execution.started", pod: "sandbox-runner-1" }, "started");
    // pino writes are synchronous to the stream; allow a tick for stream flush.
    await new Promise((r) => setImmediate(r));
    expect(onEvent).toHaveBeenCalled();
    expect(onEvent.mock.calls.some(([e]) => e.event === "tool.execution.started")).toBe(true);
  });
});
