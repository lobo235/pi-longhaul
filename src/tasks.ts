/**
 * The background tasks still running at compaction, for one code-written World line.
 * pi-background-tasks (2.6.x) answers a `status` request on pi's event bus with every task its
 * service holds; this asks once, keeps the running ones and gives up after a bound, so a missing or
 * slow service costs the pass at most that bound and renders no line at all: an unknown is never
 * shown as "nothing running". Nothing here is persisted; the line is a fact about the moment of the
 * compaction, like the rest of World.
 */
import { ageLabel } from "./world-render.ts";
import { isRec } from "./message-text.ts";

export const REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";

export const TASKS_SHOWN = 10;
export const TASKS_TIMEOUT_MS = 2000;
const NAME_CHARS = 60;
/** The whole line's own bound: it renders after World's fitted lines, so World's cap does not cover it (security.md T4). */
export const TASK_LINE_CHARS = 800;
/** Ids are pi-background-tasks' own tokens; anything else is not its answer and is dropped, never quoted (security.md T2). */
const TASK_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** The widest epoch-ms a Date can hold (security.md T1). */
const MAX_DATE_MS = 8.64e15;

/** The slice of pi's EventBus this needs. */
export interface TaskBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface RunningTask {
  id: string;
  name: string;
  isAgent: boolean;
  /** Epoch ms. */
  startTime: number;
}


function runningOf(value: unknown): RunningTask | undefined {
  if (!isRec(value) || value.status !== "running" || typeof value.id !== "string" || !TASK_ID_RE.test(value.id)) return undefined;
  if (typeof value.startTime !== "number" || !(Math.abs(value.startTime) <= MAX_DATE_MS)) return undefined;
  const name = typeof value.name === "string" && value.name.trim() ? value.name : typeof value.command === "string" ? value.command : value.id;
  return { id: value.id, name, isAgent: value.isAgent === true, startTime: value.startTime };
}

/** The running tasks from a status answer, newest first, at most TASKS_SHOWN; undefined if malformed. */
function runningTasksOf(result: unknown): RunningTask[] | undefined {
  if (!isRec(result) || !Array.isArray(result.tasks)) return undefined;
  const running = result.tasks.map(runningOf).filter((entry): entry is RunningTask => entry !== undefined);
  return running.sort((a, b) => b.startTime - a.startTime).slice(0, TASKS_SHOWN);
}

/** Ask the background-task service once; undefined when it does not answer usefully within the bound. */
export function requestRunningTasks(bus: TaskBus, options: { timeoutMs?: number; requestId: string }): Promise<RunningTask[] | undefined> {
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => finish(undefined), options.timeoutMs ?? TASKS_TIMEOUT_MS);
    const finish = (value: RunningTask[] | undefined) => {
      clearTimeout(timer);
      off();
      resolve(value);
    };
    off = bus.on(RESPONSE_CHANNEL, (frame) => {
      if (!isRec(frame) || frame.request_id !== options.requestId) return;
      finish(frame.ok === true ? runningTasksOf(frame.result) : undefined);
    });
    try {
      bus.emit(REQUEST_CHANNEL, { schema_version: REQUEST_SCHEMA, request_id: options.requestId, operation: "status", payload: {} });
    } catch {
      finish(undefined);
    }
  });
}

/** Controls and Unicode format characters (bidi overrides, zero-width) become spaces: a name is data, never layout. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();

function taskText(task: RunningTask, asOf: string | undefined): string {
  const name = oneLine(task.name).slice(0, NAME_CHARS).replace(/"/g, "'");
  const age = ageLabel(new Date(task.startTime).toISOString(), asOf);
  return `${task.id} "${name}" (${task.isAgent ? "agent" : "command"}${age ? `, started ${age} before compaction` : ""})`;
}

const LINE_HEAD = "Background tasks running (live at compaction): ";
const LINE_TAIL = ". Do not relaunch these; check them with bg_status.";
const moreText = (count: number) => `; and ${count} more (bg_status lists them)`;

/** The World line for the running tasks, or undefined when none run (or none are known); at most TASK_LINE_CHARS. */
export function renderTaskLine(tasks: RunningTask[], asOf: string | undefined): string | undefined {
  if (tasks.length === 0) return undefined;
  const texts = tasks.map((task) => taskText(task, asOf));
  let shown = texts.length;
  const lineOf = (count: number) => `${LINE_HEAD}${texts.slice(0, count).join("; ")}${count < texts.length ? moreText(texts.length - count) : ""}${LINE_TAIL}`;
  while (shown > 1 && lineOf(shown).length > TASK_LINE_CHARS) shown -= 1;
  return lineOf(shown);
}
