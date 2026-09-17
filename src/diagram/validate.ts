import { access, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type MermaidView = "flow" | "sequence";

export interface CheckResult {
  ok: boolean;
  error?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type RunCommand = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<CommandResult>;

const CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
];

const SEQUENCE_OPENERS = /^\s*(?:alt|loop|opt|par|critical|break|rect|box)\b/gm;
const FLOW_OPENERS = /^\s*subgraph\b/gm;
const CLOSERS = /^\s*end\s*$/gm;

function countMatches(source: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(source)) count++;
  return count;
}

/**
 * Cheap, dependency-free validation that catches the failure modes we care
 * about: wrong diagram type, unbalanced blocks, unbalanced quotes, reserved
 * node names, and absurdly large output. It cannot prove Mermaid correctness.
 */
export function structuralCheck(code: string, view: MermaidView): CheckResult {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "the diagram is empty" };
  const lines = trimmed.split("\n");
  const header = (lines[0] ?? "").trim();
  if (view === "sequence") {
    if (!/^sequenceDiagram\b/.test(header)) {
      return { ok: false, error: "expected a 'sequenceDiagram' header" };
    }
  } else if (!/^(?:flowchart|graph)\b/.test(header)) {
    return { ok: false, error: "expected a 'flowchart' or 'graph' header" };
  }
  if (trimmed.length > 200_000) return { ok: false, error: "the diagram is too large" };
  if (lines.length > 5_000) return { ok: false, error: "the diagram has too many lines" };
  if (((trimmed.match(/"/g) ?? []).length) % 2 !== 0) {
    return { ok: false, error: "unbalanced double quotes" };
  }
  if (view === "flow" && /^\s*end\s*[\[\(\{]/m.test(trimmed)) {
    return { ok: false, error: "'end' cannot be used as a node id" };
  }
  const openers = countMatches(trimmed, view === "sequence" ? SEQUENCE_OPENERS : FLOW_OPENERS);
  const closers = countMatches(trimmed, CLOSERS);
  if (openers !== closers) {
    return { ok: false, error: `unbalanced blocks: ${openers} opener(s) but ${closers} 'end' line(s)` };
  }
  return { ok: true };
}

export async function findChrome(run: RunCommand): Promise<string | undefined> {
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    try {
      await access(envPath, constants.X_OK);
      return envPath;
    } catch {
      // Ignore an invalid CHROME_PATH and fall back to discovery.
    }
  }
  for (const binary of CHROME_CANDIDATES) {
    try {
      const result = await run("which", [binary], { timeout: 3_000 });
      if (result.code === 0 && result.stdout.trim()) return binary;
    } catch {
      // `which` missing or the candidate is absent; try the next one.
    }
  }
  return undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function chromeMermaidCheck(
  code: string,
  chrome: string,
  vendorDir: string,
  run: RunCommand,
): Promise<CheckResult> {
  const tmp = path.join(vendorDir, `.check-${process.pid}-${Math.random().toString(36).slice(2, 8)}.html`);
  const html = `<!doctype html><meta charset="utf-8">
<script>window.__CODE__ = ${JSON.stringify(code).replace(/</g, "\\u003c")};</script>
<script src="mermaid.min.js"></script>
<script>
window.addEventListener('DOMContentLoaded', async () => {
  let out;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    await mermaid.parse(window.__CODE__);
    out = 'OK';
  } catch (e) {
    out = 'ERROR: ' + ((e && e.message) || String(e));
  }
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = out;
  document.body.appendChild(pre);
});
</script>`;
  try {
    await writeFile(tmp, html, "utf8");
    const result = await run(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--virtual-time-budget=6000",
        "--dump-dom",
        pathToFileURL(tmp).href,
      ],
      { timeout: 60_000 },
    );
    const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(result.stdout);
    if (!match) return { ok: false, error: "the Mermaid validator produced no result" };
    const output = decodeEntities(match[1] ?? "").trim();
    return output === "OK" ? { ok: true } : { ok: false, error: output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export interface ValidateOptions {
  run?: RunCommand;
  vendorDir?: string;
  chrome?: string | null;
}

export interface ValidationOutcome {
  result: CheckResult;
  gate: "structural" | "chrome";
}

/**
 * Structural check always runs. When a Chrome binary and a vendored Mermaid
 * copy are available, the real Mermaid parser is used as a second gate.
 */
export async function validateMermaid(
  code: string,
  view: MermaidView,
  options: ValidateOptions = {},
): Promise<ValidationOutcome> {
  const structural = structuralCheck(code, view);
  if (!structural.ok) return { result: structural, gate: "structural" };
  if (options.run && options.vendorDir) {
    const chrome = options.chrome === undefined ? await findChrome(options.run) : options.chrome;
    if (chrome) {
      return { result: await chromeMermaidCheck(code, chrome, options.vendorDir, options.run), gate: "chrome" };
    }
  }
  return { result: structural, gate: "structural" };
}
