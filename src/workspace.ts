import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "./config.js";

export interface DeepClausePaths {
  root: string;
  skills: string;
  plans: string;
  specs: string;
  changes: string;
  lib: string;
  config: string;
  agents: string;
  reference: string;
}

export const EXAMPLE_DML = `% Pi-hosted DeepClause tour.
% Demonstrates deterministic CLP(FD), read-only and approved bash pi tools,
% progress events, typed LLM output, and a final answer.
% Run with: /dc-run example --debug
:- use_module(library(clpfd)).

solve_pair(X, Y) :-
  X in 1..20,
  Y in 1..20,
  X #< Y,
  X + Y #= 14,
  X * Y #= 48,
  labeling([], [X, Y]).

agent_main :-
  output("Phase 1/4: solving X + Y = 14 and X * Y = 48 with CLP(FD)..."),
  solve_pair(X, Y),
  format(string(Solved), "The deterministic solution is X=~w and Y=~w.", [X, Y]),
  output(Solved),
  output("Phase 2/4: listing the active workspace through pi_workspace_list..."),
  exec(pi_workspace_list("."), WorkspaceResult),
  get_dict(entries, WorkspaceResult, Entries),
  length(Entries, EntryCount),
  format(string(ToolSummary), "pi.exec returned ~w top-level workspace entries: ~w", [EntryCount, Entries]),
  output(ToolSummary),
  output("Phase 3/4: requesting an approved bash command through pi_bash..."),
  exec(pi_bash("printf 'bash bridge cwd=%s' \\"$PWD\\""), BashResult),
  get_dict(stdout, BashResult, BashStdout),
  normalize_space(string(BashSummary), BashStdout),
  output(BashSummary),
  output("Phase 4/4: asking pi's active model for a concise explanation..."),
  format(string(Request),
    "Explain in two short sentences why X=~w and Y=~w satisfy X + Y = 14 and X * Y = 48. Mention that the pi-hosted workspace tool observed ~w top-level entries and the approved bash bridge returned: ~w. Store only the explanation in Explanation.",
    [X, Y, EntryCount, BashSummary]),
  task(Request, string(Explanation)),
  format(string(Result), "~w\\n~w\\nBash: ~w\\n\\nModel explanation: ~w", [Solved, ToolSummary, BashSummary, Explanation]),
  answer(Result).
`;

export function getPaths(cwd: string): DeepClausePaths {
  const root = path.join(cwd, ".pi", "deepclause");
  return {
    root,
    skills: path.join(root, "skills"),
    plans: path.join(root, "plans"),
    specs: path.join(root, "specs"),
    changes: path.join(root, "changes"),
    lib: path.join(root, "lib"),
    config: path.join(root, "config.json"),
    agents: path.join(root, "AGENTS.md"),
    reference: path.join(root, "DML_REFERENCE.md"),
  };
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function bundledReference(): Promise<string> {
  const sdkEntry = fileURLToPath(import.meta.resolve("deepclause-sdk"));
  const referencePath = path.join(path.dirname(sdkEntry), "system", "assets", "docs", "DML_REFERENCE.md");
  return readFile(referencePath, "utf8");
}

async function bundledAuthoringGuide(): Promise<string> {
  return readFile(fileURLToPath(new URL("./assets/AGENTS.md", import.meta.url)), "utf8");
}

async function bundledAsset(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./assets/${name}`, import.meta.url)), "utf8");
}

async function bundledDeepResearch(): Promise<string> {
  return readFile(fileURLToPath(new URL("./assets/deep_research.dml", import.meta.url)), "utf8");
}

export async function initializeWorkspace(cwd: string): Promise<DeepClausePaths> {
  const paths = getPaths(cwd);
  await Promise.all([
    mkdir(paths.skills, { recursive: true }),
    mkdir(paths.plans, { recursive: true }),
    mkdir(paths.specs, { recursive: true }),
    mkdir(paths.changes, { recursive: true }),
    mkdir(paths.lib, { recursive: true }),
  ]);
  await Promise.all([
    writeIfMissing(paths.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`),
    writeIfMissing(paths.agents, await bundledAuthoringGuide()),
    writeIfMissing(paths.reference, await bundledReference()),
    writeIfMissing(path.join(paths.skills, "example.dml"), EXAMPLE_DML),
    writeIfMissing(path.join(paths.skills, "deep_research.dml"), await bundledDeepResearch()),
    writeIfMissing(path.join(paths.lib, "specs.dml"), await bundledAsset("specs.dml")),
    writeIfMissing(path.join(paths.skills, "spec_validate.dml"), await bundledAsset("spec_validate.dml")),
    writeIfMissing(path.join(paths.skills, "spec_status.dml"), await bundledAsset("spec_status.dml")),
    writeIfMissing(path.join(paths.skills, "spec_query.dml"), await bundledAsset("spec_query.dml")),
    writeIfMissing(path.join(paths.skills, "spec_graph.dml"), await bundledAsset("spec_graph.dml")),
    writeIfMissing(path.join(paths.skills, "spec_merge.dml"), await bundledAsset("spec_merge.dml")),
    writeIfMissing(path.join(paths.skills, "spec_archive.dml"), await bundledAsset("spec_archive.dml")),
  ]);
  return paths;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveDmlPath(paths: DeepClausePaths, request: string): Promise<string> {
  if (!request || path.isAbsolute(request)) throw new Error("A relative skill name or path is required");
  const hasPathSyntax = request.includes("/") || request.includes("\\");
  const candidate = hasPathSyntax
    ? path.resolve(paths.root, request)
    : path.resolve(paths.skills, request.endsWith(".dml") ? request : `${request}.dml`);
  if (!isInside(path.resolve(paths.root), candidate)) throw new Error("DML path escapes .pi/deepclause");

  try {
    await access(candidate);
    const [realRoot, realCandidate] = await Promise.all([realpath(paths.root), realpath(candidate)]);
    if (!isInside(realRoot, realCandidate)) throw new Error("DML path escapes .pi/deepclause through a symlink");
    if (!realCandidate.endsWith(".dml")) throw new Error("DeepClause programs must use the .dml extension");
    return realCandidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`DML file not found: ${request}`);
    throw error;
  }
}
