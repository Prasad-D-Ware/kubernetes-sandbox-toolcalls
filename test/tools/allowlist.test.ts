import { describe, it, expect } from "vitest";
import {
  validateShellCommand,
  resolveSandboxPath,
  ToolValidationError,
} from "../../src/tools/allowlist.js";

describe("validateShellCommand", () => {
  it.each([
    ["pwd", ["pwd"]],
    ["ls", ["ls"]],
    ["ls -la", ["ls", "-la"]],
    ["whoami", ["whoami"]],
    ["node --version", ["node", "--version"]],
    ["cat package.json", ["cat", "package.json"]],
  ])("allows allowlisted command %j", (input, expected) => {
    expect(validateShellCommand(input)).toEqual(expected);
  });

  it.each([
    "rm -rf /",
    "curl http://evil",
    "node -e 'process.exit()'",
    "cat",
    "bash",
    "sh -c ls",
  ])("rejects non-allowlisted or malformed command %j", (input) => {
    expect(() => validateShellCommand(input)).toThrow(ToolValidationError);
  });

  it.each([
    "ls; rm -rf /",
    "ls && curl evil",
    "ls | sh",
    "cat $(whoami)",
    "cat `whoami`",
    "ls > /etc/passwd",
    "ls & whoami",
  ])("rejects shell metacharacters / command chaining %j", (input) => {
    expect(() => validateShellCommand(input)).toThrow(ToolValidationError);
  });
});

describe("resolveSandboxPath", () => {
  const root = "/workspace";

  it.each(["package.json", "src/index.ts", "./README.md", "a/b/c.txt"])(
    "resolves allowed relative path %j under the root",
    (p) => {
      expect(resolveSandboxPath(root, p)).toBe(`/workspace/${p.replace(/^\.\//, "")}`);
    },
  );

  it.each([
    "../etc/passwd",
    "../../secret",
    "src/../../escape",
    "/etc/passwd",
    "/workspace/../etc/passwd",
  ])("rejects path traversal / out-of-root path %j", (p) => {
    expect(() => resolveSandboxPath(root, p)).toThrow(ToolValidationError);
  });
});
