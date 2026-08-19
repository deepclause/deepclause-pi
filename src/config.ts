import { readFile } from "node:fs/promises";

export type ContextMode = "turn" | "branch" | "isolated";

export interface DeepClauseConfig {
  version: 1;
  contextMode: ContextMode;
  branchMessageLimit: number;
  gasLimit: number;
  maxTokens: number;
  verbose: boolean;
}

export const DEFAULT_CONFIG: DeepClauseConfig = {
  version: 1,
  contextMode: "turn",
  branchMessageLimit: 20,
  gasLimit: 100_000,
  maxTokens: 16_384,
  verbose: false,
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
  };
}
