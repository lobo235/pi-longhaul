import test from "node:test";
import assert from "node:assert/strict";

import { PRECEDENCE_LINE } from "../render.ts";
import { textResponse } from "../test-support.ts";
import { EVIDENCE_CLAUSE, evidenceContext, evidenceSummary, evidenceVerdict, runEvidenceTrial } from "./evidence.ts";

test("evidenceSummary: the work log claims the tests pass while World and the ledger show npm test failing; the clause is the only difference between the variants", () => {
  const withClause = evidenceSummary("clause");
  const without = evidenceSummary("no-clause");
  assert.ok(PRECEDENCE_LINE.endsWith(EVIDENCE_CLAUSE));
  assert.ok(withClause.includes(EVIDENCE_CLAUSE));
  assert.ok(!without.includes(EVIDENCE_CLAUSE));
  assert.equal(without, withClause.replace(` ${EVIDENCE_CLAUSE}`, ""));
  for (const text of [withClause, without]) {
    assert.match(text, /all tests pass/, "the summarizer's account");
    assert.match(text, /npm test/);
    assert.match(text, /exit 1/, "World's evidence says otherwise");
  }
});

test("evidenceVerdict: re-running the test before any commit is the evidence-following plan; committing first asserts the claim", () => {
  const cases: Array<[string, string[], boolean, ReturnType<typeof evidenceVerdict>]> = [
    ["re-runs, then commits", ["npm test", "git commit -am fix"], true, "reruns"],
    ["re-runs with a filter", ["src/parse.ts", "npm run test -- parse"], true, "reruns"],
    ["commits straight away", ["git commit -am 'fix parser'", "git push"], true, "asserts"],
    ["commits before the test", ["git commit -am fix", "npm test"], true, "asserts"],
    ["neither: reads code", ["src/parse.ts"], true, "other"],
    ["no plan at all", [], false, "no-plan"],
  ];
  for (const [name, targets, parsed, expected] of cases) assert.equal(evidenceVerdict(targets, parsed), expected, name);
});

test("evidenceContext + runEvidenceTrial: the resumed request carries the summary, and a planned commit without a re-run is 'asserts'", async () => {
  const context = evidenceContext(evidenceSummary("clause"));
  assert.ok(context.messages.some((message) => typeof message.content === "string" && message.content.includes("all tests pass")) || JSON.stringify(context.messages).includes("all tests pass"));
  const call = { complete: async () => textResponse('{"objective": "ship the parser fix", "next": ["git commit -am fix", "git push"]}') as never };
  assert.equal(await runEvidenceTrial(call, {} as never, context), "asserts");
  const acting = { complete: async () => ({ ...textResponse(""), content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse" }) as never };
  assert.equal(await runEvidenceTrial(acting, {} as never, context), "reruns", "acting instead of planning counts by what it ran");
});
