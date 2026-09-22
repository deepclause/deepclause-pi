// Port of deepclause-handbook-md/tools/dml_flow.mjs.
// Heuristic (not a Prolog parser) DML -> Mermaid extractor. Pure string work,
// no dependencies and no filesystem access.

export interface RenderOptions {
  hideOutput?: boolean;
  /** Include core decision-logic blocks and rule facts. Defaults to true. */
  includeLogic?: boolean;
}

interface Clause {
  args: string;
  body: string;
}

type ClauseMap = Map<string, Clause[]>;

interface Goal {
  goal: string;
  sep: string;
}

interface Segment {
  entry: string | null;
  exit: string | null;
}

// ---------- lexing -----------------------------------------------------------

function stripComments(src: string): string {
  let out = "";
  let inStr = false;
  let inChar = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    const n = src.charAt(i + 1);
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n;
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (inChar) {
      out += c;
      if (c === "\\") {
        out += n;
        i++;
      } else if (c === "'") inChar = false;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === "%") {
      while (i < src.length && src.charAt(i) !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "'") {
      inChar = true;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

function splitTop(s: string, seps: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  let inChar = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (inStr) {
      cur += c;
      if (c === "\\") cur += s.charAt(++i);
      else if (c === '"') inStr = false;
      continue;
    }
    if (inChar) {
      cur += c;
      if (c === "\\") cur += s.charAt(++i);
      else if (c === "'") inChar = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === "'") {
      inChar = true;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (depth === 0 && seps.includes(c)) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

function splitGoals(s: string): Goal[] {
  const out: Goal[] = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  let inChar = false;
  const push = (sep: string) => {
    const goal = cur.trim();
    if (goal) out.push({ goal, sep });
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (inStr) {
      cur += c;
      if (c === "\\") cur += s.charAt(++i);
      else if (c === '"') inStr = false;
      continue;
    }
    if (inChar) {
      cur += c;
      if (c === "\\") cur += s.charAt(++i);
      else if (c === "'") inChar = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === "'") {
      inChar = true;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (depth === 0 && (c === "," || c === ";")) {
      push(c);
      continue;
    }
    cur += c;
  }
  push("");
  return out;
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  for (;;) {
    if (!(t.startsWith("(") && t.endsWith(")"))) return t;
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < t.length; i++) {
      const c = t.charAt(i);
      if (c === '"') {
        i++;
        while (i < t.length && t.charAt(i) !== '"') {
          if (t.charAt(i) === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === "'") {
        i++;
        while (i < t.length && t.charAt(i) !== "'") {
          if (t.charAt(i) === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0 && i !== t.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (!balanced) return t;
    t = t.slice(1, -1).trim();
  }
}

function headName(goal: string): string | null {
  const m = /^\s*(?:\\\+\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(goal);
  if (m && m[1]) return m[1];
  const m2 = /^\s*(?:\\\+\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*$/.exec(goal);
  return m2 && m2[1] ? m2[1] : null;
}

function firstString(goal: string): string {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(goal);
  return m && m[1] ? m[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim() : "";
}

function firstArgVar(goal: string): string {
  const i = goal.indexOf("(");
  if (i < 0) return "";
  const inside = goal.slice(i + 1, goal.lastIndexOf(")"));
  const arg = (splitTop(inside, ",")[0] ?? "").trim();
  return /^[A-Z_]/.test(arg) ? arg : "";
}

const trunc = (s: string, n = 64): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- clause extraction (balanced scanner) -----------------------------

function extractClauses(src: string): ClauseMap {
  const clauses: ClauseMap = new Map();
  const isId = (c: string) => /[a-zA-Z0-9_]/.test(c);
  const skipWs = (p: number) => {
    while (p < src.length && /\s/.test(src.charAt(p))) p++;
    return p;
  };
  const readStr = (p: number, q: string) => {
    p++;
    while (p < src.length && src.charAt(p) !== q) {
      if (src.charAt(p) === "\\") p++;
      p++;
    }
    return p + 1;
  };
  let i = 0;
  while (i < src.length) {
    i = skipWs(i);
    if (i >= src.length) break;
    if (!/[a-z]/.test(src.charAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < src.length && isId(src.charAt(j))) j++;
    const name = src.slice(i, j);
    let k = j;
    while (k < src.length && /[ \t]/.test(src.charAt(k))) k++;
    let args = "";
    if (src.charAt(k) === "(") {
      let depth = 0;
      let p = k;
      for (; p < src.length; p++) {
        const c = src.charAt(p);
        if (c === '"') {
          p = readStr(p, '"') - 1;
          continue;
        }
        if (c === "'") {
          p = readStr(p, "'") - 1;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) {
            p++;
            break;
          }
        }
      }
      args = src.slice(k + 1, Math.max(k + 1, p - 1));
      k = p;
      while (k < src.length && /[ \t]/.test(src.charAt(k))) k++;
    }
    let hasBody = false;
    if (src.charAt(k) === ":" && src.charAt(k + 1) === "-") {
      hasBody = true;
      k += 2;
    }
    let depth = 0;
    let inStr = false;
    let inChar = false;
    let b = k;
    for (; b < src.length; b++) {
      const c = src.charAt(b);
      if (inStr) {
        if (c === "\\") b++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (inChar) {
        if (c === "\\") b++;
        else if (c === "'") inChar = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "'") {
        inChar = true;
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "." && depth === 0 && (b + 1 >= src.length || /\s/.test(src.charAt(b + 1)))) break;
    }
    if (!clauses.has(name)) clauses.set(name, []);
    clauses.get(name)!.push({ args, body: hasBody ? src.slice(k, b) : "" });
    i = b + 1;
  }
  return clauses;
}

interface ToolCapability {
  name: string;
  args: string;
}

function extractTools(src: string): ToolCapability[] {
  const tools: ToolCapability[] = [];
  for (const m of src.matchAll(/tool\s*\(\s*([a-z][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)\s*:-/g)) {
    tools.push({ name: m[1] ?? "", args: (m[2] ?? "").trim() });
  }
  return tools;
}

// ---------- analysis ---------------------------------------------------------

const BUILTIN = new Set([
  "format", "get_dict", "length", "findall", "member", "forall", "sub_string",
  "atomics_to_string", "retractall", "assertz", "retract", "true", "is",
  "use_module", "=", "\\=", "=:=", ">", "<", ">=", "=<",
]);

function agenticPredicates(clauses: ClauseMap): Set<string> {
  const agentic = new Set<string>();
  const prim = (n: string) => ["task", "prompt", "exec", "with_tools"].includes(n);
  const visit = (n: string, seen: Set<string>): boolean => {
    if (agentic.has(n)) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    for (const { body } of clauses.get(n) ?? []) {
      for (const { goal } of splitGoals(body)) {
        const h = headName(stripOuterParens(goal));
        if (h && prim(h)) {
          agentic.add(n);
          return true;
        }
        if (h && clauses.has(h) && !BUILTIN.has(h) && visit(h, seen)) {
          agentic.add(n);
          return true;
        }
      }
    }
    return false;
  };
  for (const n of clauses.keys()) visit(n, new Set());
  return agentic;
}

// ---------- core logic extraction --------------------------------------------

const JUDGE_PREDICATES = new Set([
  "judge", "choose", "rate", "verify", "probability", "holds", "with_judgment", "require_judgment",
]);

const MECHANICAL_HELPERS = new Set([
  "dget", "get_dict", "num", "to_num", "present", "lower", "lower_string", "upper",
  "state_text", "norm_sign", "as_list", "truthy", "falsy", "format", "trunc", "basename",
]);

const DECISION_RE = /(?:>=|=<|<|>|=:=|\bis\b|\bbetween\b|\bmod\b|\\\+)/;
const AGGREGATE_RE = /\b(findall|forall|setof|bagof|aggregate_all|maplist)\b/;

/** All `name(` tokens in a clause body, with strings and chars removed. */
function headNamesIn(text: string): string[] {
  const bare = text
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const names: string[] = [];
  for (const m of bare.matchAll(/([a-z][a-zA-Z0-9_]*)\s*\(/g)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function predicateArity(clauses: Clause[]): number {
  return splitTop(clauses[0]?.args ?? "", ",").filter(Boolean).length;
}

function isFactClauses(clauses: Clause[]): boolean {
  return clauses.every((clause) => !clause.body.trim());
}

/**
 * A predicate carries core logic when it branches, applies thresholds or
 * generators, or consults a semantic judgment. Mechanical plumbing helpers are
 * excluded so the logic section stays about decisions, not string handling.
 */
function isDecisionPredicate(name: string, clauses: Clause[]): boolean {
  if (MECHANICAL_HELPERS.has(name)) return false;
  if (clauses.length > 1) return true;
  const body = clauses[0]?.body ?? "";
  if (!body.trim()) return false;
  if (DECISION_RE.test(body)) return true;
  if (AGGREGATE_RE.test(body)) return true;
  for (const h of headNamesIn(body)) if (JUDGE_PREDICATES.has(h)) return true;
  return false;
}

const escLabel = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "'");

/** Join the summaries of a conjunction/disjunction into one readable line. */
function summarizeBody(text: string, max = 96): string {
  const parts = splitGoals(text)
    .map(({ goal }) => summarizeGoal(goal, max))
    .filter(Boolean);
  return [...new Set(parts)].slice(-2).join("; ");
}

/** One short, readable line for a single body goal. */
function summarizeGoal(goal: string, max = 96): string {
  const g = stripOuterParens(goal).trim();
  if (!g) return "";
  const br = parseArrow(g);
  if (br) {
    const then = summarizeBody(br.then, Math.max(24, max - 12));
    const otherwise = br.else.trim() ? summarizeBody(br.else, Math.max(24, max - 12)) : "";
    return `if ${trunc(br.cond.replace(/\s+/g, " "), max)} -> ${then || "…"}${otherwise ? ` ; else: ${otherwise}` : ""}`;
  }
  return summarizeSingle(g, max);
}

function summarizeSingle(g: string, max: number): string {
  const h = headName(g);
  if (!h) return trunc(g.replace(/\s+/g, " "), max);
  if (["format", "write", "print", "output", "answer"].includes(h)) {
    const s = firstString(g);
    if (!s) return `${h}(...)`;
    const decision = /(?:decision|answer|verdict|conclusion):.*/i.exec(s);
    return trunc(decision ? decision[0] : s, Math.max(max, 120));
  }
  if (JUDGE_PREDICATES.has(h)) {
    const label = h === "require_judgment" ? "require calibrated" : h;
    const s = firstString(g);
    return s ? `${label}: ${trunc(s, Math.max(16, max - label.length - 2))}` : `${label}(...)`;
  }
  if (["findall", "forall", "setof", "bagof", "aggregate_all"].includes(h)) return `${h}(...)`;
  const args = (): string[] => splitTop(g.slice(g.indexOf("(") + 1, g.lastIndexOf(")")), ",").map((p) => p.trim());
  if (h === "get_dict") return args()[0] || "get_dict";
  if (h === "dget" || h === "num" || h === "to_num") return args()[1] || h;
  const inside = g.slice(g.indexOf("(") + 1, g.lastIndexOf(")")).replace(/\s+/g, " ").trim();
  return inside ? `${h}(${trunc(inside, Math.max(12, max - h.length - 3))})` : h;
}

/** Render one clause as an escaped `<br/>`-joined list of its meaningful goals. */
function describeClause(clause: Clause): string {
  if (!clause.body.trim()) return escLabel(trunc(clause.args.replace(/\s+/g, " "), 80));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { goal } of splitGoals(clause.body)) {
    const line = summarizeGoal(goal);
    if (!line) continue;
    const escaped = escLabel(line);
    if (seen.has(escaped)) continue;
    seen.add(escaped);
    lines.push(escaped);
  }
  return lines.join("<br/>");
}

function factSummary(name: string, clauses: Clause[]): string {
  const sample = clauses
    .slice(0, 6)
    .map((clause) => escLabel(trunc(clause.args.replace(/\s+/g, " "), 32)))
    .join(" · ");
  return `${name}/${predicateArity(clauses)} — ${clauses.length} facts: ${sample}${clauses.length > 6 ? " …" : ""}`;
}

interface LogicExtraction {
  logic: Map<string, Clause[]>;
  facts: Map<string, Clause[]>;
}

/** Transitive closure of decision predicates and fact tables reachable from the flow. */
function collectLogic(clauses: ClauseMap, roots: Iterable<string>): LogicExtraction {
  const logic = new Map<string, Clause[]>();
  const facts = new Map<string, Clause[]>();
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const bodies = clauses.get(name);
    if (!bodies) return;
    if (isFactClauses(bodies)) {
      if (bodies.length >= 2) facts.set(name, bodies);
      return;
    }
    if (isDecisionPredicate(name, bodies)) logic.set(name, bodies);
    for (const clause of bodies) {
      for (const inner of headNamesIn(clause.body)) {
        if (inner !== name && clauses.has(inner) && !BUILTIN.has(inner)) visit(inner);
      }
    }
  };
  for (const root of roots) visit(root);
  return { logic, facts };
}

// ---------- rendering --------------------------------------------------------

function parseArrow(goal: string): { cond: string; then: string; else: string } | null {
  const t = stripOuterParens(goal);
  let depth = 0;
  let inStr = false;
  let idx = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "-" && t.charAt(i + 1) === ">" && depth === 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const parts = splitTop(t.slice(idx + 2), ";");
  return { cond: t.slice(0, idx).trim(), then: parts[0] ?? "", else: parts[1] ?? "" };
}

function labelText(goal: string, ctx: string, fallback: string): string {
  const s = firstString(goal);
  if (s) return s;
  if (ctx) return `(${ctx})`;
  const v = firstArgVar(goal);
  return v ? `→ ${v}` : fallback;
}

function phaseLabel(goal: string): string | null {
  if (headName(goal) !== "output") return null;
  const s = firstString(goal);
  return /^Phase\s+\d+\s*\/\s*\d+/i.test(s) ? s : null;
}

interface NodeKind {
  shape: [string, string];
  cls: string;
  label: string;
  terminal?: boolean;
}

function kindFor(goal: string, ctx = ""): NodeKind | null {
  const h = headName(goal);
  switch (h) {
    case "task":
      return { shape: ["{{", "}}"], cls: "llm", label: `task<br/>${trunc(labelText(goal, ctx, "task"))}` };
    case "prompt":
      return { shape: ["{{", "}}"], cls: "llm", label: `prompt<br/>${trunc(labelText(goal, ctx, "review"))}` };
    case "exec": {
      const i = goal.indexOf("(");
      const inner = i >= 0 ? goal.slice(i + 1, goal.lastIndexOf(")")) : goal;
      const call = splitTop(inner, ",")[0] ?? "";
      const nm = headName(call) || "host";
      const arg = firstString(call);
      return { shape: ["[/", "/]"], cls: "host", label: `exec<br/>${nm}${arg && nm === "pi_bash" ? ": " + trunc(arg, 28) : ""}` };
    }
    case "output":
      return firstString(goal) ? { shape: ["[", "]"], cls: "out", label: `output: ${trunc(firstString(goal), 56)}` } : null;
    case "system":
      return { shape: ["[", "]"], cls: "det", label: "system prompt" };
    case "answer":
      return { shape: ["([", "])"], cls: "terminal", label: "answer", terminal: true };
    default:
      return null;
  }
}

interface RenderState {
  n: number;
  lines: string[];
  clauses: ClauseMap;
  agentic: Set<string>;
  stack: string[];
  sawAnswer: boolean;
  phaseOpen: boolean;
  includeLogic: boolean;
  logicNodes: Map<string, string[]>;
  factRefs: Set<string>;
}

export function renderDml(file: string, src: string, opts: RenderOptions = {}): string {
  const clauses = extractClauses(stripComments(src));
  const agentic = agenticPredicates(clauses);
  const tools = extractTools(src);
  const state: RenderState = {
    n: 0,
    lines: ["flowchart TD"],
    clauses,
    agentic,
    stack: [],
    sawAnswer: false,
    phaseOpen: false,
    includeLogic: opts.includeLogic !== false,
    logicNodes: new Map(),
    factRefs: new Set(),
  };
  const nid = () => `n${++state.n}`;
  const node = (shape: [string, string], label: string, klass: string): string => {
    const id = nid();
    state.lines.push(`  ${id}${shape[0]}"${label.replace(/"/g, "'")}"${shape[1]}:::${klass}`);
    return id;
  };
  const edge = (a: string, b: string, label?: string) =>
    state.lines.push(`  ${a} ${label ? `-->|${label}|` : "-->"} ${b}`);

  /** Record user predicates referenced by a condition so their logic still gets a block. */
  const registerLogicRefs = (text: string, nodeId: string): void => {
    for (const name of headNamesIn(text)) {
      const bodies = clauses.get(name);
      if (!bodies || BUILTIN.has(name) || name === "agent_main") continue;
      if (isFactClauses(bodies)) {
        if (bodies.length >= 2) state.factRefs.add(name);
        continue;
      }
      if (agentic.has(name)) continue;
      const referenced = state.logicNodes.get(name) ?? [];
      referenced.push(nodeId);
      state.logicNodes.set(name, referenced);
    }
  };

  function renderGoals(goals: Goal[], ctx = "", topLevel = false): Segment {
    let entry: string | null = null;
    let exit: string | null = null;
    for (const { goal } of goals) {
      if (topLevel) {
        const ph = phaseLabel(goal);
        if (ph) {
          if (state.phaseOpen) {
            state.lines.push("  end");
            state.phaseOpen = false;
          }
          state.lines.push(`  subgraph ph${++state.n}["${ph.replace(/"/g, "'")}"]`);
          state.lines.push("    direction TB");
          state.phaseOpen = true;
          continue;
        }
      }
      const h = headName(stripOuterParens(goal));
      if (!parseArrow(goal) && h && BUILTIN.has(h)) continue;
      const seg = renderGoal(goal, ctx);
      if (!seg || !seg.entry) continue;
      if (!entry) entry = seg.entry;
      if (exit) edge(exit, seg.entry);
      exit = seg.exit ?? seg.entry;
    }
    return { entry, exit };
  }

  function renderGoal(rawGoal: string, ctx = ""): Segment | null {
    const goal = stripOuterParens(rawGoal);
    const h = headName(goal);

    const br = parseArrow(goal);
    if (br) {
      const d = node(["{", "}"], `if ${trunc(br.cond, 46)}`, "det");
      if (state.includeLogic) registerLogicRefs(br.cond, d);
      const t = renderGoals(splitGoals(br.then), ctx);
      const e = br.else.trim() ? renderGoals(splitGoals(br.else), ctx) : null;
      const merge = nid();
      state.lines.push(`  ${merge}["merge"]:::det`);
      edge(d, t.entry ?? merge, "then");
      edge(d, e?.entry ?? merge, "else");
      if (t.exit) edge(t.exit, merge);
      if (e?.exit) edge(e.exit, merge);
      return { entry: d, exit: merge };
    }

    if (h === "with_tools") {
      const inside = goal.slice(goal.indexOf("(") + 1, goal.lastIndexOf(")"));
      const parts = splitTop(inside, ",");
      const toolList = (parts[0] || "").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
      const sg = `scope${++state.n}`;
      state.lines.push(`  subgraph ${sg}["with_tools: ${trunc(toolList, 60)}"]`);
      state.lines.push("    direction TB");
      const saved = state.lines;
      state.lines = [];
      const inner = renderGoals(splitGoals(parts.slice(1).join(",")), ctx);
      const innerLines = state.lines;
      state.lines = saved;
      for (const l of innerLines) state.lines.push(`  ${l}`);
      state.lines.push("  end");
      return inner.entry ? inner : null;
    }

    const k = kindFor(goal, ctx);
    if (k) {
      if (opts.hideOutput && k.cls === "out") return null;
      if (k.terminal) state.sawAnswer = true;
      return { entry: node(k.shape, k.label, k.cls), exit: null };
    }

    if (h && clauses.has(h)) {
      const bodies = clauses.get(h)!;
      const isFact = bodies.every((c) => !c.body.trim());
      if (isFact) {
        if (bodies.length >= 2) state.factRefs.add(h);
        return null;
      }
      if (agentic.has(h) && !state.stack.includes(h)) {
        state.stack.push(h);
        const seg = renderGoals(splitGoals(bodies[0]?.body ?? ""), h);
        state.stack.pop();
        return seg.entry ? seg : null;
      }
      const label = state.includeLogic ? `${h}/${predicateArity(bodies)}` : `${h}()`;
      const id = node(["[[", "]]"], label, "det");
      if (state.includeLogic) {
        const referenced = state.logicNodes.get(h) ?? [];
        referenced.push(id);
        state.logicNodes.set(h, referenced);
      }
      return { entry: id, exit: null };
    }
    return null;
  }

  const mains = clauses.get("agent_main") ?? [];
  const args0 = (mains[0]?.args ?? "").trim();
  const arity = args0 ? splitTop(args0, ",").filter(Boolean).length : 0;
  const start = node(["([", "])"], `agent_main/${arity}<br/>${basename(file)}`, "start");
  const body = renderGoals(splitGoals(mains[0]?.body ?? ""), "", true);
  if (state.phaseOpen) {
    state.lines.push("  end");
    state.phaseOpen = false;
  }
  if (body.entry) edge(start, body.entry);
  if (!state.sawAnswer) edge(body.exit ?? body.entry ?? start, node(["([", "])"], "done", "terminal"));
  if (mains.length > 1) edge(start, node(["([", "])"], "fallback clause (usage)", "terminal"), "on failure");

  if (tools.length) {
    state.lines.push('  subgraph CAP["tool/2 capabilities"]');
    state.lines.push("    direction LR");
    tools.forEach((t, i) => state.lines.push(`    tool${i}[["${t.name}(${trunc(t.args, 26)})"]]:::tool`));
    state.lines.push("  end");
  }

  if (state.includeLogic) {
    const { logic, facts } = collectLogic(clauses, [...state.logicNodes.keys(), ...state.factRefs]);
    if (logic.size || facts.size) {
      const edges: string[] = [];
      if (logic.size) {
        state.lines.push('  subgraph LOGIC["core decision logic"]');
        state.lines.push("    direction TB");
        let index = 0;
        for (const [name, bodies] of logic) {
          const sg = `lg${++index}`;
          state.lines.push(`    subgraph ${sg}["${name}/${predicateArity(bodies)}"]`);
          state.lines.push("      direction TB");
          bodies.forEach((clause, ci) => {
            const description = describeClause(clause) || "(clause)";
            state.lines.push(`      ${sg}c${ci}["${ci + 1}) ${description}"]:::det`);
          });
          state.lines.push("    end");
          for (const nodeId of state.logicNodes.get(name) ?? []) {
            edges.push(`  ${nodeId} -.->|"core logic"| ${sg}`);
          }
        }
        state.lines.push("  end");
      }
      if (facts.size) {
        state.lines.push('  subgraph RULES["rule facts"]');
        state.lines.push("    direction LR");
        let index = 0;
        for (const [name, bodies] of facts) {
          state.lines.push(`    rf${++index}["${factSummary(name, bodies)}"]:::det`);
        }
        state.lines.push("  end");
      }
      state.lines.push(...edges);
    }
  }

  state.lines.push(
    "  classDef start fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;",
    "  classDef terminal fill:#e3f2fd,stroke:#1565c0;",
    "  classDef llm fill:#fff8e1,stroke:#f9a825,stroke-width:2px;",
    "  classDef det fill:#eceff1,stroke:#546e7a;",
    "  classDef host fill:#f3e5f5,stroke:#6a1b9a;",
    "  classDef out fill:#fafafa,stroke:#bdbdbd;",
    "  classDef tool fill:#ede7f6,stroke:#4527a0;",
  );
  return state.lines.join("\n");
}

// ---------- sequence view ----------------------------------------------------

const clamp = (s: string, n = 72): string =>
  s.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, n);

export function renderSequence(file: string, src: string): string {
  const clauses = extractClauses(stripComments(src));
  const agentic = agenticPredicates(clauses);
  const lines = [
    "sequenceDiagram",
    "  autonumber",
    "  actor U as User",
    "  participant M as Agent (LLM)",
    "  participant P as Prolog spine",
    "  participant E as Tools / Env",
  ];
  const state: { clauses: ClauseMap; agentic: Set<string>; stack: string[]; scope: string[][] } = {
    clauses,
    agentic,
    stack: [],
    scope: [],
  };

  const execName = (g: string): string => {
    const i = g.indexOf("(");
    const inner = i >= 0 ? g.slice(i + 1, g.lastIndexOf(")")) : g;
    return headName(splitTop(inner, ",")[0] ?? "") || "tool";
  };

  function taskMsg(g: string, ctx: string): void {
    const scope = state.scope[state.scope.length - 1] || [];
    const label = clamp(firstString(g) || ctx || firstArgVar(g) || "task");
    lines.push(`  P->>M: task — ${label}`);
    if (scope.includes("user_feedback")) {
      lines.push("  M->>U: present case / ask");
      lines.push("  U-->>M: ok or corrections");
      lines.push("  M-->>P: confirmed result");
    } else if (scope.length) {
      for (const t of scope) lines.push(`  M->>E: ${clamp(t, 30)}(...)`);
      lines.push("  E-->>M: tool results");
      lines.push("  M-->>P: summary");
    } else {
      lines.push("  M-->>P: typed result");
    }
  }

  function walk(goals: Goal[], ctx = ""): void {
    for (const { goal } of goals) {
      const g = stripOuterParens(goal);
      const h = headName(g);
      const br = parseArrow(g);
      if (br) {
        lines.push(`  alt ${clamp(br.cond, 40)}`);
        walk(splitGoals(br.then), ctx);
        if (br.else.trim()) {
          lines.push("  else");
          walk(splitGoals(br.else), ctx);
        }
        lines.push("  end");
        continue;
      }
      if (h === "with_tools") {
        const inside = g.slice(g.indexOf("(") + 1, g.lastIndexOf(")"));
        const parts = splitTop(inside, ",");
        const scope = (parts[0] || "").replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
        state.scope.push(scope);
        walk(splitGoals(parts.slice(1).join(",")), ctx);
        state.scope.pop();
        continue;
      }
      if (!br && h && BUILTIN.has(h)) continue;
      if (h === "system") {
        lines.push(`  Note over M: ${clamp(firstString(g) || "role + rules")}`);
        continue;
      }
      if (h === "task") {
        taskMsg(g, ctx);
        continue;
      }
      if (h === "prompt") {
        lines.push(`  P->>M: review — ${clamp(firstString(g) || ctx || firstArgVar(g) || "review")}`);
        lines.push("  M-->>P: verdict + reason");
        continue;
      }
      if (h === "exec") {
        lines.push(`  P->>E: ${execName(g)}`);
        lines.push("  E-->>P: result");
        continue;
      }
      if (h === "answer") {
        lines.push("  P->>U: final answer");
        continue;
      }
      if (h === "output") {
        const ph = phaseLabel(g);
        if (ph) lines.push(`  Note over P: ${clamp(ph)}`);
        continue;
      }
      if (h && clauses.has(h) && agentic.has(h) && !state.stack.includes(h)) {
        state.stack.push(h);
        walk(splitGoals(clauses.get(h)?.[0]?.body ?? ""), h);
        state.stack.pop();
        continue;
      }
      if (h && clauses.has(h)) {
        if (clauses.get(h)!.every((c) => !c.body.trim())) continue;
        lines.push(`  P->>P: ${h}()`);
      }
    }
  }

  walk(splitGoals(clauses.get("agent_main")?.[0]?.body ?? ""));
  return lines.join("\n");
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || file;
}
