import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CAPS } from "./events.ts";
import { activeDecisions, activeWorkLog, project } from "./project.ts";
import { closeEvent, ev, logOf, NOW, resetSeq } from "./test-support.ts";

test.beforeEach(() => resetSeq());

const HEX64 = "9f2c4e81b7a3d6f05e19c8a2b4d7e3f6a1c9b8e2d5f4a7c3b6e9d2f1a8c5b4e7";
const UUID = "3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58";

test("a span record written with a credential in it projects with the value redacted (security.md T3)", () => {
  const state = project(logOf(
    ev({ kind: "now.set", now: { ...NOW, inProgress: [`probing with password ${HEX64}`], resume: `retry AUTH (password ${HEX64}) on sentinel-0` } }),
    ev({ kind: "decision.add", id: "D1", text: `call the API with Bearer ${UUID}` }),
    ev({ kind: "deadEnd.add", id: "X1", text: "the token hvs.CAESIabcdefgh1234567 was read-only" }),
    closeEvent(1, { narrative: `Seeded the gateway_key (${UUID}) into the secret.` }),
  ), DEFAULT_CAPS);
  assert.deepEqual(state.now?.inProgress, ["probing with password <redacted>"]);
  assert.equal(state.now?.resume, "retry AUTH (password <redacted>) on sentinel-0");
  assert.equal(activeDecisions(state)[0].text, "call the API with Bearer <redacted>");
  assert.equal(state.deadEnds[0].text, "the token <redacted> was read-only");
  assert.match(activeWorkLog(state)[0].text, /gateway_key \(<redacted>\)/);
});
