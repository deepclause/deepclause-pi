import { access, copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../workspace.js";

/** Resolve an arbitrary .dml path (relative to cwd or absolute) for diagramming. */
export async function resolveDiagramSource(cwd: string, request: string): Promise<string> {
  const raw = request.trim().replace(/^@/, "");
  if (!raw) throw new Error("A .dml path is required");
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`DML file not found: ${request}`);
    throw error;
  }
  if (!resolved.endsWith(".dml")) throw new Error("The diagram source must be a .dml file");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Not a file: ${request}`);
  return resolved;
}

async function walkDmlFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkDmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".dml")) files.push(full);
  }
  return files;
}

async function canonical(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Every DML file that should appear in the viewer: all skills and plans in the
 * active workspace, plus any extra target (which may live anywhere).
 */
export async function collectDiagramTargets(cwd: string, extra: string[] = []): Promise<string[]> {
  const paths = getPaths(cwd);
  const found = new Set<string>();
  for (const file of [...await walkDmlFiles(paths.skills), ...await walkDmlFiles(paths.plans), ...extra]) {
    found.add(await canonical(file));
  }
  return [...found].sort();
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash * 33) ^ value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * Stable viewer/sidecar name. Same-named DML files in different directories get
 * a short path hash so they can never collide.
 */
export function diagramNameFor(target: string, all: string[], cwd: string): string {
  const base = path.basename(target, ".dml");
  const sameBase = all.filter((candidate) => path.basename(candidate, ".dml") === base);
  if (sameBase.length <= 1) return base;
  return `${base}-${shortHash(path.relative(cwd, target))}`;
}

export function displayPath(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : target;
}

export interface DiagramDir {
  root: string;
  diagrams: string;
  vendor: string;
  vendorFile: string;
}

/**
 * Create .pi/deepclause/diagrams/ and place the vendored Mermaid bundle so the
 * viewer works offline. Existing files are never overwritten.
 */
export async function ensureDiagramDir(cwd: string, vendorAssetPath: string): Promise<DiagramDir> {
  const diagrams = path.join(getPaths(cwd).root, "diagrams");
  const vendor = path.join(diagrams, "vendor");
  await mkdir(vendor, { recursive: true });
  const vendorFile = path.join(vendor, "mermaid.min.js");
  try {
    await access(vendorFile);
  } catch {
    await copyFile(vendorAssetPath, vendorFile);
  }
  return { root: getPaths(cwd).root, diagrams, vendor, vendorFile };
}
