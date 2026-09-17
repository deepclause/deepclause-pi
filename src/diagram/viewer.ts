import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDml, renderSequence } from "./extract.js";
import type { DiagramGrade } from "./grade.js";
import {
  collectDiagramTargets,
  diagramNameFor,
  displayPath,
  ensureDiagramDir,
} from "./workspace.js";

export interface DiagramEntry {
  name: string;
  path: string;
  flow: string;
  seq: string;
  dml: string;
  presentation: string | null;
  specification: string | null;
}

export interface ViewerBuildResult {
  viewerPath: string;
  diagramsDir: string;
  entries: DiagramEntry[];
}

async function readSidecar(diagramsDir: string, name: string, grade: DiagramGrade): Promise<string | null> {
  try {
    const value = (await readFile(path.join(diagramsDir, `${name}.${grade}.mmd`), "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

function markdownFor(entry: DiagramEntry): string {
  const blocks: string[] = [];
  if (entry.presentation) blocks.push(`## Presentation\n\n\`\`\`mermaid\n${entry.presentation}\n\`\`\``);
  if (entry.specification) blocks.push(`## Specification\n\n\`\`\`mermaid\n${entry.specification}\n\`\`\``);
  blocks.push(`## Flow\n\n\`\`\`mermaid\n${entry.flow}\n\`\`\``);
  blocks.push(`## Sequence\n\n\`\`\`mermaid\n${entry.seq}\n\`\`\``);
  return blocks.join("\n\n") + "\n";
}

async function renderViewer(
  diagramsDir: string,
  entries: DiagramEntry[],
  templateText: string,
  vendorFile: string,
): Promise<string> {
  const json = JSON.stringify(entries).replace(/</g, "\\u003c");
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ");
  const html = templateText
    .replace("__DIAGRAMS_JSON__", json)
    .replace("__GENERATED__", generated)
    .replace("vendor/mermaid.min.js", pathToFileURL(vendorFile).href);
  const viewerPath = path.join(diagramsDir, "viewer.html");
  await writeFile(viewerPath, html, "utf8");
  const manifest = entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    views: [
      entry.presentation ? "presentation" : null,
      entry.specification ? "specification" : null,
      "flow",
      "sequence",
    ].filter(Boolean),
  }));
  await writeFile(path.join(diagramsDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return viewerPath;
}

export interface BuildViewerOptions {
  cwd: string;
  templateText: string;
  vendorAssetPath: string;
  extraPaths?: string[];
}

/**
 * Extract every target DML, collect the optional presentation/specification
 * sidecars, and write the self-contained viewer plus per-skill Markdown.
 */
export async function buildViewer(options: BuildViewerOptions): Promise<ViewerBuildResult> {
  const { diagrams, vendorFile } = await ensureDiagramDir(options.cwd, options.vendorAssetPath);
  const targets = await collectDiagramTargets(options.cwd, options.extraPaths ?? []);
  const entries: DiagramEntry[] = [];
  for (const target of targets) {
    const name = diagramNameFor(target, targets, options.cwd);
    const display = displayPath(options.cwd, target);
    const source = await readFile(target, "utf8");
    const entry: DiagramEntry = {
      name,
      path: display,
      flow: renderDml(display, source, { hideOutput: true }),
      seq: renderSequence(display, source),
      dml: source,
      presentation: await readSidecar(diagrams, name, "presentation"),
      specification: await readSidecar(diagrams, name, "specification"),
    };
    entries.push(entry);
    await writeFile(path.join(diagrams, `${name}.md`), markdownFor(entry), "utf8");
  }
  const viewerPath = await renderViewer(diagrams, entries, options.templateText, vendorFile);
  return { viewerPath, diagramsDir: diagrams, entries };
}

export async function writeSidecar(diagramsDir: string, name: string, grade: DiagramGrade, code: string): Promise<string> {
  const file = path.join(diagramsDir, `${name}.${grade}.mmd`);
  await writeFile(file, code.endsWith("\n") ? code : `${code}\n`, "utf8");
  return file;
}

/** Open the viewer at a specific diagram and view using a fixed, OS-native argv. */
export async function openViewerInBrowser(
  pi: Pick<ExtensionAPI, "exec">,
  viewerPath: string,
  name: string,
  view: string,
): Promise<boolean> {
  const url = `${pathToFileURL(viewerPath).href}?view=${encodeURIComponent(view)}#${encodeURIComponent(name)}`;
  try {
    if (process.platform === "darwin") await pi.exec("open", [url], { timeout: 10_000 });
    else if (process.platform === "win32") await pi.exec("cmd", ["/c", "start", "", url], { timeout: 10_000 });
    else await pi.exec("xdg-open", [url], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
