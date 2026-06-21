import { describe, it, expect } from "vitest";
import { SANDBOX_TOOL_SPECS } from "../../src/pi/RealPiClient.js";
import { SANDBOX_TOOL_NAMES } from "../../src/sandbox/SandboxToolRunner.js";

const OPENAI_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

describe("sandbox tool specs", () => {
  it("registers LLM-facing names that satisfy OpenAI's tool-name pattern (no dots)", () => {
    for (const spec of SANDBOX_TOOL_SPECS) {
      expect(spec.llmName, spec.llmName).toMatch(OPENAI_NAME_PATTERN);
      expect(spec.llmName).not.toContain(".");
    }
  });

  it("maps every LLM name to a canonical (dotted) tool the runner knows", () => {
    for (const spec of SANDBOX_TOOL_SPECS) {
      expect(SANDBOX_TOOL_NAMES).toContain(spec.canonical);
    }
  });

  it("covers all three required tools", () => {
    expect(SANDBOX_TOOL_SPECS.map((s) => s.canonical).sort()).toEqual(
      ["env.inspect", "fs.read", "shell.run"],
    );
  });
});
