/**
 * `npm run state -- [FILE.jsonl | --session-dir DIR] [--span N] [--json] [--spans] [--anomalies]`
 *
 * Read-only: what the State compactor would show for a transcript right now, from the transcript
 * alone (no pi, no model). Transcript bytes are untrusted: the rendered state and the listings pass
 * through `stripControls` (no C0/DEL/C1 control character reaches the terminal), and `--json` is
 * `JSON.stringify` output, which escapes C0 but is otherwise the data as stored.
 */
import fs from "node:fs";
import path from "node:path";

import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { previousLearnedValues } from "./carry.ts";
import { readConfigFile, resolveStateConfig } from "./config.ts";
import { render, stripControls } from "./render.ts";
import { scrubCredentials } from "./credential-scrub.ts";
import { pathTo, readTranscript } from "./score/candidates.ts";
import { project, projectAt } from "./store/project.ts";
import { buildToolContext } from "./tool-context.ts";

export interface StateCliOptions { file?: string; sessionDir?: string; span?: number; json: boolean; spans: boolean; anomalies: boolean }

const USAGE = "usage: npm run state -- [FILE.jsonl | --session-dir DIR] [--span N] [--json] [--spans] [--anomalies]";

export function parseArgs(argv: string[]): StateCliOptions | { error: string } {
  const options: StateCliOptions = { file: undefined, sessionDir: undefined, span: undefined, json: false, spans: false, anomalies: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--spans") options.spans = true;
    else if (arg === "--anomalies") options.anomalies = true;
    else if (arg === "--session-dir") options.sessionDir = argv[++index];
    else if (arg === "--span") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) return { error: "--span needs a positive integer" };
      options.span = value;
    } else if (arg.startsWith("--")) return { error: `unknown flag ${arg}` };
    else options.file = arg;
  }
  return options;
}

export function newestTranscript(sessionDir: string): string | undefined {
  let newest: { file: string; mtime: number } | undefined;
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.endsWith(".jsonl")) {
        const mtime = fs.statSync(full).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file: full, mtime };
      }
    }
  };
  walk(sessionDir);
  return newest?.file;
}

function spanLines(context: ReturnType<typeof buildToolContext>): string[] {
  return context.log.spans.map((summary) => {
    const record = summary.record;
    const close = record?.events.find((event) => event.kind === "span.close");
    const narrative = close && close.kind === "span.close" ? (close.narrativeLess ? "narrative-less" : `narrative: ${scrubCredentials(close.narrative ?? "").text}`) : "no record";
    return `span ${summary.span}: entry ${summary.compactionEntryId ?? "?"}, ${record?.events.length ?? 0} events, ${record?.ledger.commands.length ?? 0} commands, ${record?.ledger.errors.length ?? 0} errors, ${summary.foreign ? `foreign (${summary.foreign})` : narrative}`;
  });
}

/** The size of the compaction that closed the shown span: the named one, else the newest. */
function tokensBeforeOf(branch: SessionEntry[], context: ReturnType<typeof buildToolContext>, span: number | undefined): number {
  const spans = context.log.spans.filter((summary) => summary.compactionEntryId !== undefined && (span === undefined || summary.span <= span));
  const entryId = spans.at(-1)?.compactionEntryId;
  const entry = branch.find((candidate) => candidate.id === entryId);
  return entry?.type === "compaction" && typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0;
}

export function runStateCli(options: StateCliOptions, write: (text: string) => void): number {
  const file = options.file ?? newestTranscript(options.sessionDir ?? path.join(getAgentDir(), "sessions"));
  if (!file) { write(`no transcript found\n${USAGE}\n`); return 1; }
  let entries: SessionEntry[];
  try {
    entries = readTranscript(file);
  } catch (error) {
    write(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`); return 1;
  }
  const leaf = entries.at(-1);
  if (!leaf) { write(`cannot read ${file}: no entries\n`); return 1; }
  const branch = pathTo(entries, leaf.id);
  const config = resolveStateConfig(readConfigFile);
  const context = buildToolContext(branch);
  if (options.spans) { write(`${stripControls(spanLines(context).join("\n"))}\n`); return 0; }
  if (options.anomalies) { write(context.log.anomalies.length ? `${stripControls(context.log.anomalies.map((anomaly) => JSON.stringify(anomaly)).join("\n"))}\n` : "no anomalies\n"); return 0; }
  const state = options.span === undefined ? project(context.log, config.caps) : projectAt(context.log, options.span, config.caps);
  // A Set (a rule's former ids) prints as its members; JSON.stringify alone gives {}.
  if (options.json) { write(`${JSON.stringify(state, (_key, value: unknown) => (value instanceof Set ? [...value] : value), 2)}\n`); return 0; }
  write(`${render({ state, tokensBefore: tokensBeforeOf(branch, context, options.span), ledger: context.ledger, caps: config.caps, ...(options.span === undefined ? { files: context.files, learned: previousLearnedValues(branch) } : {}) })}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) { process.stderr.write(`${parsed.error}\n${USAGE}\n`); process.exit(2); }
  process.exit(runStateCli(parsed, (text) => process.stdout.write(text)));
}
