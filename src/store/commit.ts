/** The remember hand: verify one proposal against the live projection, append it, report the cap. */
import { EVENT_ENTRY_TYPE, STATE_FORMAT, type Caps, type PersistedEvent, type Rejection, type StateEvent, type StateLog } from "./events.ts";
import { acceptedRemembers, project } from "./project.ts";
import { verify, type Proposal, type QuoteResolver } from "./verify.ts";

export interface CommitRememberDeps {
  log: StateLog;
  resolver: QuoteResolver;
  caps: Caps;
  nearDuplicateThreshold: number;
  rememberCap: number;
  now: () => string;
  /** pi.appendEntry, narrowed. */
  appendEntry: (customType: string, data: PersistedEvent) => void;
}

export type CommitOutcome = { ok: true; event: StateEvent; remaining: number } | { ok: false; rejection: Rejection; remaining: number };

export function commitRemember(proposal: Proposal, deps: CommitRememberDeps): CommitOutcome {
  const acceptedThisSpan = acceptedRemembers(deps.log, deps.log.openSpan).length;
  const remaining = Math.max(0, deps.rememberCap - acceptedThisSpan);
  try {
    const verdict = verify(proposal, {
      resolver: deps.resolver,
      state: project(deps.log, deps.caps),
      provenance: { source: "remember", span: deps.log.openSpan, at: deps.now() },
      caps: deps.caps,
      nearDuplicateThreshold: deps.nearDuplicateThreshold,
      acceptedThisSpan,
      rememberCap: deps.rememberCap,
    });
    if (!verdict.ok) return { ok: false, rejection: verdict.rejection, remaining };
    deps.appendEntry(EVENT_ENTRY_TYPE, { ...verdict.event, stateFormat: STATE_FORMAT });
    return { ok: true, event: verdict.event, remaining: remaining - 1 };
  } catch (error) {
    return { ok: false, rejection: { code: "internal", detail: error instanceof Error ? error.message : String(error) }, remaining };
  }
}
