import { describe, expect, it } from "vitest";
import { offerCommit } from "../src/index.js";

function harness(statusOutput: string, confirm: boolean) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const notifications: string[] = [];
  const pi = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      if (command === "git" && args[0] === "status") return { stdout: statusOutput, stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  const ctx = {
    cwd: "/tmp/commit-test",
    hasUI: true,
    ui: {
      notify(message: string) { notifications.push(message); },
      async confirm() { return confirm; },
    },
  };
  return { pi, ctx, calls, notifications };
}

describe("commit prompt", () => {
  it("commits when the user accepts", async () => {
    const { pi, ctx, calls, notifications } = harness(" M src/a.ts\n?? src/b.ts\n", true);
    await offerCommit(pi as never, ctx as never, "apply", "c");
    expect(calls.some((call) => call.command === "git" && call.args[0] === "add" && call.args[1] === "-A")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args[0] === "commit" && call.args[2] === "apply: c")).toBe(true);
    expect(notifications.some((message) => message.includes("Committed: apply: c"))).toBe(true);
  });

  it("reminds instead of committing when the user declines", async () => {
    const { pi, ctx, calls, notifications } = harness(" M src/a.ts\n", false);
    await offerCommit(pi as never, ctx as never, "plan", "add_dark_mode");
    expect(calls.some((call) => call.command === "git" && call.args[0] === "commit")).toBe(false);
    expect(notifications.some((message) => message.includes('git commit -m "plan: add_dark_mode"'))).toBe(true);
  });

  it("does nothing on a clean tree or outside git", async () => {
    const clean = harness("", true);
    await offerCommit(clean.pi as never, clean.ctx as never, "apply", "c");
    expect(clean.calls.some((call) => call.command === "git" && call.args[0] === "commit")).toBe(false);
    expect(clean.notifications).toEqual([]);

    const noRepo = harness("", true);
    noRepo.pi.exec = (async (command: string, args: string[]) => {
      noRepo.calls.push({ command, args });
      return { stdout: "", stderr: "not a git repository", code: 128, killed: false };
    }) as never;
    await offerCommit(noRepo.pi as never, noRepo.ctx as never, "apply", "c");
    expect(noRepo.notifications).toEqual([]);
  });
});
