import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDeepClause, createMockJevJudgeBackend, createMockJudgeBackend } from "deepclause-sdk";
import { validateWithProlog } from "deepclause-sdk/compiler";

/**
 * The handbook authoring skill teaches the judgment predicates. These tests keep
 * that guidance honest: the documented classifier / calibrated-probability
 * examples must stay valid DML and must actually execute, including the
 * `require_judgment(calibrated, ...)` fallback path.
 */
const RISK_BAND_DML = `
risk_band(Text, Band) :-
    require_judgment(calibrated,
        probability(Text, "What is the probability this is high risk?", P)),
    (   P >= 0.8 -> Band = high
    ;   P >= 0.4 -> Band = medium
    ;   Band = low
    ).
risk_band(Text, Band) :-
    choose(Text, "Is this high, medium, or low risk?", [high, medium, low], Band).

agent_main(Request) :-
    risk_band(Request, Band),
    format(string(R), "Band: ~w", [Band]),
    answer(R).
`;

async function runWithJudge(backend: ReturnType<typeof createMockJudgeBackend>): Promise<string | undefined> {
  const sdk = await createDeepClause({
    model: "mock-model",
    llmBackend: { async complete() { return { text: "unused" }; } },
    judgeBackends: { mock: backend },
    defaultJudge: "mock",
  });
  try {
    let answer: string | undefined;
    for await (const event of sdk.runDML(RISK_BAND_DML, { args: ["patient is bleeding heavily"] })) {
      if (event.type === "answer") answer = event.content;
    }
    return answer;
  } finally {
    await sdk.dispose();
  }
}

describe("handbook-dml judgment guidance", () => {
  it("teaches the classifier / calibrated-probability / task decision", async () => {
    const skill = await readFile(new URL("../skills/handbook-dml/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("## Choosing the reasoning primitive");
    expect(skill).toContain("Simple classifier");
    expect(skill).toContain("Calibrated probability");
    expect(skill).toContain("Full agent loop");
    expect(skill).toContain("choose/4");
    expect(skill).toContain("rate/4");
    expect(skill).toContain("verify/3");
    expect(skill).toContain("probability/3");
    expect(skill).toContain("holds/2");
    expect(skill).toContain("judge/2");
    expect(skill).toContain("require_judgment(calibrated");
    expect(skill).toContain("task/N");
  });

  it("keeps the documented judge example valid DML", async () => {
    const validation = await validateWithProlog(RISK_BAND_DML);
    expect(validation.valid).toBe(true);
  });

  it("runs the calibrated branch on a calibrated backend", async () => {
    const answer = await runWithJudge(createMockJevJudgeBackend({ probability: 0.9, choice: "last" }));
    expect(answer).toBe("Band: high");
  });

  it("falls back to the classifier when the backend is not calibrated", async () => {
    const answer = await runWithJudge(createMockJudgeBackend({ probability: 0.9, choice: "last" }));
    expect(answer).toBe("Band: low");
  });
});
