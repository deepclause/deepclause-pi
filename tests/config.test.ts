import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, setJudgeConfig } from "../src/config.js";

async function load(value: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "dc-config-"));
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return loadConfig(file);
}

describe("judgment config", () => {
  it("defaults to the llm backend with jev disabled", async () => {
    const config = await load({ version: 1 });
    expect(config.judgment).toEqual(DEFAULT_CONFIG.judgment);
    expect(config.judgment).toEqual({
      default: "llm",
      jev: { enabled: false, model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY" },
    });
  });

  it("parses an explicit judgment block", async () => {
    const config = await load({
      version: 1,
      judgment: {
        default: "jev",
        jev: { enabled: true, model: "jev-1.13.0", apiKeyEnv: "MY_KEY" },
      },
    });
    expect(config.judgment.default).toBe("jev");
    expect(config.judgment.jev).toEqual({
      enabled: true,
      model: "jev-1.13.0",
      apiKeyEnv: "MY_KEY",
    });
  });

  it("rejects a malformed judgment block", async () => {
    await expect(load({ version: 1, judgment: { default: "" } })).rejects.toThrow("judgment.default");
    await expect(load({ version: 1, judgment: { default: "llm", jev: { model: "" } } })).rejects.toThrow(
      "judgment.jev.model",
    );
    await expect(load({ version: 1, judgment: { default: "llm", jev: { apiKeyEnv: "" } } })).rejects.toThrow(
      "judgment.jev.apiKeyEnv",
    );
    await expect(load({ version: 1, judgment: [] })).rejects.toThrow("judgment must be a JSON object");
  });

  it("merges judgment updates without dropping other config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dc-config-merge-"));
    const file = path.join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        contextMode: "branch",
        judgment: {
          default: "llm",
          jev: { enabled: false, model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY" },
        },
      }),
      "utf8",
    );

    await setJudgeConfig(file, { jev: { enabled: true } });
    await setJudgeConfig(file, { default: "jev" });
    await setJudgeConfig(file, { jev: { model: "jev-1.13.0" } });

    const config = await loadConfig(file);
    expect(config.contextMode).toBe("branch");
    expect(config.judgment.default).toBe("jev");
    expect(config.judgment.jev).toEqual({
      enabled: true,
      model: "jev-1.13.0",
      apiKeyEnv: "TYPESAFE_API_KEY",
    });
  });
});
