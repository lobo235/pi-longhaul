import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";

import { foreignCompactionNotice, localOnlyRootsNotice, MIN_CONTEXT_WINDOW, smallWindowNotice } from "./notices.ts";

for (const [name, details, fromExtension, expected] of [
  ["the State compactor's own stamp is not foreign", { compactor: "state" }, true, undefined],
  ["another extension's stamp names another extension", { compactor: "another-compactor" }, true, /another extension's compactor did/],
  ["an extension result with no details is still another extension's", undefined, true, /another extension's compactor did/],
  ["pi's own compaction names pi's summarizer", undefined, false, /pi's own summarizer did/],
  ["a non-object details value is not the State compactor's", "state", true, /another extension/],
] as const) test(`foreignCompactionNotice: ${name}`, () => {
  const notice = foreignCompactionNotice(details, fromExtension);
  if (expected === undefined) assert.equal(notice, undefined);
  else assert.match(notice ?? "", expected);
});

for (const [name, contextWindow, warns] of [
  ["a window below the minimum warns", MIN_CONTEXT_WINDOW - 1, true],
  ["exactly the minimum is supported", MIN_CONTEXT_WINDOW, false],
  ["a large window is supported", 200_000, false],
  ["an unknown (zero) window says nothing rather than guess", 0, false],
  ["a missing window says nothing", undefined, false],
] as const) test(`smallWindowNotice: ${name}`, () => {
  assert.equal(smallWindowNotice({ provider: "p", id: "m", contextWindow }) !== undefined, warns);
});

test("smallWindowNotice: no model, no notice", () => {
  assert.equal(smallWindowNotice(undefined), undefined);
});

for (const [name, roots, home, expected] of [
  ["no roots, no notice", [], "/home/agent", undefined],
  ["absolute and home-relative roots are usable", ["/srv/x", "~/dev/x", "~"], "/home/agent", undefined],
  ["a Windows path is named, not silently dropped", ["/srv/x", "C:\\work\\secret"], "/home/agent", /"C:\\work\\secret" .*not an absolute POSIX path/],
  ["a relative path is named", ["dev/secret"], "/home/agent", /"dev\/secret" .*not an absolute POSIX path/],
  ["a home-relative root with no HOME is named", ["~/dev/x"], undefined, /"~\/dev\/x" .*HOME is not set/],
] as const) test(`localOnlyRootsNotice: ${name}`, () => {
  const notice = localOnlyRootsNotice(roots, home, path.posix);
  if (expected === undefined) assert.equal(notice, undefined);
  else {
    assert.match(notice ?? "", expected);
    assert.match(notice ?? "", /sessions there may be summarized off this machine/);
  }
});

test("localOnlyRootsNotice: every unusable entry is named in one notice", () => {
  const notice = localOnlyRootsNotice(["a", "/ok", "b"], "/home/agent", path.posix) ?? "";
  assert.match(notice, /"a"/);
  assert.match(notice, /"b"/);
  assert.doesNotMatch(notice, /"\/ok"/);
});

test("localOnlyRootsNotice: on Windows a drive path is usable, a POSIX one is named, and the advice gives a drive path", () => {
  assert.equal(localOnlyRootsNotice(["C:\\work\\secret", "~\\dev"], "C:\\Users\\agent", path.win32), undefined);
  const notice = localOnlyRootsNotice(["/srv/x"], "C:\\Users\\agent", path.win32) ?? "";
  assert.match(notice, /"\/srv\/x" \(it is not an absolute path/);
  assert.match(notice, /Use an absolute path \(C:\\\.\.\.\)/);
});
