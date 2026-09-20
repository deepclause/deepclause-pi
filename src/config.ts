import { readFile, writeFile } from "node:fs/promises";

export type ContextMode = "turn" | "branch" | "isolated";

export interface JevJudgeConfig {
  /** Whether the Jev (TypeSafe System One) backend may be used. */
  enabled: boolean;
  /** Model alias or pinned version passed to TypeSafe. */
  model: string;
  /** Environment variable holding the TypeSafe API key. */
  apiKeyEnv: string;
}

export interface JudgmentConfig {
  /** Default backend name: "llm", "jev", or a name registered by an extension. */
  default: string;
  jev: JevJudgeConfig;
}

export interface DeepClauseConfig {
  version: 1;
  contextMode: ContextMode;
  branchMessageLimit: number;
  gasLimit: number;
  maxTokens: number;
  verbose: boolean;
  modelToolEnabled: boolean;
  judgment: JudgmentConfig;
}

export const DEFAULT_CONFIG: DeepClauseConfig = {
  version: 1,
  contextMode: "turn",
  branchMessageLimit: 20,
  gasLimit: 100_000,
  maxTokens: 16_384,
  verbose: false,
  modelToolEnabled: false,
  judgment: {
    default: "llm",
    jev: { enabled: false, model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY" },
  },
};

const isContextMode = (value: unknown): value is ContextMode =>
  value === "turn" || value === "branch" || value === "isolated";

export async function loadConfig(path: string): Promise<DeepClauseConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`Invalid DeepClause config: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!value || typeof value !== "object") throw new Error("DeepClause config must be a JSON object");
  const config = value as Record<string, unknown>;
  const contextMode = config.contextMode ?? DEFAULT_CONFIG.contextMode;
  if (!isContextMode(contextMode)) throw new Error("contextMode must be turn, branch, or isolated");

  const positiveInteger = (key: keyof DeepClauseConfig, fallback: number): number => {
    const candidate = config[key] ?? fallback;
    if (!Number.isInteger(candidate) || Number(candidate) <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    return Number(candidate);
  };

  return {
    version: 1,
    contextMode,
    branchMessageLimit: positiveInteger("branchMessageLimit", DEFAULT_CONFIG.branchMessageLimit),
    gasLimit: positiveInteger("gasLimit", DEFAULT_CONFIG.gasLimit),
    maxTokens: positiveInteger("maxTokens", DEFAULT_CONFIG.maxTokens),
    verbose: config.verbose === true,
    modelToolEnabled: config.modelToolEnabled === true,
    judgment: parseJudgmentConfig(config.judgment),
  };
}

function parseJudgmentConfig(value: unknown): JudgmentConfig {
  if (value === undefined) return DEFAULT_CONFIG.judgment;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("judgment must be a JSON object");
  }
  const judgment = value as Record<string, unknown>;
  const defaultBackend = judgment.default ?? DEFAULT_CONFIG.judgment.default;
  if (typeof defaultBackend !== "string" || !defaultBackend.trim()) {
    throw new Error("judgment.default must be a non-empty backend name");
  }

  const jevValue = judgment.jev ?? {};
  if (!jevValue || typeof jevValue !== "object" || Array.isArray(jevValue)) {
    throw new Error("judgment.jev must be a JSON object");
  }
  const jev = jevValue as Record<string, unknown>;
  const model = jev.model ?? DEFAULT_CONFIG.judgment.jev.model;
  const apiKeyEnv = jev.apiKeyEnv ?? DEFAULT_CONFIG.judgment.jev.apiKeyEnv;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("judgment.jev.model must be a non-empty string");
  }
  if (typeof apiKeyEnv !== "string" || !apiKeyEnv.trim()) {
    throw new Error("judgment.jev.apiKeyEnv must be a non-empty environment variable name");
  }

  return {
    default: defaultBackend.trim(),
    jev: {
      enabled: jev.enabled === true,
      model: model.trim(),
      apiKeyEnv: apiKeyEnv.trim(),
    },
  };
}

export async function setModelToolEnabled(configPath: string, enabled: boolean): Promise<DeepClauseConfig> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid DeepClause config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await writeFile(configPath, `${JSON.stringify({ ...existing, modelToolEnabled: enabled }, null, 2)}\n`, "utf8");
  return loadConfig(configPath);
}
