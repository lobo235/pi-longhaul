import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { pathTo, readTranscript } from "../src/score/candidates.ts";
import { mentions } from "../src/score/facts.ts";
import { parseLabels } from "../src/score/labels.ts";
import { buildToolContext } from "../src/tool-context.ts";

const SESSIONS = path.join(import.meta.dirname, "sessions");
const labels = parseLabels(fs.readFileSync(path.join(SESSIONS, "labels.json"), "utf8"));

/** Every message of each turn, by the turn's user ordinal, as text: the user's words, replies, call arguments and tool output. */
function turnsOf(branch: SessionEntry[]): Map<string, string> {
  const turns = new Map<string, string>();
  let ordinal = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role: string; content?: unknown; output?: unknown };
    if (message.role === "user") ordinal++;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? JSON.stringify(block.arguments ?? {}) : "")).join("\n") : String(message.output ?? "");
    turns.set(`u${ordinal}`, `${turns.get(`u${ordinal}`) ?? ""}\n${text}`);
  }
  return turns;
}

for (const [name, session] of Object.entries(labels)) {
  test(`labels bind to the recorded ${name}: each rule's quote is in its message, each value is in its turn`, () => {
    const entries = readTranscript(path.join(SESSIONS, `${name}.jsonl`));
    assert.ok(entries.length > 0, `${name}.jsonl is in eval/sessions`);
    const branch = pathTo(entries, entries.at(-1)!.id);
    const index = buildToolContext(branch).index;
    const turns = turnsOf(branch);
    for (const rule of session.rules) {
      assert.ok(index.textOf(rule.at)?.includes(rule.quote), `${name} ${rule.at}: Longhaul's ${rule.at} holds the quote`);
      if (rule.liftedAt) assert.ok(index.textOf(rule.liftedAt), `${name}: the lift ${rule.liftedAt} exists`);
    }
    for (const value of session.values) {
      assert.ok(value.value.some((spelling) => mentions(turns.get(value.learnedAt) ?? "", spelling)), `${name}: ${value.name} is in turn ${value.learnedAt}`);
      assert.ok(turns.has(value.usedAt), `${name}: turn ${value.usedAt} exists`);
    }
  });
}
