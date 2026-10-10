/**
 * Drives pi over RPC for eval/record.ts: one prompt per scripted turn, each waited out to agent_settled.
 *
 * A turn that goes quiet (no event for `idleMs`: a tool call that never returns, such as a server the model started
 * in the foreground) is aborted the way a user would press Esc, and the next turn runs; the transcript keeps the
 * aborted turn as it happened. A turn that is still busy at `turnMs` fails the recording: that is a session that
 * cannot finish, not one that stalled once.
 */
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface DriveLimits {
  /** No event for this long aborts the turn. */
  idleMs: number;
  /** A turn still running after this long fails the recording. */
  turnMs: number;
}

export const DEFAULT_LIMITS: DriveLimits = { idleMs: 10 * 60_000, turnMs: 90 * 60_000 };

type Event = { type?: string; id?: string; success?: boolean; error?: string };

export async function drive(child: { stdin: Writable; stdout: Readable }, turns: string[], log: (line: string) => void, limits: DriveLimits = DEFAULT_LIMITS): Promise<void> {
  const events = readline.createInterface({ input: child.stdout });
  let waiter: ((event: Event) => void) | undefined;
  let compactions = 0;
  let aborted = 0;
  events.on("line", (line) => {
    let event: Event;
    try { event = JSON.parse(line) as Event; } catch { return; }
    if (event.type === "compaction_end") log(`compaction ${++compactions}`);
    waiter?.(event);
  });
  const send = (command: object) => child.stdin.write(JSON.stringify(command) + "\n");
  for (const [index, message] of turns.entries()) {
    log(`turn ${index + 1}/${turns.length}`);
    await new Promise<void>((resolve, reject) => {
      let abortSent = false;
      const finish = (error?: Error) => { clearTimeout(overall); clearTimeout(idle); waiter = undefined; if (error) reject(error); else resolve(); };
      const overall = setTimeout(() => finish(new Error(`turn ${index + 1} did not settle in ${limits.turnMs / 60_000} min`)), limits.turnMs);
      let idle: NodeJS.Timeout;
      const onIdle = () => {
        if (abortSent) return finish(new Error(`turn ${index + 1} did not settle after an abort`));
        abortSent = true;
        aborted++;
        log(`turn ${index + 1}/${turns.length}: aborted after ${Math.round(limits.idleMs / 60_000)} min with no event`);
        send({ id: `a${index}`, type: "abort" });
        idle = setTimeout(onIdle, limits.idleMs);
      };
      idle = setTimeout(onIdle, limits.idleMs);
      waiter = (event) => {
        clearTimeout(idle);
        idle = setTimeout(onIdle, limits.idleMs);
        if (event.type === "response" && event.id === `t${index}` && event.success === false) finish(new Error(`turn ${index + 1} rejected: ${event.error}`));
        if (event.type === "agent_settled") finish();
      };
      send({ id: `t${index}`, type: "prompt", message });
    });
  }
  events.close();
  log(`done: ${turns.length} turns, ${compactions} compactions, ${aborted} aborted`);
}
