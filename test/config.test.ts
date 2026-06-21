import { describe, it, expect } from "vitest";
import { loadConfig, MissingCredentialsError } from "../src/config.js";

const base = { SANDBOX_NAMESPACE: "pi-sandbox" } as NodeJS.ProcessEnv;

describe("loadConfig credential resolution", () => {
  it("picks the real OpenAI key over a placeholder Anthropic key", () => {
    const cfg = loadConfig({
      ...base,
      ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx", // .env.example placeholder
      OPENAI_API_KEY: "sk-real-openai-key",
      PI_MODEL: "gpt-4o-mini",
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.providerApiKey).toBe("sk-real-openai-key");
    expect(cfg.model).toBe("gpt-4o-mini");
  });

  it("uses a real Anthropic key when present", () => {
    const cfg = loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-realrealreal" });
    expect(cfg.provider).toBe("anthropic");
  });

  it("throws when no usable credential is present (placeholders only)", () => {
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-xxxxxxxx" })).toThrow(
      MissingCredentialsError,
    );
  });
});
