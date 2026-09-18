import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gitAccept, gitRestore, gitSnapshot } from "../src/runtime.js";

const run = promisify(execFile);

/** A pi-like exec that runs real git, like the extension's host bridge. */
const exec: Pick<ExtensionAPI, "exec"> = {
  async exec(command: string, args: string[], options?: { cwd?: string }) {
    try {
      const result = await run(command, args, { cwd: options?.cwd });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1, killed: false };
    }
  },
};

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

async function repo(): Promise<{ cwd: string; changeJson: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "dc-rollback-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await writeFile(path.join(cwd, ".gitignore"), ".pi/\n");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "app.ts"), "export const app = 1;\n");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "init"]);
  const changeJson = path.join(cwd, ".pi", "deepclause", "changes", "c", "change.json");
  await mkdir(path.dirname(changeJson), { recursive: true });
  return { cwd, changeJson };
}

describe("apply rollback", () => {
  it("snapshots a clean tree, restores tracked and untracked changes, then accepts", async () => {
    const { cwd, changeJson } = await repo();

    const ref = await gitSnapshot(exec, cwd, changeJson);
    expect(ref).toMatch(/^[0-9a-f]{7,}/);
    expect(JSON.parse(await readFile(changeJson, "utf8")).snapshot).toBe(ref);

    // mutate: change a tracked file and create an untracked one
    await writeFile(path.join(cwd, "src", "app.ts"), "export const app = 2;\n");
    await writeFile(path.join(cwd, "src", "new.ts"), "export const extra = true;\n");

    const restored = await gitRestore(exec, cwd, changeJson);
    expect(restored).toBe(ref);
    expect(await readFile(path.join(cwd, "src", "app.ts"), "utf8")).toBe("export const app = 1;\n");
    await expect(readFile(path.join(cwd, "src", "new.ts"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(changeJson, "utf8")).snapshot).toBeNull();

    // clean tree again -> snapshot and accept clears the ref
    const second = await gitSnapshot(exec, cwd, changeJson);
    expect(second).toBe(ref);
    await gitAccept(changeJson);
    expect(JSON.parse(await readFile(changeJson, "utf8")).snapshot).toBeNull();
  });

  it("refuses to snapshot a dirty working tree", async () => {
    const { cwd, changeJson } = await repo();
    await writeFile(path.join(cwd, "src", "app.ts"), "export const app = 99;\n");
    await expect(gitSnapshot(exec, cwd, changeJson)).rejects.toThrow("dirty");
  });

  it("is a no-op when there is no recorded snapshot", async () => {
    const { cwd, changeJson } = await repo();
    await expect(gitRestore(exec, cwd, changeJson)).resolves.toBeNull();
  });
});

describe("apply resume", () => {
  it("reuses the recorded snapshot on a dirty tree while an apply is in progress", async () => {
    const { cwd, changeJson } = await repo();
    const ref = await gitSnapshot(exec, cwd, changeJson);
    expect(JSON.parse(await readFile(changeJson, "utf8")).applyState).toBe("in_progress");

    // a partial apply dirties the tree, but the run resumes from the original ref
    await writeFile(path.join(cwd, "src", "app.ts"), "export const app = 3;\n");
    const resumed = await gitSnapshot(exec, cwd, changeJson);
    expect(resumed).toBe(ref);
  });

  it("clears the snapshot and marks the apply done on accept", async () => {
    const { cwd, changeJson } = await repo();
    await gitSnapshot(exec, cwd, changeJson);
    await gitAccept(changeJson);
    const state = JSON.parse(await readFile(changeJson, "utf8"));
    expect(state.snapshot).toBeNull();
    expect(state.applyState).toBe("done");
  });
});
