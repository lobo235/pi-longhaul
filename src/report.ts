/**
 * /longhaul-report: what a bug report needs -- versions, the model's API and class, which config keys are set, and
 * the newest log records -- with nothing that names the user's directories, providers, models or messages. Records
 * are digested by allowlist, not scrubbed by denylist: a field the log gains later is left out until it is known
 * to be safe. Issue forms ask for this output, never the raw log.
 */
import fs from "node:fs";

import type { Model } from "@earendil-works/pi-ai";

import type { StateConfig } from "./config.ts";
import { withRegularFile } from "./log.ts";
import type { PiVersionStatus } from "./pi-compat.ts";
import { planReasoning } from "./narrative/reasoning.ts";

/** How much of the log's end is read: the newest records, never the whole (rotating, up to 5 MiB) file. */
const TAIL_BYTES = 256 * 1024;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 5;
const MESSAGE_CHARS = 200;
/** Keys whose values name something of the user's, whatever their shape. */
const DROPPED_KEYS: ReadonlySet<string> = new Set(["cwd", "sessionId", "sessionModel", "spec", "model", "provider", "localOnlyRoot", "routeIgnored", "fallbackReason", "quote", "excerpt", "text", "path", "file"]);
/** A value that is a token -- an event name, a verdict, a timestamp -- not prose, a path or a provider/model pair. */
const TOKEN = /^[A-Za-z0-9_.:+-]{1,48}$/;

/** The newest `count` records of the log at `logPath`; a missing, unreadable or non-file log is none. */
export function readLastRecords(logPath: string, count: number): unknown[] {
  let text = "";
  try {
    withRegularFile(logPath, fs.constants.O_RDONLY, (fd, stat) => {
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    });
  } catch {
    return [];
  }
  const records = text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
  return records.slice(-count);
}

/** The keys whose prose is kept, scrubbed: the log writes a failure's text as `error`. */
const MESSAGE_KEYS = new Set(["error", "message"]);

function scrubMessage(message: string, home: string | undefined): string {
  const homeless = home ? message.split(home).join("~") : message;
  const masked = homeless.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, "<url>").replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>");
  return masked.length > MESSAGE_CHARS ? `${masked.slice(0, MESSAGE_CHARS - 1)}…` : masked;
}

/** One log record reduced to numbers, booleans and short tokens; names, paths and prose are left out. */
export function digestRecord(value: unknown, home: string | undefined, depth = 0, key = ""): unknown {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return MESSAGE_KEYS.has(key) ? scrubMessage(value, home) : TOKEN.test(value) ? value : undefined;
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => digestRecord(item, home, depth + 1)).filter((item) => item !== undefined);
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (DROPPED_KEYS.has(name)) continue;
    const digested = digestRecord(item, home, depth + 1, name);
    if (digested !== undefined) out[name] = digested;
  }
  return out;
}

export function modelClass(model: Model<any> | undefined): string {
  if (!model) return "no model selected";
  if (!model.reasoning) return "no reasoning";
  return planReasoning(model, 1).path === "lowest" ? "must-reason (reasoning cannot be turned off)" : "reasoning, can be turned off";
}

const PI_STATUS: Record<PiVersionStatus, string> = { exact: "verified", line: "same release line as a verified version", unverified: "not verified" };

/** The config keys that are set, by name; an enum shows its value, a list or map its size, anything else its name only. */
function configLine(keys: readonly string[], config: StateConfig): string {
  const known = new Set(["model", "routeProviders", "localOnlyRoots", "summarizerHeaders", "keptWindowThinking", "narrativeMode", "narrativeTurns", "narrativePolicy", "caps", "claimPatterns", "rememberPerSpan", "coldSliceCaps", "nearDuplicateThreshold", "routeFailureThreshold", "routeCooldownMs", "routeMaxRetries"]);
  const shown = keys.filter((key) => known.has(key)).map((key) => {
    if (key === "narrativeMode") return `narrativeMode: ${config.narrativeMode}`;
    if (key === "keptWindowThinking") return `keptWindowThinking: ${config.keptWindowThinking ?? "(invalid, so unset)"}`;
    if (key === "routeProviders" || key === "localOnlyRoots") return `${key} (${config[key].length})`;
    if (key === "summarizerHeaders") return `summarizerHeaders (${Object.keys(config.summarizerHeaders).length})`;
    return key;
  });
  const unknown = keys.length - shown.length;
  return [...shown, ...(unknown > 0 ? [`${unknown} unknown key${unknown === 1 ? "" : "s"}`] : [])].join(", ") || "none";
}

export interface ReportInput {
  longhaulVersion: string;
  piVersion: string;
  piStatus: PiVersionStatus;
  node: string;
  platform: string;
  model: Model<any> | undefined;
  configKeys: readonly string[];
  config: StateConfig;
  records: unknown[];
  home: string | undefined;
}

export function buildReport(input: ReportInput): string {
  const model = input.model ? `API ${input.model.api}, context window ${input.model.contextWindow}, max output ${input.model.maxTokens}, ${modelClass(input.model)}` : modelClass(undefined);
  const records = input.records.map((record) => JSON.stringify(digestRecord(record, input.home)));
  return [
    "## Longhaul report",
    "",
    `- Longhaul ${input.longhaulVersion}`,
    `- pi ${input.piVersion} (${PI_STATUS[input.piStatus]})`,
    `- Node ${input.node} on ${input.platform}`,
    `- Model: ${model}`,
    `- longhaul.json keys set: ${configLine(input.configKeys, input.config)}`,
    "",
    `### Newest log records (${records.length}; names, paths and message text left out)`,
    "",
    "```json",
    ...(records.length ? records : ["(none: the log is off, empty or unreadable)"]),
    "```",
    "",
    "Read it before you post it: error messages are kept, with URLs, IP addresses and your home directory masked.",
    "",
  ].join("\n");
}
