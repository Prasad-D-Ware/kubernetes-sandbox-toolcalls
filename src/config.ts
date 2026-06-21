/**
 * Central configuration, parsed once from the environment. A missing Pi/provider
 * credential is a hard startup failure (no mock fallback) — see ADR-0005.
 */
export interface AppConfig {
  port: number;
  logLevel: string;
  serviceInstanceId: string;

  namespace: string;
  podPrefix: string;
  poolSize: number;
  container: string;
  podNames: string[];

  maxQueueWaitMs: number;
  toolTimeoutMs: number;
  leaseTtlSeconds: number;

  /** Demo-only: artificially hold each lease this many ms after exec, to make the
   * FIFO queue / capacity-timeout observable live with fast tools. Default 0. */
  demoToolHoldMs: number;

  fsRoot: string;

  /** Resolved provider API key for the Pi SDK. */
  providerApiKey: string;
  providerApiKeyEnvVar: string;
  /** Pi provider name (e.g. "anthropic") derived from the env var. */
  provider: string;
  model: string;
}

/** Provider env vars the Pi SDK understands -> Pi provider name. We require one. */
const PROVIDER_KEY_VARS: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "google",
  GROQ_API_KEY: "groq",
  XAI_API_KEY: "xai",
  DEEPSEEK_API_KEY: "deepseek",
  MISTRAL_API_KEY: "mistral",
};

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

function num(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid number for ${name}: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const poolSize = num("SANDBOX_POOL_SIZE", env.SANDBOX_POOL_SIZE, 8);
  const podPrefix = env.SANDBOX_POD_PREFIX ?? "sandbox-runner";

  const isUsableKey = (v: string | undefined): boolean =>
    !!v && v.trim() !== "" && !/x{4,}/i.test(v); // ignore .env.example placeholders like sk-...xxxx
  const providerEnvVar = Object.keys(PROVIDER_KEY_VARS).find((v) => isUsableKey(env[v]));
  if (!providerEnvVar) {
    throw new MissingCredentialsError(
      `No Pi provider credential found. Set one of: ${Object.keys(PROVIDER_KEY_VARS).join(", ")}. ` +
        `See .env.example. The service uses the real Pi SDK and will not start without credentials.`,
    );
  }

  return {
    port: num("PORT", env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? "info",
    serviceInstanceId: env.SERVICE_INSTANCE_ID ?? "api-1",

    namespace: env.SANDBOX_NAMESPACE ?? "pi-sandbox",
    podPrefix,
    poolSize,
    container: env.SANDBOX_CONTAINER ?? "runner",
    podNames: Array.from({ length: poolSize }, (_, i) => `${podPrefix}-${i}`),

    maxQueueWaitMs: num("MAX_QUEUE_WAIT_SECONDS", env.MAX_QUEUE_WAIT_SECONDS, 15) * 1000,
    toolTimeoutMs: num("TOOL_EXECUTION_TIMEOUT_SECONDS", env.TOOL_EXECUTION_TIMEOUT_SECONDS, 30) * 1000,
    leaseTtlSeconds: num("LEASE_TTL_SECONDS", env.LEASE_TTL_SECONDS, 45),

    demoToolHoldMs: num("DEMO_TOOL_HOLD_MS", env.DEMO_TOOL_HOLD_MS, 0),

    fsRoot: env.SANDBOX_FS_ROOT ?? "/workspace",

    providerApiKey: env[providerEnvVar]!,
    providerApiKeyEnvVar: providerEnvVar,
    provider: PROVIDER_KEY_VARS[providerEnvVar],
    model: env.PI_MODEL ?? "claude-sonnet-4-6",
  };
}
