import test from "node:test";
import assert from "node:assert/strict";

import { buildMessageIndex } from "../intent.ts";
import { DEFAULT_CAPS } from "../store/events.ts";
import { emptyState } from "../store/project.ts";
import type { VerifyContext } from "../store/verify.ts";
import { chain, userEntry, assistantEntry } from "../test-support.ts";
import { FIXABLE_CODES, proposalsOf, retryNoteOf, validateNarrativeDiff } from "./validate.ts";

const entries = chain([
  userEntry("m1", "Build the state compactor and keep the ledger modules as they are"),
  assistantEntry("a1", "ok"),
  userEntry("m2", "never use mocks in these tests, fakes only"),
  assistantEntry("a2", "sure"),
  userEntry("m3", "The ledger modules no longer need to stay as they are; refactor them freely"),
  assistantEntry("a3", "noted"),
]);
const index = buildMessageIndex(entries, { commandIds: new Set(["C1"]), errorIds: new Set() });
const ctx = (): VerifyContext => ({ resolver: index, state: emptyState(), provenance: { source: "diff", span: 1, at: "2026-09-28T10:00:00.000Z" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 10 });
const now = { inProgress: ["x"], next: [], blocked: [], resume: "run tests" };

test("proposalsOf: one proposal per diff item in a fixed order, with a JSON-pointer path", () => {
  const paths = proposalsOf({ narrative: "n", objective: { messageRef: "u1", text: "Build the state compactor", doneWhen: { messageRef: "u1", text: "keep the ledger modules" } }, corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }], lifts: [], decisions: [{ text: "d", evidence: "C1" }], deadEnds: [{ text: "x" }], now }).map((entry) => entry.path);
  assert.deepEqual(paths, ["objective", "corrections[0]", "decisions[0]", "deadEnds[0]", "now"]);
});

test("validateNarrativeDiff: good items become events; bad items become field errors with fixability; later items still verify", () => {
  const result = validateNarrativeDiff({ narrative: "n", objective: { messageRef: "u1", text: "Build the state compactor" }, corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }, { messageRef: "u2", text: "in these tests, fakes only" }], lifts: [{ target: "R9", messageRef: "u2", text: "in these tests, fakes only" }], decisions: [{ text: "d", evidence: "C7" }], deadEnds: [], now }, ctx());
  assert.deepEqual(result.events.map((event) => event.kind), ["objective.set", "correction.add", "decision.add", "now.set"]);
  assert.deepEqual(result.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [
    ["corrections[0]", "not-substring", true],
    ["lifts[0]", "unknown-target", true],
  ]);
  assert.equal(result.state.corrections.length, 1);
});

test("validateNarrativeDiff: an evidence ref the ledger does not know is dropped, never the record it backs", () => {
  const result = validateNarrativeDiff({ narrative: "n", corrections: [], lifts: [], decisions: [{ text: "kept the ledger", evidence: "C7" }, { text: "used fakes", evidence: "C1" }], deadEnds: [{ text: "mocks broke the suite", evidence: "E4" }], now }, ctx());
  assert.deepEqual(result.errors, []);
  const records = result.events.filter((event) => event.kind === "decision.add" || event.kind === "deadEnd.add").map((event) => [event.kind, (event as { evidence?: string }).evidence]);
  assert.deepEqual(records, [["decision.add", undefined], ["decision.add", "C1"], ["deadEnd.add", undefined]]);
});

test("validateNarrativeDiff: a near-duplicate is a silent drop (an error that is not fixable and not noted)", () => {
  const first = validateNarrativeDiff({ narrative: "n", corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }], lifts: [], decisions: [], deadEnds: [], now }, ctx());
  const again = validateNarrativeDiff({ narrative: "n", corrections: [{ messageRef: "u2", text: "never use mocks in these tests, fakes" }], lifts: [], decisions: [], deadEnds: [], now }, { ...ctx(), state: first.state });
  assert.equal(again.errors[0].rejection.code, "near-duplicate");
  assert.equal(again.errors[0].fixable, false);
  assert.equal(retryNoteOf(again.errors, 1500), "");
});

test("retryNoteOf: one line per fixable error with the model-facing sentence, cut at maxChars", () => {
  const result = validateNarrativeDiff({ narrative: "n", corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }], lifts: [], decisions: [], deadEnds: [], now }, ctx());
  const note = retryNoteOf(result.errors, 1500);
  assert.match(note, /^corrections\[0\]: .*not a verbatim substring/i);
  assert.ok(retryNoteOf(result.errors, 40).length <= 40);
  assert.ok(FIXABLE_CODES.has("not-substring") && !FIXABLE_CODES.has("near-duplicate"));
});

const labelling = { required: ["u1", "u2"], textOf: (ordinal: string) => index.textOf(ordinal) };
const bare = { narrative: "n", corrections: [], lifts: [], decisions: [], deadEnds: [], now };

test("validateNarrativeDiff: a message labeled a rule becomes a correction in the user's own words; not a rule adds nothing", () => {
  const result = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u2: "rule" } }, ctx(), labelling);
  assert.deepEqual(result.errors, []);
  const added = result.events.filter((event) => event.kind === "correction.add");
  assert.deepEqual(added.map((event) => event.kind === "correction.add" && [event.quote.ordinal, event.quote.text]), [["u2", "never use mocks in these tests, fakes only"]]);
});

test("validateNarrativeDiff: a message left unlabeled, or labeled with something unreadable, is a fixable error naming it", () => {
  const result = validateNarrativeDiff({ ...bare, labels: { u2: "maybe" } }, ctx(), labelling);
  assert.deepEqual(result.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u2", "bad-label", true], ["labels", "unlabelled", true]]);
  assert.match(retryNoteOf(result.errors, 2000), /u1/);
  const none = validateNarrativeDiff(bare, ctx(), labelling);
  assert.deepEqual(none.errors.map((error) => error.rejection), [{ code: "unlabelled", refs: ["u1", "u2"] }], "a diff with no labels at all is asked for them");
  assert.deepEqual(validateNarrativeDiff(bare, ctx()).errors, [], "without labelling (an old caller) labels are not required");
});

test("validateNarrativeDiff: a rule that replaces another lifts it first, so the replacement is not taken for a near-duplicate", () => {
  const state = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "not a rule" } }, ctx(), labelling).state;
  const three = { required: ["u1", "u2", "u3"], textOf: (ordinal: string) => index.textOf(ordinal) };
  const result = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u2: "not a rule", u3: "rule and lifts R1" } }, { ...ctx(), state }, three);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.events.map((event) => event.kind).filter((kind) => kind.startsWith("correction")), ["correction.lift", "correction.add"]);
});

test("validateNarrativeDiff: a long message labeled a rule must come with the rule's exact words; labels for messages outside the span are ignored", () => {
  const long = "x".repeat(700);
  const result = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "not a rule", u9: "rule" } }, ctx(), { required: ["u1", "u2"], textOf: (ordinal) => (ordinal === "u1" ? long : index.textOf(ordinal)) });
  assert.deepEqual(result.errors.map((error) => [error.path, error.rejection.code]), [["labels.u1", "bad-label"]]);
  const words = validateNarrativeDiff({ ...bare, labels: { u1: { rule: "keep the ledger modules as they are" }, u2: "not a rule" } }, ctx(), labelling);
  assert.deepEqual(words.errors, []);
  assert.equal(words.events.filter((event) => event.kind === "correction.add").length, 1);
});

test("validateNarrativeDiff: a lift of an earlier message that is no rule in the state is reported withdrawn, not an error; one that is a rule lifts it", () => {
  const span = { required: ["u3"], known: ["u3"], textOf: (ordinal: string) => index.textOf(ordinal) };
  const seedLift = validateNarrativeDiff({ ...bare, labels: { u3: "lifts u1" } }, ctx(), span);
  assert.deepEqual([seedLift.errors, seedLift.withdrawn, seedLift.events.filter((event) => event.kind.startsWith("correction"))], [[], ["u1"], []]);
  const state = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "not a rule" } }, ctx(), labelling).state;
  const stateLift = validateNarrativeDiff({ ...bare, labels: { u3: "lifts u1" } }, { ...ctx(), state }, span);
  assert.equal(stateLift.withdrawn, undefined);
  assert.deepEqual(stateLift.events.map((event) => event.kind).filter((kind) => kind.startsWith("correction")), ["correction.lift"]);
});

test("validateNarrativeDiff: an earlier message offered for labeling (known, not required) may be labeled a rule", () => {
  const result = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "not a rule" } }, ctx(), { required: ["u2"], known: ["u1", "u2"], textOf: (ordinal) => index.textOf(ordinal) });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.events.flatMap((event) => (event.kind === "correction.add" ? [event.quote.ordinal] : [])), ["u1"]);
  assert.deepEqual(validateNarrativeDiff({ ...bare, labels: { u2: "not a rule" } }, ctx(), { required: ["u2"], known: ["u1", "u2"], textOf: (ordinal) => index.textOf(ordinal) }).errors, [], "it need not be labeled");
});

test("validateNarrativeDiff: named values that stand in their turn are returned; one that does not is a fixable error", () => {
  const facts = { ...labelling, spanTexts: () => ({ turnTextOf: (ordinal: string) => (ordinal === "u2" ? "[u2] never use mocks\nThe suite took 166 ms." : undefined), tainted: new Set<string>() }) };
  const result = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u2: "not a rule" }, values: [{ name: "suite time", value: "166 ms", ref: "u2" }, { name: "other", value: "170 ms", ref: "u2" }] }, ctx(), facts);
  assert.deepEqual(result.values, [{ name: "suite time", value: "166 ms", source: "u2" }]);
  assert.deepEqual(result.errors.map((error) => [error.path, error.rejection.code]), [["values[1]", "value-not-in-turn"]]);
});

test("validateNarrativeDiff: a rule that names a lift target the state lacks keeps the rule; a bare lift of one is a fixable error that says to label a new rule \"rule\"", () => {
  const combined = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u2: "rule and lifts R7" } }, ctx(), labelling);
  assert.deepEqual(combined.events.flatMap((event) => (event.kind === "correction.add" ? [event.quote.ordinal] : [])), ["u2"]);
  assert.deepEqual(combined.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u2", "bad-label", false]]);
  const bareLift = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u2: "lifts R7" } }, ctx(), labelling);
  assert.deepEqual(bareLift.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u2", "bad-label", true]]);
  assert.match(retryNoteOf(bareLift.errors, 2000), /R7 is not a rule in the state \(known: none\)[^\n]*"rule"/);
});

test("validateNarrativeDiff: a value cited to a turn outside the span is dropped without a retry: earlier spans' values are carried already", () => {
  const facts = { ...labelling, spanTexts: () => ({ turnTextOf: (ordinal: string) => (ordinal === "u2" ? "[u2] took 166 ms" : undefined), tainted: new Set<string>() }) };
  const result = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u2: "not a rule" }, values: [{ name: "old", value: "16 ms", ref: "u12" }] }, ctx(), facts);
  assert.deepEqual(result.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["values[0]", "unknown-ref", false]]);
});

test("validateNarrativeDiff: a lift whose message does not withdraw the rule it names is not applied: it gets a fixable error showing that rule", () => {
  const twoRules = chain([
    userEntry("m1", "Never delete anything outside the destination directory."),
    assistantEntry("a1", "ok"),
    userEntry("m2", "Every dry-run line must start with DRY: so it is easy to grep."),
    assistantEntry("a2", "ok"),
    userEntry("m3", "The DRY: prefix rule is lifted; plain dry-run output is fine from now on."),
    assistantEntry("a3", "ok"),
  ]);
  const twoIndex = buildMessageIndex(twoRules, { commandIds: new Set(), errorIds: new Set() });
  const twoCtx = (): VerifyContext => ({ ...ctx(), resolver: twoIndex });
  const facts = { required: ["u1", "u2", "u3"], textOf: (ordinal: string) => twoIndex.textOf(ordinal) };
  const state = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "rule", u3: "not a rule" } }, twoCtx(), facts).state;
  const later = { required: ["u3"], textOf: facts.textOf };
  const wrong = validateNarrativeDiff({ ...bare, labels: { u3: "lifts R1" } }, { ...twoCtx(), state }, later);
  assert.deepEqual(wrong.events.filter((event) => event.kind === "correction.lift"), []);
  assert.deepEqual(wrong.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u3", "lift-unnamed", true]]);
  assert.match(retryNoteOf(wrong.errors, 2000), /u3 does not say it withdraws R1 \("Never delete anything outside/);
  const right = validateNarrativeDiff({ ...bare, labels: { u3: "lifts R2" } }, { ...twoCtx(), state }, later);
  assert.deepEqual([right.errors, right.events.filter((event) => event.kind === "correction.lift").length], [[], 1]);
});

test("validateNarrativeDiff: a switchover withdrawal is checked like any lift: a message that does not withdraw that rule keeps it", () => {
  const span = { required: ["u2"], known: ["u2"], textOf: (ordinal: string) => index.textOf(ordinal) };
  const result = validateNarrativeDiff({ ...bare, labels: { u2: "lifts u1" } }, ctx(), span);
  assert.equal(result.withdrawn, undefined, "u2 says nothing of u1's rule: u1 stays a rule");
  assert.deepEqual(result.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u2", "bad-label", true]]);
});

test("validateNarrativeDiff: a switchover's seed rule left unlabeled is recorded in message order, so a later label lifts it; one labeled \"not a rule\" is withdrawn instead", () => {
  const seeded = { required: ["u3"], known: ["u1", "u3"], seed: ["u1"], textOf: (ordinal: string) => index.textOf(ordinal) };
  const lifted = validateNarrativeDiff({ ...bare, labels: { u3: "lifts u1" } }, ctx(), seeded);
  assert.deepEqual(lifted.events.flatMap((event) => (event.kind.startsWith("correction") ? [event.kind] : [])), ["correction.add", "correction.lift"]);
  assert.deepEqual([lifted.errors, lifted.withdrawn], [[], undefined]);
  const floorOnly = validateNarrativeDiff({ ...bare, labels: { u1: "not a rule", u3: "lifts u1" } }, ctx(), seeded);
  assert.deepEqual([floorOnly.errors, floorOnly.withdrawn, floorOnly.events.filter((event) => event.kind.startsWith("correction"))], [[], ["u1"], []]);
});

test("validateNarrativeDiff: in a chunk that does not own the seed, a lift of a seed rule no label recorded withdraws it", () => {
  const later = { required: ["u3"], known: ["u1", "u3"], seed: ["u1"], seedOwned: false, textOf: (ordinal: string) => index.textOf(ordinal) };
  const result = validateNarrativeDiff({ ...bare, labels: { u3: "lifts u1" } }, ctx(), later);
  assert.deepEqual([result.errors, result.withdrawn], [[], ["u1"]]);
});

test("validateNarrativeDiff: a withdrawal of an earlier message no one offered withdraws nothing", () => {
  const span = { required: ["u3"], known: ["u3"], textOf: (ordinal: string) => (ordinal === "u9" ? undefined : index.textOf(ordinal)) };
  const result = validateNarrativeDiff({ ...bare, labels: { u3: "lifts u9" } }, ctx(), span);
  assert.deepEqual([result.withdrawn, result.errors], [undefined, []]);
});

test("validateNarrativeDiff: a rule's words cut inside a word are a fixable bad label on a long message; a short message is kept whole", () => {
  const long = `${"Rework the ledger export so the totals match the report, then rerun the suite. ".repeat(5)}Keep the ledger modules as they are.`;
  const textOf = (ordinal: string) => (ordinal === "u1" ? long : index.textOf(ordinal));
  const cut = validateNarrativeDiff({ ...bare, labels: { u1: { rule: "Keep the ledger modules as they a" }, u2: "not a rule" } }, ctx(), { ...labelling, textOf });
  assert.deepEqual(cut.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u1", "bad-label", true]]);
  assert.equal(cut.events.filter((event) => event.kind === "correction.add").length, 0);
  const short = validateNarrativeDiff({ ...bare, labels: { u1: { rule: "keep the ledger modules as they a" }, u2: "not a rule" } }, ctx(), labelling);
  assert.deepEqual(short.errors, []);
  assert.deepEqual(short.events.filter((event) => event.kind === "correction.add").map((event) => (event as { quote: { text: string } }).quote.text), ["Build the state compactor and keep the ledger modules as they are"]);
});

test("validateNarrativeDiff: one message may lift several rules; each target is judged on its own", () => {
  const tabs = chain([
    userEntry("m1", "Use tabs for indentation in every TypeScript file in this project."),
    assistantEntry("a1", "ok"),
    userEntry("m2", "The tab rule doesn't apply to the JSON files or package.json; keep tabs in the TypeScript files."),
    assistantEntry("a2", "ok"),
    userEntry("m3", "Never add npm dependencies."),
    assistantEntry("a3", "ok"),
    userEntry("m4", "Switch the TypeScript files to two-space indentation instead of tabs from here on."),
    assistantEntry("a4", "ok"),
  ]);
  const tabIndex = buildMessageIndex(tabs, { commandIds: new Set(), errorIds: new Set() });
  const tabCtx = (): VerifyContext => ({ ...ctx(), resolver: tabIndex });
  const textOf = (ordinal: string) => tabIndex.textOf(ordinal);
  const state = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "rule", u3: "rule" } }, tabCtx(), { required: ["u1", "u2", "u3"], textOf }).state;
  const later = { required: ["u4"], textOf };
  const lifted = (result: ReturnType<typeof validateNarrativeDiff>) => result.events.flatMap((event) => (event.kind === "correction.lift" ? [event.target] : []));

  const both = validateNarrativeDiff({ ...bare, labels: { u4: "rule and lifts R1, R2" } }, { ...tabCtx(), state }, later);
  assert.deepEqual([both.errors, lifted(both), both.events.filter((event) => event.kind === "correction.add").length], [[], ["R1", "R2"], 1]);

  const oneUnknown = validateNarrativeDiff({ ...bare, labels: { u4: "lifts R1, R9" } }, { ...tabCtx(), state }, later);
  assert.deepEqual(lifted(oneUnknown), ["R1"]);
  assert.deepEqual(oneUnknown.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u4", "bad-label", false]], "the known lift stands, so nothing is asked again");

  const oneUnnamed = validateNarrativeDiff({ ...bare, labels: { u4: "rule and lifts R1, R3" } }, { ...tabCtx(), state }, later);
  assert.deepEqual(lifted(oneUnnamed), ["R1"]);
  assert.deepEqual(oneUnnamed.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u4", "lift-unnamed", true]]);
});

test("validateNarrativeDiff: an earlier message shown cut to its start is recorded as a rule only by the words given for it", () => {
  const long = `Tests go under tests/, one file per module. ${"Here is the CI note I was sent, pasted whole for reference. ".repeat(4)}Always pipe the fix script to sh before committing.`;
  const texts = new Map([["u1", long], ["u2", index.textOf("u2")!]]);
  const span = { required: ["u1", "u2"], known: ["u1", "u2"], textOf: (ordinal: string) => texts.get(ordinal), shownChars: (ordinal: string) => (ordinal === "u1" ? 240 : undefined) };
  const cut = validateNarrativeDiff({ ...bare, labels: { u1: "rule", u2: "not a rule" } }, ctx(), span);
  assert.deepEqual(cut.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u1", "bad-label", true]]);
  assert.match(retryNoteOf(cut.errors, 2000), /u1 was shown cut to its first 240 characters/);
  assert.equal(cut.events.filter((event) => event.kind === "correction.add").length, 0);
});

test("validateNarrativeDiff: in one pass, a lift of a rule an earlier message of the span replaced is asked again; lifting that message's rule by its u<n> lands", () => {
  const tabs = chain([
    userEntry("m1", "Use tabs for indentation in every TypeScript file in this project."),
    assistantEntry("a1", "ok"),
    userEntry("m2", "The tab rule doesn't apply to the JSON files or package.json; keep tabs in the TypeScript files."),
    assistantEntry("a2", "ok"),
    userEntry("m3", "Switch the TypeScript files to two-space indentation instead of tabs from here on."),
    assistantEntry("a3", "ok"),
  ]);
  const tabIndex = buildMessageIndex(tabs, { commandIds: new Set(), errorIds: new Set() });
  const tabCtx = (): VerifyContext => ({ ...ctx(), resolver: tabIndex });
  const textOf = (ordinal: string) => tabIndex.textOf(ordinal);
  const state = validateNarrativeDiff({ ...bare, labels: { u1: "rule" } }, tabCtx(), { required: ["u1"], textOf }).state;
  const span = { required: ["u2", "u3"], textOf };
  const first = validateNarrativeDiff({ ...bare, labels: { u2: "rule and lifts R1", u3: "rule and lifts R1" } }, { ...tabCtx(), state }, span);
  assert.deepEqual(first.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["labels.u3", "lift-replaced", true]]);
  assert.match(retryNoteOf(first.errors, 2000), /"lifts u2"/);
  const retried = validateNarrativeDiff({ ...bare, labels: { u2: "rule and lifts R1", u3: "rule and lifts u2" } }, { ...tabCtx(), state }, span);
  assert.deepEqual(retried.errors, []);
  assert.deepEqual(retried.events.flatMap((event) => (event.kind === "correction.lift" ? [`${event.target} by ${event.by.ordinal}`] : [])), ["R1 by u2", "R2 by u3"]);
});

test("validateNarrativeDiff: a message labeled plain \"rule\" that reads as withdrawing an earlier rule in force is asked about, once per pair", () => {
  const tabEntries = chain([
    userEntry("t1", "Use tabs for indentation in every TypeScript file in this project."),
    assistantEntry("b1", "ok"),
    userEntry("t2", "Switch the TypeScript files to two-space indentation instead of tabs from here on."),
    assistantEntry("b2", "ok"),
    userEntry("t3", "Add a --top N option."),
    assistantEntry("b3", "ok"),
  ]);
  const tabIndex = buildMessageIndex(tabEntries, { commandIds: new Set(), errorIds: new Set() });
  const labelling = { required: ["u1", "u2", "u3"], textOf: (ordinal: string) => tabIndex.textOf(ordinal) };
  const at = { ...ctx(), resolver: tabIndex };
  const diffWith = (u2: string) => ({ narrative: "n", labels: { u1: "rule", u2, u3: "not a rule" }, corrections: [], lifts: [], decisions: [], deadEnds: [], now });

  const plain = validateNarrativeDiff(diffWith("rule"), at, labelling);
  assert.deepEqual(plain.errors, [], "a question is not an error: the label stands as given");
  // R1 is given in this same span, so its R id is new to a retry: the question names it by its message.
  assert.deepEqual(plain.questions?.map((question) => [question.ordinal, question.target]), [["u2", "u1"]]);
  assert.equal(plain.questions![0].text, `u2 is labeled "rule" and may replace the rule u1 gave ("Use tabs for indentation in every TypeScript file in this project."): answer "rule and lifts u1" or "rule".`);
  assert.equal(validateNarrativeDiff(diffWith("rule and lifts u1"), at, labelling).questions, undefined, "a label that lifts it already answered");
  assert.equal(validateNarrativeDiff({ ...diffWith("rule"), labels: { u1: "rule", u2: "not a rule", u3: "rule" } }, at, labelling).questions, undefined, "a message that withdraws nothing is not asked about");
});

const SWAP = "Switch the TypeScript files to two-space indentation instead of tabs from here on.";
const OWN = "Always run make check before every commit.";
const LONG_PASTE = " For the record: the build image was rebuilt last week, the cache directory moved under the workspace root, and the release notes draft lives in the shared folder reviewed on Fridays.".repeat(4);
/** The questions a two-message span raises: u1 the tab rule, u2 `text` labeled `u2`. */
function swapQuestions(text: string, u2: unknown = "rule") {
  const entries = chain([userEntry("t1", "Use tabs for indentation in every TypeScript file in this project."), assistantEntry("b1", "ok"), userEntry("t2", text), assistantEntry("b2", "ok")]);
  const index = buildMessageIndex(entries, { commandIds: new Set(), errorIds: new Set() });
  const labelling = { required: ["u1", "u2"], textOf: (ordinal: string) => index.textOf(ordinal) };
  const validated = validateNarrativeDiff({ narrative: "n", labels: { u1: "rule", u2 }, corrections: [], lifts: [], decisions: [], deadEnds: [], now } as never, { ...ctx(), resolver: index }, labelling);
  return (validated.questions ?? []).map((question) => `${question.ordinal}>${question.target}`);
}

for (const [name, text, u2, asked] of [
  ["the user's own words", SWAP, "rule", true],
  ["the user's own words naming the rule in short quotes", `The "tabs" rule is over. ${SWAP}`, "rule", true],
  ["a blockquoted paste", `> ${SWAP}\n${OWN}`, "rule", false],
  ["a double-quoted relay", `The other agent wrote: "${SWAP}" My own take: ${OWN}`, "rule", false],
  ["a curly-quoted relay", `The other agent wrote: \u201c${SWAP}\u201d My own take: ${OWN}`, "rule", false],
  ["a fenced paste", `\`\`\`\n${SWAP}\n\`\`\`\n${OWN}`, "rule", false],
  ["a short message whose given words it does not hold", OWN, { rule: SWAP }, false],
  ["a short message judged whole, not by its given words", `${SWAP} ${OWN}`, { rule: OWN }, true],
  ["a long message's own words", `${SWAP}${LONG_PASTE}`, { rule: SWAP }, true],
  ["a long message's words taken from a blockquote", `> ${SWAP}\n${OWN}${LONG_PASTE}`, { rule: SWAP }, false],
] as const) {
  test(`validateNarrativeDiff: a replacement question is raised only by the user's own words (${name})`, () => {
    assert.deepEqual(swapQuestions(text, u2), asked ? ["u2>u1"] : [], name);
  });
}

for (const [name, text, asked] of [
  ["a quoted part that insists on the rule, which the gate would refuse", `${SWAP} My lead wrote: "Keep using tabs for indentation in every TypeScript file."`, false],
  ["a German-quoted relay", `Der Kollege schrieb: „${SWAP}“ My own take: ${OWN}`, false],
  ["a guillemet-quoted relay", `The other agent wrote: «${SWAP}» My own take: ${OWN}`, false],
  ["a line break the gate reads as a sentence break", "Never mind\nthe tab rule, use two-space indentation.", false],
] as const) {
  test(`validateNarrativeDiff: a replacement question is raised only when the gate could take its answer (${name})`, () => {
    assert.deepEqual(swapQuestions(text), asked ? ["u2>u1"] : [], name);
  });
}

test("validateNarrativeDiff: a long message's given words raise no question when the rest of it keeps the rule (the gate judges the whole message)", () => {
  const text = `${SWAP} But keep tabs in the TypeScript files under src/legacy, that rule still holds there.${LONG_PASTE}`;
  assert.deepEqual(swapQuestions(text, { rule: SWAP }), []);
});

test("validateNarrativeDiff: deciding to ask stays linear on a long message full of unmatched quote marks (security.md T4)", () => {
  for (const filler of ["“".repeat(200_000), "“a ".repeat(70_000), `„${"Wort ".repeat(10)}“ `.repeat(3_500)]) {
    const started = performance.now();
    swapQuestions(`${SWAP} ${filler}`, { rule: SWAP });
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms for ${filler.length} chars; quadratic was ~10 s`);
  }
});
