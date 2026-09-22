import { describe, expect, it } from "vitest";
import { createDeepClause, createJevJudgeBackend } from "deepclause-sdk";

/**
 * Opt-in live test for the real TypeSafe System One (Jev) judge backend.
 *
 * It is skipped unless both of these are set, so CI never makes paid calls:
 *
 *   DEEPCLAUSE_LIVE_JEV=1
 *   TYPESAFE_API_KEY=...      # e.g. TYPESAFE_API_KEY="$(cat ~/jev.txt)"
 *
 * Run with:
 *   DEEPCLAUSE_LIVE_JEV=1 TYPESAFE_API_KEY="$(cat ~/jev.txt)" npx vitest run tests/judge-live.test.ts
 */
const apiKey = process.env.TYPESAFE_API_KEY;
const live = process.env.DEEPCLAUSE_LIVE_JEV === "1" && Boolean(apiKey);

const CALIBRATED_ONLY_DML = `
agent_main(Request) :-
    with_judgment(jev,
        probability(Request, "What is the probability this is high risk?", P)),
    format(string(R), "P=~w", [P]),
    answer(R).
`;

describe.skipIf(!live)("live Jev judge backend", () => {
  it("reports calibrated capability and answers a calibrated probability question", async () => {
    const backend = createJevJudgeBackend({ apiKey, model: "jev-latest" });
    expect(backend.capabilities.calibrated).toBe(true);
    expect(backend.capabilities.probability).toBe(true);

    const sdk = await createDeepClause({
      model: "mock-model",
      llmBackend: { async complete() { return { text: "unused" }; } },
      judgeBackends: { jev: backend },
      defaultJudge: "jev",
    });
    try {
      let answer: string | undefined;
      for await (const event of sdk.runDML(CALIBRATED_ONLY_DML, {
        args: ["G2P1 at 34 weeks reports vaginal bleeding; BP 150/95"],
      })) {
        if (event.type === "answer") answer = event.content;
      }
      expect(answer).toMatch(/^P=\d+(\.\d+)?$/);
      expect(Number(answer!.slice(2))).toBeGreaterThan(0.5);
    } finally {
      await sdk.dispose();
    }
  }, 60_000);
});
