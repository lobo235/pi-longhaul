/**
 * Longhaul, the State compactor (ADR 0001; CONTEXT.md *State compactor*).
 *
 * Carries a Session state across compactions instead of a rewritten summary. This file is wiring
 * only: hooks, tool registration, notices. The pass itself is pass.ts; the store is store/; the
 * narrative call is narrative/; the tools are remember-tool.ts and recall-tool.ts.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { VERSION as PI_VERSION, type ContextEvent, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionCompactEvent, type SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";

import { buildSpanRecord } from "./cold.ts";
import { compactionLineFor, LINE_ENTRY_TYPE, renderCompactionLine } from "./compaction-line.ts";
import { appendJsonl, defaultLogPath, privateLogDir, resolveLogPath } from "./log.ts";
import { registryCall } from "./narrative/call.ts";
import { homeDirectory } from "./narrative/route-config.ts";
import { withSummarizerHeaders } from "./narrative/summarizer-headers.ts";
import { createRouteHealth, type RouteHealthState } from "./narrative/route-health.ts";
import { resolveStateConfig, warmModeNotice, type StateConfig } from "./config.ts";
import { readConfigFile, runStatePass, type PendingSpan } from "./pass.ts";
import { piVersionStatus, readPiCompat, unverifiedPiVersionNotice } from "./pi-compat.ts";
import { registerRecallTool } from "./recall-tool.ts";
import { registerRememberTool } from "./remember-tool.ts";
import { registerReportCommand } from "./report-command.ts";
import { selectCompactor, STATE_LOADED_ENV, stateLoadedMarker, stateStandsDown } from "./select.ts";
import { sessionFields, tryRead, type SessionFields } from "./session.ts";
import { logOptionsOf, logSafeError } from "./log-safe.ts";
import { stripKeptWindowContext, type KeptWindowThinking } from "./kept-window.ts";
import { foreignCompactionNotice, localOnlyRootsNotice, smallWindowNotice } from "./notices.ts";
import { requestRunningTasks } from "./tasks.ts";
import { SPAN_ENTRY_TYPE } from "./store/events.ts";

/** One compaction Longhaul's hook took, read back once by session_compact or session_compact_failed. */
interface InFlight {
  /** When it reached the hook: the Compaction line's duration. */
  started: number;
  /** The pass's span record, appended once pi has written the compaction entry. */
  pending?: PendingSpan;
  notice?: string;
  /** Set when the pass failed and said so: pi's summarizer then made it, and the warning already ran. */
  fallback?: { errorClass: string; error: string };
}

type Notify = { ui: { notify?: (text: string, level?: "info" | "warning" | "error") => void } };

/** What the hooks share for the life of the extension. */
interface Runtime {
  pi: ExtensionAPI;
  /** Warnings said once per session; session_start clears them. */
  warned: Set<string>;
  routeHealth: RouteHealthState;
  inFlight?: InFlight;
  /** longhaul.json's keptWindowThinking, read at session start and at every compaction (the kept window only changes at one). */
  keptWindowThinking?: KeptWindowThinking;
  /** The last kept-window cutoff logged, so the log gets one record per cutoff. */
  announcedCutoff?: number;
  piVersionNotice?: string;
}

const logPath = () => resolveLogPath(process.env.PI_COMPACT_STATE_DEBUG, defaultLogPath());
const standsDown = () => stateStandsDown(selectCompactor(process.env));

/** A notice that can never affect the session it is shown in. */
function notifySafely(ctx: Notify, text: string, level: "info" | "warning"): void {
  try {
    ctx.ui.notify?.(text, level);
  } catch {
    // a failed notice must never affect the session
  }
}

function warnOnce(rt: Runtime, ctx: Notify, key: string, text: string | undefined): void {
  if (!text || rt.warned.has(key)) return;
  rt.warned.add(key);
  notifySafely(ctx, text, "warning");
}

// Keyed by the text, so an entry added mid-session is named at the next compaction, and each wording once.
function warnUnusableRoots(rt: Runtime, ctx: Notify, config: StateConfig): void {
  const notice = localOnlyRootsNotice(config.localOnlyRoots, homeDirectory());
  warnOnce(rt, ctx, `local-only-roots:${notice}`, notice);
}

/** `piVersion` is for tests: pi passes only `pi`, and the running pi is the one Longhaul is checked against. */
export default function compactionStateExtension(pi: ExtensionAPI, options: { piVersion?: string } = {}) {
  const piVersion = options.piVersion ?? PI_VERSION;
  // The marker a compactor that defers to Longhaul reads (select.ts): set at LOAD, which is earlier
  // than session_start and strictly safer -- no compaction can precede the load, and a
  // factory re-invoked per session sets it again harmlessly. The value is this process's pid, so a
  // child pi that inherits the variable without loading this extension does not count it.
  process.env[STATE_LOADED_ENV] = stateLoadedMarker();
  const piCompat = readPiCompat();
  const piStatus = piVersionStatus(piVersion, piCompat);
  const loadDefaultLog = defaultLogPath();
  const loadLogPath = resolveLogPath(process.env.PI_COMPACT_STATE_DEBUG, loadDefaultLog);
  // The default directory is the extension's own, so it is tightened; a path the user chose keeps its mode.
  if (loadLogPath === loadDefaultLog) privateLogDir(path.dirname(loadDefaultLog));
  if (loadLogPath) appendJsonl(loadLogPath, { event: "extension-loaded", piVersion, piVersionVerified: piStatus === "exact" ? true : piStatus === "line" ? "line" : false });
  registerReportCommand(pi, piStatus);
  pi.registerEntryRenderer(LINE_ENTRY_TYPE, renderCompactionLine);

  const rt: Runtime = { pi, warned: new Set(), routeHealth: createRouteHealth(), piVersionNotice: unverifiedPiVersionNotice(piVersion, piCompat) ?? undefined };
  pi.on("session_start", async (_event, ctx) => onSessionStart(rt, ctx));
  pi.on("context", async (event, ctx) => keptWindowContext(rt, event, ctx));
  pi.on("model_select", async (event, ctx) => {
    if (!standsDown()) warnOnce(rt, ctx, "small-window", smallWindowNotice(event.model));
  });

  // Registered in every session (not only a state-selected one): a stood-down session can still
  // remember, and its writes ride the branch until the next state pass folds them in.
  registerRememberTool(pi);
  registerRecallTool(pi);

  pi.on("session_before_compact", async (event, ctx) => beforeCompact(rt, event, ctx));
  pi.on("session_compact", async (event, ctx) => afterCompact(rt, event, ctx));
  pi.on("session_compact_failed", async (event, ctx) => compactFailed(rt, event, ctx));
}

function onSessionStart(rt: Runtime, ctx: ExtensionContext): void {
  rt.warned.clear();
  rt.announcedCutoff = undefined;
  process.env[STATE_LOADED_ENV] = stateLoadedMarker();
  // The notice is about compactions Longhaul makes, so a session that opted out of them is not told.
  if (standsDown()) return;
  if (rt.piVersionNotice) ctx.ui.notify?.(rt.piVersionNotice, "warning");
  const config = resolveStateConfig(readConfigFile);
  rt.keptWindowThinking = config.keptWindowThinking;
  const warmNotice = warmModeNotice(config);
  if (warmNotice) ctx.ui.notify?.(warmNotice, "warning");
  warnUnusableRoots(rt, ctx, config);
  warnOnce(rt, ctx, "small-window", smallWindowNotice(ctx.model));
}

// Kept-window strip (kept-window.ts): the same messages lose their thinking on every request until the next
// compaction, so the prefix stays stable. Never throws; undefined leaves pi's own array.
function keptWindowContext(rt: Runtime, event: ContextEvent, ctx: ExtensionContext) {
  if (standsDown()) return undefined;
  const outcome = stripKeptWindowContext(event, tryRead(() => ctx.model, undefined), rt.keptWindowThinking);
  if (!outcome) return undefined;
  const log = logPath();
  if (outcome.cutoff !== rt.announcedCutoff) {
    rt.announcedCutoff = outcome.cutoff;
    if (log) appendJsonl(log, { ...sessionFields(ctx), event: "kept-window-strip", cutoff: outcome.cutoff, strippedBlocks: outcome.strippedBlocks, strippedChars: outcome.strippedChars, contextMessages: event.messages.length });
  }
  return outcome.result;
}

async function beforeCompact(rt: Runtime, event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
  rt.inFlight = undefined;
  const selection = selectCompactor(process.env);
  if (stateStandsDown(selection)) return undefined;
  const flight: InFlight = { started: performance.now() };
  rt.inFlight = flight;
  // One read per compaction: the headers below and the pass see the same file even if it is edited meanwhile.
  const configText = readConfigFile();
  const config = resolveStateConfig(() => configText);
  rt.keptWindowThinking = config.keptWindowThinking;
  warnUnusableRoots(rt, ctx, config);
  const fields = sessionFields(ctx);
  const log = logPath();
  try {
    const result = await runStatePass(
      { preparation: event.preparation, branchEntries: event.branchEntries, customInstructions: event.customInstructions, reason: event.reason, signal: event.signal, sessionModel: ctx.model, cwd: ctx.cwd, env: process.env },
      { readConfig: () => configText, exec: (c, a, o) => rt.pi.exec(c, a, o), call: registryCall(ctx.modelRegistry, (o, m) => withSummarizerHeaders(o, config.summarizerHeaders, { provider: m.provider, sessionId: fields.sessionId })), find: (provider, id) => ctx.modelRegistry.find(provider, id), routeHealth: rt.routeHealth, now: () => new Date(), runningTasks: () => requestRunningTasks(rt.pi.events, { requestId: `compaction-state-${randomUUID()}` }) },
    );
    rt.routeHealth = result.routeHealth;
    flight.pending = result.pending;
    flight.notice = result.notice;
    if (log) appendJsonl(log, { ...fields, ...result.log });
    return { compaction: result.compaction };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logged = logSafeError(error, logOptionsOf(process.env));
    if (event.signal.aborted) {
      rt.inFlight = undefined;
      if (log) appendJsonl(log, { ...fields, event: "aborted", reason: event.reason, ...logged });
      return undefined;
    }
    flight.fallback = { errorClass: logged.errorClass, error: logged.error };
    if (log) appendJsonl(log, { ...fields, event: "fallback", reason: event.reason, ...logged });
    notifySafely(ctx, `longhaul: the compaction failed (${message}); pi's own compaction was used instead`, "warning");
    return undefined;
  }
}

async function afterCompact(rt: Runtime, event: SessionCompactEvent, ctx: ExtensionContext) {
  const fields = sessionFields(ctx);
  const log = logPath();
  const flight = rt.inFlight;
  rt.inFlight = undefined;
  const record = flight?.pending;
  if (event.fromExtension && record) {
    try {
      rt.pi.appendEntry(SPAN_ENTRY_TYPE, buildSpanRecord({ span: record.span, compactionEntryId: event.compactionEntry.id, events: record.events, ledger: record.ledger, snapshot: record.snapshot, usage: record.usage, caps: record.caps }));
    } catch (error) {
      if (log) appendJsonl(log, { ...fields, event: "span-record-failed", span: record.span, ...logSafeError(error, logOptionsOf(process.env)) });
    }
  }
  if (flight) appendCompactionLine(rt.pi, event, flight, fields, log);
  if (log) appendJsonl(log, { ...fields, event: "compacted", fromExtension: event.fromExtension, reason: event.reason, span: record?.span, summaryChars: event.compactionEntry.summary.length, tokensBefore: event.compactionEntry.tokensBefore });
  if (!flight?.fallback && !standsDown()) warnOnce(rt, ctx, "foreign-compaction", foreignCompactionNotice(event.compactionEntry.details, event.fromExtension));
  if (flight?.notice && event.fromExtension) notifySafely(ctx, flight.notice, "info");
}

// The Compaction line (compaction-line.ts) for this compaction, if it was Longhaul's or its fallback. Never throws.
function appendCompactionLine(pi: ExtensionAPI, event: SessionCompactEvent, flight: InFlight, fields: SessionFields, log: string | undefined): void {
  const record = flight.pending;
  const line = compactionLineFor({ durationMs: performance.now() - flight.started, tokensBefore: event.compactionEntry.tokensBefore, summaryChars: event.compactionEntry.summary.length,
    fromExtension: event.fromExtension, pass: record ? { span: record.span, usage: record.usage } : undefined, fallback: flight.fallback });
  if (!line) return;
  // pi emits compaction_end right after session_compact returns, and the TUI then clears the chat and draws its
  // compaction block last: appended now, the line would sit above that block. One turn later it lands under it.
  setImmediate(() => {
    try {
      pi.appendEntry(LINE_ENTRY_TYPE, line);
    } catch (error) {
      if (log) appendJsonl(log, { ...fields, event: "compaction-line-failed", ...logSafeError(error, logOptionsOf(process.env)) });
    }
  });
}

async function compactFailed(rt: Runtime, event: SessionCompactFailedEvent, ctx: ExtensionContext) {
  const log = logPath();
  if (log) appendJsonl(log, { ...sessionFields(ctx), event: "compact-failed", reason: event.reason, span: rt.inFlight?.pending?.span });
  rt.inFlight = undefined;
}
