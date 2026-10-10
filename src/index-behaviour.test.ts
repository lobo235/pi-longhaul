import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import compactionStateExtension from "./index.ts";
import { COMPACTOR_ENV, selectCompactor, STATE_LOADED_ENV } from "./select.ts";
import { SPAN_ENTRY_TYPE } from "./store/events.ts";
import { LINE_ENTRY_TYPE, readCompactionLine, renderCompactionLine } from "./compaction-line.ts";
import { assistantEntry, chain, fakeCtx, fakePi, modelWith, NOT_RULES, textResponse, userEntry, withEnv } from "./test-support.ts";
import { readPiCompat } from "./pi-compat.ts";

/** A pi this release lists, and one it cannot: so a notice test does not change with the pi that is installed. */
const VERIFIED_PI = readPiCompat().verified.at(-1)!.pi;
const UNVERIFIED_PI = "999.0.0";

test("loading the extension sets the loaded marker for another compactor's gate, keyed to this process", async () => {
  await withEnv({ [STATE_LOADED_ENV]: undefined, PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    compactionStateExtension(fakePi().pi);
    assert.equal(process.env[STATE_LOADED_ENV], String(process.pid));
    assert.equal(selectCompactor(process.env).stateLoaded, true);
  });
});

test("session_before_compact answers nothing when the user opted out with PI_COMPACTOR=pi", async () => {
  await withEnv({ [COMPACTOR_ENV]: "pi", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx, notices } = fakeCtx();
    const result = await emit("session_before_compact", { preparation: { messagesToSummarize: [], turnPrefixMessages: [] }, branchEntries: [], reason: "threshold", willRetry: false, signal: new AbortController().signal }, ctx);
    assert.equal(result, undefined);
    assert.deepEqual(notices, []);
  });
});

for (const selector of ["state", undefined]) test(`session_before_compact → session_compact (PI_COMPACTOR ${selector ?? "unset: the default"}): the compaction result is the rendered state and the span record is appended with the entry id`, async () => {
  await withEnv({ PI_COMPACTOR: selector, PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, entries, emit } = fakePi();
    compactionStateExtension(pi);
    const branch = chain([userEntry("m1", "Build the state compactor and keep the ledger modules as they are"), assistantEntry("a1", "ok")]);
    const diff = JSON.stringify({ narrative: "n", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "r" } });
    const { ctx, notices } = fakeCtx({ branch, model: modelWith({ provider: "example", id: "model-a", contextWindow: 131072 }), complete: async () => textResponse("```json\n" + diff + "\n```") });
    const messages = branch.map((entry) => (entry as { message: AgentMessage }).message);
    const result = (await emit("session_before_compact", { preparation: { firstKeptEntryId: "a1", messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 50_000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: {} }, branchEntries: branch, reason: "threshold", willRetry: false, signal: new AbortController().signal }, ctx)) as { compaction: { summary: string; details: unknown } } | undefined;
    assert.match(result?.compaction?.summary ?? "", /^# Session state \(span 2/);
    assert.equal(entries.length, 0, "nothing is appended before the compaction entry exists");
    await emit("session_compact", { compactionEntry: { id: "c1", type: "compaction", summary: result?.compaction.summary, tokensBefore: 50_000, details: result?.compaction.details, fromHook: true }, fromExtension: true, reason: "threshold", willRetry: false }, ctx);
    // pi draws its compaction block on compaction_end, which it emits right after session_compact returns and which
    // clears and redraws the chat: a line appended during session_compact lands above the block, so it waits a turn.
    assert.deepEqual(entries.map((entry) => entry.customType), [SPAN_ENTRY_TYPE], "the line waits for pi's own compaction block");
    await new Promise(setImmediate);
    assert.deepEqual(entries.map((entry) => entry.customType), [SPAN_ENTRY_TYPE, LINE_ENTRY_TYPE]);
    const data = entries[0].data as { span: number; compactionEntryId: string };
    assert.deepEqual({ span: data.span, compactionEntryId: data.compactionEntryId }, { span: 1, compactionEntryId: "c1" });
    const line = readCompactionLine(entries[1].data);
    assert.ok(line?.by === "longhaul", JSON.stringify(entries[1].data));
    assert.ok(line.durationMs >= 0 && line.durationMs < 60_000, String(line.durationMs));
    assert.deepEqual({ span: line.span, calls: line.calls, tokensBefore: line.tokensBefore, stateChars: line.stateChars }, { span: 1, calls: 1, tokensBefore: 50_000, stateChars: result!.compaction.summary.length });
    assert.match(notices.at(-1)?.text ?? "", /^longhaul: span 1 closed/);
  });
});

test("a pass that throws falls back to pi with a warning; the pi-made compaction gets a line saying so, and no record", async () => {
  await withEnv({ PI_COMPACTOR: "state", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, entries, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx, notices } = fakeCtx({ branch: [], model: modelWith() });
    const result = await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    assert.equal(result, undefined);
    assert.match(notices.at(-1)?.text ?? "", /the compaction failed.*pi's own compaction was used/);
    await emit("session_compact", { compactionEntry: { id: "c1", type: "compaction", summary: "pi's", tokensBefore: 1, fromHook: false }, fromExtension: false, reason: "manual", willRetry: false }, ctx);
    await new Promise(setImmediate);
    assert.deepEqual(entries.map((entry) => entry.customType), [LINE_ENTRY_TYPE]);
    const line = readCompactionLine(entries[0].data);
    assert.ok(line?.by === "pi", JSON.stringify(entries[0].data));
    assert.equal(line.tokensBefore, 1);
    assert.ok(line.fallback.errorClass.length > 0 && line.fallback.error.length > 0, JSON.stringify(line.fallback));
  });
});

test("the Compaction line's renderer is registered for its entry type", () => {
  const { pi, entryRenderers } = fakePi();
  compactionStateExtension(pi);
  assert.equal(entryRenderers.get(LINE_ENTRY_TYPE), renderCompactionLine);
});

test("no Compaction line when the user opted out, for a compaction another extension made, or after a failed one", async () => {
  const compacted = (fromExtension: boolean) => ({ compactionEntry: { id: "c1", type: "compaction", summary: "s", tokensBefore: 1, fromHook: fromExtension }, fromExtension, reason: "manual", willRetry: false });
  await withEnv({ PI_COMPACTOR: "pi", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, entries, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx } = fakeCtx({ branch: [], model: modelWith() });
    await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    await emit("session_compact", compacted(false), ctx);
    await new Promise(setImmediate);
    assert.deepEqual(entries, [], "opted out");
  });
  await withEnv({ PI_COMPACTOR: "state", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, entries, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx } = fakeCtx({ branch: [], model: modelWith() });
    await emit("session_compact", compacted(true), ctx);
    await new Promise(setImmediate);
    assert.deepEqual(entries, [], "a compaction Longhaul's hook never saw");
    await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    await emit("session_compact_failed", { reason: "manual", errorMessage: "x", aborted: false, willRetry: false, fromExtension: false }, ctx);
    await emit("session_compact", compacted(true), ctx);
    await new Promise(setImmediate);
    assert.deepEqual(entries, [], "the failed compaction's timer does not carry over to a later one");
  });
});

test("a fallback is logged as its error class and a short message, no stack, in a log only the user can read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-log-"));
  const logFile = path.join(dir, "logs", "compaction-state.jsonl");
  try {
    await withEnv({ PI_COMPACTOR: "state", PI_COMPACT_STATE_DEBUG: logFile, PI_COMPACT_STATE_DEBUG_STACK: undefined }, async () => {
      const { pi, emit } = fakePi();
      compactionStateExtension(pi);
      const { ctx } = fakeCtx({ branch: [], model: modelWith() });
      await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    });
    const records = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const fallback = records.find((record) => record.event === "fallback");
    assert.equal(fallback.errorClass, "TypeError");
    assert.equal(fallback.stack, undefined);
    if (process.platform !== "win32") { // Windows has no POSIX modes (security.md T6)
      assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(logFile)).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const compactEvent = (details: unknown, fromExtension: boolean) => ({ compactionEntry: { id: "c9", type: "compaction", summary: "someone else's summary", tokensBefore: 1, details, fromHook: fromExtension }, fromExtension, reason: "threshold", willRetry: false });

test("a compaction the State compactor did not make warns once per session, naming who made it", async () => {
  await withEnv({ PI_COMPACTOR: undefined, PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx, notices } = fakeCtx({ model: modelWith() });
    await emit("session_start", { reason: "startup" }, ctx);
    await emit("session_compact", compactEvent({ compactor: "observational-memory" }, true), ctx);
    await emit("session_compact", compactEvent(undefined, false), ctx);
    const warnings = notices.filter((notice) => /did not make this compaction/.test(notice.text));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warning");
    assert.match(warnings[0].text, /another extension/);
    await emit("session_start", { reason: "new" }, ctx);
    await emit("session_compact", compactEvent(undefined, false), ctx);
    assert.match(notices.at(-1)?.text ?? "", /did not make this compaction.*pi's own summarizer/);
  });
});

test("no foreign-compaction warning when the user opted out, or after the State compactor's own fallback warning", async () => {
  await withEnv({ PI_COMPACTOR: "pi", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx, notices } = fakeCtx({ model: modelWith() });
    await emit("session_compact", compactEvent({ compactor: "another-compactor" }, true), ctx);
    assert.deepEqual(notices, []);
  });
  await withEnv({ PI_COMPACTOR: "state", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx, notices } = fakeCtx({ branch: [], model: modelWith() });
    await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    await emit("session_compact", compactEvent(undefined, false), ctx);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /the compaction failed/);
  });
});

test("a session model with a context window under 32k warns once per session, at start or when the model changes", async () => {
  await withEnv({ PI_COMPACTOR: undefined, PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const small = modelWith({ id: "tiny", contextWindow: 16_384 });
    const big = modelWith({ id: "roomy", contextWindow: 131_072 });
    const { pi, emit } = fakePi();
    compactionStateExtension(pi, { piVersion: VERIFIED_PI });
    const roomy = fakeCtx({ model: big });
    await emit("session_start", { reason: "startup" }, roomy.ctx);
    assert.equal(roomy.notices.length, 0);
    await emit("model_select", { model: small, previousModel: big, source: "set" }, roomy.ctx);
    await emit("model_select", { model: modelWith({ id: "tinier", contextWindow: 8_192 }), previousModel: small, source: "set" }, roomy.ctx);
    assert.equal(roomy.notices.length, 1);
    assert.match(roomy.notices[0].text, /tiny.*16,384.*32,768/);
    assert.equal(roomy.notices[0].level, "warning");
    const tight = fakeCtx({ model: small });
    await emit("session_start", { reason: "new" }, tight.ctx);
    assert.match(tight.notices.at(-1)?.text ?? "", /context window/);
  });
});

test("at load the log records the running pi and whether this release was verified against it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases: Array<[string, string, boolean | "line"]> = [["a listed pi", VERIFIED_PI, true], ["a pi no line lists", UNVERIFIED_PI, false]];
  for (const [name, piVersion, verified] of cases) {
    const log = path.join(dir, `${name}.jsonl`);
    await withEnv({ PI_COMPACT_STATE_DEBUG: log }, async () => compactionStateExtension(fakePi().pi, { piVersion }));
    const loaded = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.event === "extension-loaded");
    assert.deepEqual([loaded?.piVersion, loaded?.piVersionVerified], [piVersion, verified], name);
  }
});

test("on a pi this release was not verified against, a State session warns once at start and names the version", async () => {
  await withEnv({ PI_COMPACTOR: undefined, PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi, { piVersion: UNVERIFIED_PI });
    const { ctx, notices } = fakeCtx({ model: modelWith() });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(notices.map((notice) => notice.level), ["warning"]);
    assert.match(notices[0].text, new RegExp(`pi ${UNVERIFIED_PI.replace(/\./g, "\\.")} has not been verified`));
  });
});

test("no small-window warning when the user opted out of the State compactor", async () => {
  await withEnv({ PI_COMPACTOR: "pi", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi, { piVersion: UNVERIFIED_PI });
    const { ctx, notices } = fakeCtx({ model: modelWith({ contextWindow: 8_192 }) });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(notices, []);
  });
});

test("a localOnlyRoots entry that cannot match warns, naming it, at session start and after an edit at the next compaction", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const write = (roots: string[]) => fs.writeFileSync(path.join(agentDir, "longhaul.json"), JSON.stringify({ localOnlyRoots: roots }));
  // A path of the other platform can never match this one's session directories.
  const [usable, unusable] = process.platform === "win32" ? ["C:\\ok", "/srv/work"] : ["/srv/ok", "C:\\work"];
  await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_COMPACTOR: "state", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    write([usable, unusable]);
    const { pi, emit } = fakePi();
    compactionStateExtension(pi);
    const { ctx, notices } = fakeCtx({ branch: [], model: modelWith() });
    await emit("session_start", { reason: "startup" }, ctx);
    const named = (entry: string) => notices.filter((notice) => notice.text.includes(`"${entry}"`) && /localOnlyRoots/.test(notice.text));
    assert.equal(named(usable).length, 0);
    assert.equal(named(unusable).length, 1);
    assert.equal(named(unusable)[0].level, "warning");
    write([usable, unusable, "relative/dir"]);
    await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    assert.equal(named("relative/dir").length, 1, "an entry added mid-session is named at the next compaction");
    await emit("session_before_compact", { preparation: undefined, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal }, ctx);
    assert.equal(named("relative/dir").length, 1, "once per session");
  });
});

test("no localOnlyRoots warning when the user opted out of the State compactor", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, "longhaul.json"), JSON.stringify({ localOnlyRoots: ["C:\\work"] }));
  await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_COMPACTOR: "pi", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const { pi, emit } = fakePi();
    compactionStateExtension(pi, { piVersion: UNVERIFIED_PI });
    const { ctx, notices } = fakeCtx({ model: modelWith() });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(notices, []);
  });
});

test("the compaction's own model call carries the summarizerHeaders configured for the session's provider", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, "longhaul.json"), JSON.stringify({ summarizerHeaders: { local: { "x-session-affinity": "{sessionId}" } } }));
  const diff = JSON.stringify({ narrative: "n", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "r" } });
  const compactOn = async (provider: string) => {
    const calls: Array<{ transformHeaders?: (h: Record<string, string | null>) => Promise<Record<string, string | null>> }> = [];
    const { pi, emit } = fakePi();
    compactionStateExtension(pi);
    const branch = chain([userEntry("m1", "Build the state compactor"), assistantEntry("a1", "ok")]);
    const { ctx } = fakeCtx({ branch, model: modelWith({ provider, id: "m", contextWindow: 131072 }), complete: async (_model, _context, options) => { calls.push(options as never); return textResponse("```json\n" + diff + "\n```"); } });
    const messages = branch.map((entry) => (entry as { message: AgentMessage }).message);
    await emit("session_before_compact", { preparation: { firstKeptEntryId: "a1", messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 50_000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: {} }, branchEntries: branch, reason: "threshold", willRetry: false, signal: new AbortController().signal }, ctx);
    return calls;
  };
  await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_COMPACTOR: "state", PI_COMPACT_STATE_DEBUG: "off" }, async () => {
    const configured = await compactOn("local");
    assert.ok(configured.length > 0);
    assert.deepEqual(await configured[0].transformHeaders?.({}), { "x-session-affinity": "session-1" });
    const other = await compactOn("cloud-vendor");
    assert.equal(other[0].transformHeaders, undefined, "a provider the config does not name gets no header transform");
  });
});

test("context: the kept window loses its thinking on a verified API, unless longhaul.json says keep or the State compactor stands down; one log record per cutoff", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const logFile = path.join(agentDir, "log.jsonl");
  const thinking = (timestamp: number) => ({ role: "assistant", timestamp, content: [{ type: "thinking", thinking: "old", thinkingSignature: "reasoning_content" }, { type: "text", text: "t" }] });
  const messages = [{ role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 5000 }, thinking(4000), { role: "user", content: "go", timestamp: 6000 }];
  const run = async (env: Record<string, string | undefined>, config: object) => {
    fs.writeFileSync(path.join(agentDir, "longhaul.json"), JSON.stringify(config));
    return withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_COMPACT_STATE_DEBUG: logFile, ...env }, async () => {
      const { pi, emit } = fakePi();
      compactionStateExtension(pi);
      const { ctx } = fakeCtx({ model: modelWith({ api: "openai-completions" } as never) });
      await emit("session_start", { reason: "startup" }, ctx);
      const first = (await emit("context", { messages }, ctx)) as { messages: Array<{ content: unknown }> } | undefined;
      await emit("context", { messages }, ctx);
      return first;
    });
  };
  const stripped = await run({ PI_COMPACTOR: "state" }, {});
  assert.deepEqual(stripped?.messages[1].content, [{ type: "text", text: "t" }]);
  const records = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.event === "kept-window-strip");
  assert.equal(records.length, 1, "one record per cutoff, not per request");
  assert.deepEqual({ cutoff: records[0].cutoff, strippedBlocks: records[0].strippedBlocks }, { cutoff: 5000, strippedBlocks: 1 });
  assert.equal(await run({ PI_COMPACTOR: "state" }, { keptWindowThinking: "keep" }), undefined);
  assert.equal(await run({ PI_COMPACTOR: "pi" }, {}), undefined, "a stood-down Longhaul leaves the request to whoever compacts");
});

test("/longhaul-report writes a private report next to the log and names it; the report carries the version and no session id or directory", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(agentDir, "logs"));
  fs.writeFileSync(path.join(agentDir, "logs", "compaction-state.jsonl"), `${JSON.stringify({ event: "compaction", sessionId: "session-1", cwd: "/tmp/project", span: 4 })}\n`);
  fs.writeFileSync(path.join(agentDir, "longhaul.json"), JSON.stringify({ narrativeMode: "turns" }));
  await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_COMPACT_STATE_DEBUG: undefined }, async () => {
    const { pi, commands } = fakePi();
    compactionStateExtension(pi);
    const command = commands.get("longhaul-report");
    assert.ok(command, "the command is registered");
    const { ctx, notices } = fakeCtx({ model: modelWith({ api: "openai-completions" } as never) });
    await command.handler("", ctx);
    const file = path.join(agentDir, "logs", "longhaul-report.md");
    const report = fs.readFileSync(file, "utf8");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); // no POSIX modes on Windows (security.md T6)
    const version = (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    assert.ok(report.includes(`Longhaul ${version}`));
    assert.ok(report.includes('"span":4') && report.includes("narrativeMode: turns"));
    assert.ok(!report.includes("session-1") && !report.includes("/tmp/project"));
    assert.ok(!report.includes(ctx.model!.provider) && !report.includes(ctx.model!.id), "neither provider nor model id");
    assert.match(notices.at(-1)?.text ?? "", /longhaul-report\.md/);
  });
});
