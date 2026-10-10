import assert from "node:assert/strict";
import test from "node:test";

import { factMatches } from "./fact-shapes.ts";

test("factMatches (table): a value is matched whole or not at all, never as a wrong piece of a longer one", () => {
  const cases: Array<[string, string, Array<[string, string]>]> = [
    ["an address is not a version", "listening on 127.0.0.1:8080", [["8080", "number"]]],
    ["a four-part version is not cut to three", "build 2.14.0.7 ready", []],
    ["a version still ends a sentence", "pi 1.0.2. node v26.8.2-rc.1 too", [["1.0.2", "version"], ["v26.8.2-rc.1", "version"]]],
    ["a name format with placeholders is one path", "archives are named <source-basename>-YYYYMMDD-HHMMSS.tar.gz now", [["<source-basename>-YYYYMMDD-HHMMSS.tar.gz", "path"]]],
    ["a placeholder directory stays in the path", "written to <dest>/<name>.json", [["<dest>/<name>.json", "path"]]],
  ];
  for (const [name, text, expected] of cases) assert.deepEqual(factMatches(text).map((match) => [match.raw, match.kind]), expected, name);
});
