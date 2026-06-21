import path from "node:path";

/** Raised when a tool's input violates the security allowlist. */
export class ToolValidationError extends Error {
  public readonly code = "tool_input_rejected";
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

/**
 * Characters that would let a caller chain, redirect, or substitute commands.
 * Their presence means we reject outright — we never pass input to a shell that
 * would interpret them. (We exec argv directly; this is defense in depth.)
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>*?!\\"'\n\r]/;

/**
 * Allowlisted base commands and the predicate their arguments must satisfy.
 * Anything not listed here is rejected — no arbitrary shell execution.
 */
const ALLOWED_COMMANDS: Record<string, (args: string[]) => boolean> = {
  pwd: (args) => args.length === 0,
  whoami: (args) => args.length === 0,
  // ls with optional simple flags and/or path operands (paths are not dereferenced
  // here; fs.read enforces the path allowlist for file *reads*).
  ls: (args) => args.every((a) => /^-[A-Za-z]+$/.test(a) || /^[\w./-]+$/.test(a)),
  // cat requires exactly one path operand.
  cat: (args) => args.length === 1 && /^[\w./-]+$/.test(args[0]),
  // node is restricted to --version only (no arbitrary script execution).
  node: (args) => args.length === 1 && args[0] === "--version",
};

/**
 * Validate a `shell.run` command string against the allowlist and return its
 * argv tokens. Throws ToolValidationError on anything not explicitly permitted.
 */
export function validateShellCommand(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new ToolValidationError("empty command");
  if (SHELL_METACHARACTERS.test(trimmed)) {
    throw new ToolValidationError(`command contains disallowed shell metacharacters: ${command}`);
  }
  const tokens = trimmed.split(/\s+/);
  const [base, ...args] = tokens;
  const rule = ALLOWED_COMMANDS[base];
  if (!rule) throw new ToolValidationError(`command not allowlisted: ${base}`);
  if (!rule(args)) throw new ToolValidationError(`disallowed arguments for ${base}: ${args.join(" ")}`);
  return tokens;
}

/**
 * Resolve a caller-supplied path against the sandbox root, rejecting absolute
 * paths, path traversal, and anything that escapes the root. Returns the safe
 * absolute path inside the root.
 */
export function resolveSandboxPath(root: string, requested: string): string {
  if (requested.includes("\0")) throw new ToolValidationError("path contains null byte");
  if (path.isAbsolute(requested)) {
    throw new ToolValidationError(`absolute paths are not allowed: ${requested}`);
  }
  const normalizedRoot = path.posix.normalize(root);
  const resolved = path.posix.normalize(path.posix.join(normalizedRoot, requested));
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new ToolValidationError(`path escapes the sandbox root: ${requested}`);
  }
  return resolved;
}
