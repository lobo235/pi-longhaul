/**
 * The condensed transcript a section turn reads: the assistant's own words, one line per tool call,
 * each tool result cut to head and tail, images as `[image: read <path>]` placeholders. The user's
 * words are NOT here -- the Digest carries them whole -- so a user message is a position marker only.
 * Every cut output stays answerable by `show(T<n>)` (the `outputs` map), which is what replaces
 * chunking. Over the budget the oldest tool output goes first, then the oldest assistant text; a user
 * marker is never dropped.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CondensedTranscript {
  text: string;
  /** T<n> -> the whole tool output (text blocks only), for show(). */
  outputs: Map<string, string>;
}

const RESULT_CAP = { head: 400, tail: 200 };
const TEXT_CAP = { head: 1500, tail: 500 };
const CALL_CHARS = 200;

type Rec = Record<string, unknown>;
interface Item { kind: "user" | "assistant" | "call" | "result"; line: string; toolId?: string; droppable: boolean }

/**
 * Each whitespace run that holds a line end becomes one ` ⏎ `. Matched as whole runs: the pattern this replaces
 * (optional blanks, a line end, optional blanks) rescanned a long blank run from each of its characters (security.md T4).
 */
const oneLine = (text: string) => text.replace(/\s+/g, (run) => (run.includes("\n") ? " ⏎ " : run)).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();

function cut(text: string, cap: { head: number; tail: number }, toolId?: string): string {
  if (text.length <= cap.head + cap.tail) return text;
  const hint = toolId ? `, show ${toolId}` : "";
  return `${text.slice(0, cap.head)} … ${text.length - cap.head - cap.tail} chars${hint} … ${text.slice(-cap.tail)}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: Rec) => block.type === "text").map((block: Rec) => String(block.text ?? "")).join("\n");
}

/** The ledger's id for a bash command (C<n>), when it has one: the citable id, where T<n> is only the digest's. */
export type CommandIdOf = (command: string) => string | undefined;

function callLine(id: string, name: string, args: Rec, commandIdOf?: CommandIdOf): string {
  if (name === "bash" && typeof args.command === "string") {
    const commandId = commandIdOf?.(args.command);
    return `${id} → bash${commandId ? ` [${commandId}]` : ""}: ${oneLine(args.command).slice(0, CALL_CHARS)}`;
  }
  if (typeof args.path === "string" && Object.keys(args).length <= 3) return `${id} → ${name} ${oneLine(args.path).slice(0, CALL_CHARS)}`;
  return `${id} → ${name} ${oneLine(JSON.stringify(args)).slice(0, CALL_CHARS)}`;
}

function resultBody(message: Rec, call: { name: string; path?: string } | undefined): string {
  const content = Array.isArray(message.content) ? (message.content as Rec[]) : [];
  const images = content.filter((block) => block.type === "image").map(() => `[image: ${call?.name ?? "tool"} ${call?.path ?? "(unknown file)"}]`);
  return [textOf(message.content), ...images].filter(Boolean).join(" ");
}

/** One message as items; calls are numbered T1, T2, ... in order, and remembered so their result can name the file. */
function itemsOf(message: Rec, state: { next: number; calls: Map<string, { id: string; name: string; path?: string }>; outputs: Map<string, string>; commandIdOf?: CommandIdOf }): Item[] {
  const newId = () => `T${state.next++}`;
  const resultItem = (toolId: string, body: string, isError: boolean): Item => {
    state.outputs.set(toolId, body);
    return { kind: "result", toolId, droppable: true, line: `  ← ${isError ? "error" : "ok"}: ${oneLine(cut(body, RESULT_CAP, toolId))}` };
  };
  if (message.role === "user") {
    const ordinal = /^\[(u\d+)\]/.exec(textOf(message.content))?.[1];
    return [{ kind: "user", droppable: false, line: `[${ordinal ?? "user"}] (user message: words in <user-messages>)` }];
  }
  if (message.role === "assistant") {
    const content = Array.isArray(message.content) ? (message.content as Rec[]) : [];
    const said = textOf(content).trim();
    const out: Item[] = said ? [{ kind: "assistant", droppable: true, line: `assistant: ${oneLine(cut(said, TEXT_CAP))}` }] : [];
    for (const block of content.filter((entry) => entry.type === "toolCall")) {
      const id = newId();
      const args = (block.arguments ?? {}) as Rec;
      state.calls.set(String(block.id), { id, name: String(block.name), path: typeof args.path === "string" ? args.path : undefined });
      out.push({ kind: "call", droppable: false, line: callLine(id, String(block.name), args, state.commandIdOf) });
    }
    return out;
  }
  if (message.role === "toolResult") {
    const call = state.calls.get(String(message.toolCallId));
    return [resultItem(call?.id ?? newId(), resultBody(message, call), message.isError === true)];
  }
  if (message.role === "bashExecution" && typeof message.command === "string") {
    const id = newId();
    return [{ kind: "call", droppable: false, line: `${id} → user ran: ${oneLine(message.command).slice(0, CALL_CHARS)}` }, resultItem(id, String(message.output ?? ""), typeof message.exitCode === "number" && message.exitCode !== 0)];
  }
  return [];
}

const total = (items: Item[]) => items.reduce((sum, item) => sum + item.line.length + 1, 0);

/** Drop oldest-first, tool outputs before assistant text, until the lines fit. */
function fit(items: Item[], budgetChars: number): Item[] {
  const out = [...items];
  let size = total(out);
  for (const kind of ["result", "assistant"] as const) {
    for (let i = 0; i < out.length && size > budgetChars; i++) {
      const item = out[i];
      if (item.kind !== kind || !item.droppable) continue;
      const line = kind === "result" ? `${item.line.slice(0, item.line.indexOf(":") + 1)} (output dropped: show ${item.toolId})` : "assistant: (text dropped)";
      size -= item.line.length - line.length;
      out[i] = { ...item, line, droppable: false };
    }
  }
  return out;
}

export function condenseTranscript(messages: AgentMessage[], budgetChars: number, commandIdOf?: CommandIdOf): CondensedTranscript {
  const state = { next: 1, calls: new Map<string, { id: string; name: string; path?: string }>(), outputs: new Map<string, string>(), commandIdOf };
  const items = messages.flatMap((message) => itemsOf(message as unknown as Rec, state));
  return { text: fit(items, budgetChars).map((item) => item.line).join("\n"), outputs: state.outputs };
}
