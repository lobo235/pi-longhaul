/** Session identity for log records; every read is guarded because pi's internals are not a stable API. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SessionFields { sessionId?: string; cwd?: string; sessionModel?: string; thinkingLevel?: string }

export function tryRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function sessionFields(ctx: ExtensionContext): SessionFields {
  const model = tryRead(() => ctx.model, undefined);
  return {
    sessionId: tryRead(() => ctx.sessionManager.getSessionId(), undefined),
    cwd: tryRead(() => ctx.cwd, undefined),
    sessionModel: model ? `${model.provider}/${model.id}` : undefined,
    thinkingLevel: tryRead(() => ctx.thinkingLevel, undefined),
  };
}
