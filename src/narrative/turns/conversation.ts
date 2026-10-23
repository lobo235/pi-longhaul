/**
 * One turn of the continuing compaction conversation: the user text goes in, the model may call the
 * read-only `show` tool up to a cap, and the turn ends at the first answer without a tool call. Code
 * drives the conversation; the model never runs an agent loop. Every request is traced like the
 * single call's (CallTrace, `chunk` = the section's place in the order), the turn's deadline bounds
 * every request in it, and reasoning is asserted from usage: `reasoning: "off"` silently means on for
 * a model whose config has no thinking map, so the trace says so.
 */
import { Type } from "typebox";
import type { AssistantMessage, Context, Message, Model, ModelThinkingLevel, Tool, ToolCall } from "@earendil-works/pi-ai";

import { CREDENTIAL_RULE } from "../../credential-scrub.ts";
import type { ModelCall } from "../call.ts";
import { timedTransport } from "../timings.ts";
import { completeWithTransportRetry, type TransportRetryPolicy } from "../transport-retry.ts";
import type { CallTrace } from "../types.ts";
import { callUsageOf } from "../usage.ts";

/** Recorded as the span's promptRevision in turns mode, as NARRATIVE_PROMPT_REVISION is for the single call. */
export const TURNS_PROMPT_REVISION = "turns-11";

export const TURNS_SYSTEM_PROMPT = `You maintain the SESSION STATE of a coding session that is being compacted. The first message holds the digest of the span: the state so far, the user's messages, the commands and errors (with ids), the files, the workspace and a condensed transcript. Code asks for one section at a time. Answer each with ONE JSON object and nothing else. Use only ids that appear in the digest. Call show(ref) to read a user message (u<n>), command (C<n>), error (E<n>) or tool output (T<n>) in full when the digest cut it. ${CREDENTIAL_RULE}`;

export const SHOW_TOOL: Tool = {
  name: "show",
  description: "Read one item of the digest in full: a user message u<n>, a command C<n>, an error E<n>, or a tool output T<n>.",
  parameters: Type.Object({ ref: Type.String({ description: "u<n>, C<n>, E<n> or T<n>" }) }),
};

export interface TurnInput {
  model: Model<any>;
  /** The conversation so far; the turn returns it extended, never mutates it. */
  messages: Message[];
  text: string;
  show: (ref: string) => string | undefined;
  showCap: number;
  outputTokens: number;
  /** "off" unless the section's policy says low or the model cannot turn it off (reasoning.ts); usage.reasoning says what happened. */
  reasoning?: ModelThinkingLevel;
  /** Absolute deadline (deps.now clock) for every request of this turn. */
  deadline: number;
  chunk: number;
  attempt: number;
  transportRetry: TransportRetryPolicy;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now: () => number;
}

export interface TurnResult {
  /** The answer's text; "" when the turn ended without one. */
  text: string;
  messages: Message[];
  traces: CallTrace[];
  shows: number;
  /** Why the turn has no answer: the deadline passed, the transport failed after its retries, or show was called past the request budget. */
  failure?: "deadline" | "transport" | "show-loop";
  error?: string;
}

/** Only the pass's own signal aborts the pass; a request that died at the turn's deadline (a timeout reads as an abort) is a deadline. */
const failureOf = (input: TurnInput): "deadline" | "transport" => (input.now() >= input.deadline ? "deadline" : "transport");
const textOf = (message: AssistantMessage) => message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
const toolCalls = (message: AssistantMessage) => message.content.filter((block): block is ToolCall => block.type === "toolCall");

function toolResult(call: ToolCall, text: string, isError: boolean, timestamp: number): Message {
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp } as Message;
}

function answerShow(call: ToolCall, input: TurnInput, used: number): { text: string; isError: boolean } {
  if (call.name !== "show") return { text: `Unknown tool ${call.name}; the only tool is show(ref).`, isError: true };
  if (used >= input.showCap) return { text: `The show limit for this turn (${input.showCap}) is reached; answer the section now.`, isError: true };
  const ref = typeof call.arguments?.ref === "string" ? call.arguments.ref.trim() : "";
  const shown = input.show(ref);
  return shown === undefined ? { text: `${ref || "(empty)"} is not an id in the digest.`, isError: true } : { text: shown, isError: false };
}

export const ANSWER_NOW = "You have read enough. Do not call show again: answer the section now, as one JSON object.";

/** Not a transport pattern (transport-retry.ts), so a spent turn is never retried past its deadline. */
export const TURN_BUDGET_SPENT = "turn budget spent";

const blockText = (message: Message): string => (typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));

/** The conversation with every show call and result as plain text: a request without tools must carry no tool history. */
function withoutToolForm(messages: Message[]): Message[] {
  return messages.map((message): Message => {
    if (message.role === "toolResult") return { role: "user", content: `show result:\n${blockText(message)}`, timestamp: message.timestamp };
    if (message.role !== "assistant" || !message.content.some((block) => block.type === "toolCall")) return message;
    const calls = toolCalls(message).map((block) => `${block.name}(${typeof block.arguments?.ref === "string" ? block.arguments.ref : ""})`);
    return { ...message, content: [...message.content.filter((block) => block.type === "text"), { type: "text", text: calls.join("\n") }], stopReason: "stop" };
  });
}

/**
 * `answerOnly` sends no tools, with the show exchanges as text: past ANSWER_NOW a model was seen to keep calling show
 * (3 of 30 sections), and tool_choice "none" is no lever — some OpenAI-compatible servers drop a call the model
 * insists on under it and return no answer at all.
 */
async function request(input: TurnInput, call: ModelCall, messages: Message[], answerOnly: boolean): Promise<{ response: AssistantMessage; trace: CallTrace }> {
  const started = input.now();
  const transport = timedTransport(input.model);
  const options = { maxTokens: input.outputTokens, reasoning: input.reasoning ?? "off", signal: input.signal, cacheRetention: "none", ...(transport ? { fetch: transport.fetch } : {}) };
  const context: Context = answerOnly ? { systemPrompt: TURNS_SYSTEM_PROMPT, messages: withoutToolForm(messages) } : { systemPrompt: TURNS_SYSTEM_PROMPT, messages, tools: [SHOW_TOOL] };
  const produce = () => {
    const left = input.deadline - input.now();
    if (left <= 0) return Promise.reject(new Error(TURN_BUDGET_SPENT));
    return call.complete(input.model, context, { ...options, timeoutMs: left });
  };
  const { response, retries, errors } = await completeWithTransportRetry(produce, { policy: input.transportRetry, signal: input.signal, sleep: input.sleep });
  const usage = callUsageOf(response.usage);
  const trace: CallTrace = { chunk: input.chunk, attempt: input.attempt, verdict: "diff", fieldErrors: [], dropped: 0, rescued: 0, stopReason: response.stopReason, usage, transport: transport?.timings, retries, errors: [...errors, ...(response.errorMessage ? [response.errorMessage] : [])], durationMs: input.now() - started, ...(input.reasoning && input.reasoning !== "off" ? { reasoning: input.reasoning } : {}) };
  return { response, trace };
}

/** Requests until an answer without a tool call; at most showCap + 2 requests, so a model that keeps calling show still ends. */
export async function runTurn(input: TurnInput, call: ModelCall): Promise<TurnResult> {
  let messages: Message[] = [...input.messages, { role: "user", content: input.text, timestamp: input.now() }];
  const traces: CallTrace[] = [];
  let shows = 0;
  let capped = false;
  const requests = input.showCap + 2;
  for (let i = 0; i < requests; i++) {
    if (input.now() >= input.deadline) return { text: "", messages, traces, shows, failure: "deadline" };
    let result: { response: AssistantMessage; trace: CallTrace };
    try {
      result = await request(input, call, messages, capped || i === requests - 1);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { text: "", messages, traces, shows, failure: failureOf(input), error: String((error as Error).message ?? error) };
    }
    traces.push(result.trace);
    const { response } = result;
    if (response.stopReason === "aborted" && input.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (response.stopReason === "error" || response.stopReason === "aborted") return { text: "", messages, traces, shows, failure: failureOf(input), error: response.errorMessage ?? response.stopReason };
    messages = [...messages, response];
    const calls = toolCalls(response);
    if (calls.length === 0) return { text: textOf(response), messages, traces, shows };
    for (const toolCall of calls) {
      const shown = answerShow(toolCall, input, shows);
      if (!shown.isError) shows++;
      capped ||= shows >= input.showCap;
      messages = [...messages, toolResult(toolCall, shown.text, shown.isError, input.now())];
    }
    // A tool result saying "limit reached" was not enough in a smoke run: the model kept calling. Code says it as the user.
    if (capped || i === requests - 2) messages = [...messages, { role: "user", content: ANSWER_NOW, timestamp: input.now() }];
  }
  return { text: "", messages, traces, shows, failure: "show-loop", error: "the turn kept calling show past its request budget" };
}
