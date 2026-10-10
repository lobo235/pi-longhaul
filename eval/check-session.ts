/**
 * Vets a recorded evaluation session before it is committed: the transcript must come from the sandbox
 * (cwd /work/<name>), name only the label model, have no answer cut at the output limit or failed, mention no
 * absolute path outside the sandbox's own places, and match nothing on an optional private denylist.
 *
 *   node eval/check-session.ts --name NAME --label provider/id [--denylist FILE] [--allow FILE] TRANSCRIPT
 *
 * Both files hold "allow <regex>" and "deny <regex>" lines (case-insensitive; --allow takes allow lines only,
 * for reviewed example paths the model wrote); an allow match is blanked before the path scan and the deny
 * rules run. The --allow file may also excuse a reviewed cut, "length <name>:<line>": that one answer, in that
 * session, may stop at the output limit. A failed answer is never excused, and an excused line that is not a
 * cut is itself a finding. Exit 0 clean, 1 findings, 2 usage error.
 */
import * as fs from "node:fs";
import { parseArgs } from "node:util";

export interface CheckOptions { name: string; label: string; deny?: RegExp[]; allow?: RegExp[]; excusedCuts?: number[] }
export interface CheckReport { findings: string[]; turns: number; compactions: number }

const PATH_RE = /(?<![\w.:/~-])\/[A-Za-z][\w.@+-]*(?:\/[\w.@+-]+)+/g;
const SANDBOX_ROOTS = ["/home/user", "/tmp", "/opt/node", "/opt/pi", "/usr", "/bin", "/lib", "/dev", "/proc", "/etc"];

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

function insideSandbox(found: string, name: string): boolean {
  return [`/work/${name}`, ...SANDBOX_ROOTS].some((root) => found === root || found.startsWith(`${root}/`));
}

function scanText(text: string, options: CheckOptions, where: string, findings: string[]): void {
  const visible = (options.allow ?? []).reduce((out, rule) => out.replace(new RegExp(rule.source, "gi"), (hit) => " ".repeat(hit.length)), text);
  for (const match of visible.match(PATH_RE) ?? []) {
    const found = match.replace(/\.+$/, ""); // a sentence's full stop is not part of the path
    if (!insideSandbox(found, options.name)) findings.push(`${where}: path ${found}`);
  }
  for (const rule of options.deny ?? []) if (new RegExp(rule.source, "i").test(visible)) findings.push(`${where}: denylist ${rule.source}`);
}

type Entry = { type?: string; cwd?: string; provider?: string; modelId?: string;
  message?: { role?: string; provider?: string; model?: string; stopReason?: string } };

function modelOf(entry: Entry): string | undefined {
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
  if (entry.message?.role === "assistant") return `${entry.message.provider}/${entry.message.model}`;
  return undefined;
}

export function checkSession(lines: string[], options: CheckOptions): CheckReport {
  const report: CheckReport = { findings: [], turns: 0, compactions: 0 };
  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1}`;
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; } catch { report.findings.push(`${where}: not JSON`); continue; }
    if (index === 0 && entry.type !== "session") report.findings.push(`${where}: not a session header`);
    if (entry.type === "session" && entry.cwd !== `/work/${options.name}`) report.findings.push(`${where}: cwd ${entry.cwd}`);
    const model = modelOf(entry);
    if (model !== undefined && model !== options.label) report.findings.push(`${where}: model ${model}`);
    const stop = entry.message?.role === "assistant" ? entry.message.stopReason : undefined;
    const excused = options.excusedCuts?.includes(index + 1) ?? false;
    if (excused && stop !== "length") report.findings.push(`${where}: excused as a cut at the output limit, but it is not one`);
    if ((stop === "length" && !excused) || stop === "error") report.findings.push(`${where}: stopped at ${stop}`);
    if (entry.type === "compaction") report.compactions++;
    if (entry.message?.role === "user") report.turns++;
    for (const text of strings(entry)) scanText(text, options, where, report.findings);
  }
  return report;
}

type RuleKind = "deny" | "allow" | "length";
type Rules = { deny: RegExp[]; allow: RegExp[]; excusedCuts: number[] };

const RULE_FORMS: Record<RuleKind, string> = { deny: "'deny <regex>'", allow: "'allow <regex>'", length: "'length <name>:<line>'" };

/** A rule file's text: deny and allow regexes, and the cuts it excuses in session `name`. Throws on a malformed line. */
export function parseRules(text: string, file: string, kinds: readonly RuleKind[], name: string): Rules {
  const rules: Rules = { deny: [], allow: [], excusedCuts: [] };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [kind, ...rest] = line.split(/\s+/);
    const refuse = () => new Error(`${file}: expected ${kinds.map((k) => RULE_FORMS[k]).join(" or ")}: ${line}`);
    if (!kinds.includes(kind as RuleKind) || rest.length === 0) throw refuse();
    if (kind === "length") {
      const cut = /^(.+):([1-9]\d*)$/.exec(rest.join(" "));
      if (!cut) throw refuse();
      if (cut[1] === name) rules.excusedCuts.push(Number(cut[2]));
      continue;
    }
    rules[kind as "deny" | "allow"].push(new RegExp(rest.join(" "), "i"));
  }
  return rules;
}

function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { name: { type: "string" }, label: { type: "string" }, denylist: { type: "string" }, allow: { type: "string" } } });
  if (!values.name || !values.label || positionals.length !== 1) {
    process.stderr.write("usage: check-session.ts --name NAME --label provider/id [--denylist FILE] [--allow FILE] TRANSCRIPT\n");
    return 2;
  }
  const read = (file: string, kinds: readonly RuleKind[]) => parseRules(fs.readFileSync(file, "utf8"), file, kinds, values.name!);
  const denylist = values.denylist ? read(values.denylist, ["deny", "allow"]) : undefined;
  const examples = values.allow ? read(values.allow, ["allow", "length"]) : undefined;
  const rules = { deny: denylist?.deny ?? [], allow: [...(denylist?.allow ?? []), ...(examples?.allow ?? [])], excusedCuts: examples?.excusedCuts ?? [] };
  const lines = fs.readFileSync(positionals[0], "utf8").split("\n").filter((line) => line.trim());
  const report = checkSession(lines, { name: values.name, label: values.label, ...rules });
  for (const finding of report.findings) process.stdout.write(`${finding}\n`);
  process.stdout.write(`${report.turns} user turns, ${report.compactions} compactions, ${report.findings.length} finding(s)\n`);
  return report.findings.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
