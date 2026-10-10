/**
 * The harm-based path prune (prune.ts).
 *
 * The cases that matter are the boundaries: the rule is matched per path SEGMENT (so a file named
 * after a build tree survives), and the pass being compacted is never pruned (the "newest pass's
 * additions" protection), which is the property that keeps build-tree pruning from erasing
 * the file a session is currently working on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pruneCarriedPaths } from "./prune.ts";

const A = "/home/x/dev/a";

test("keeps ordinary carried paths, in order", () => {
  const carried = [`${A}/bin/orc-launch`, `${A}/README.md`];
  const { kept, removed } = pruneCarriedPaths(carried, []);
  assert.deepEqual(kept, carried);
  assert.deepEqual(removed, []);
});

test("drops a carried path under a build or dependency tree, at any depth", () => {
  const { kept, removed } = pruneCarriedPaths(
    [
      `${A}/node_modules/@scope/pkg/index.js`,
      `${A}/src/main.ts`,
      `${A}/dist/main.js`,
      `${A}/.git/ORIG_HEAD`,
      `${A}/target/debug/build/x`,
      `${A}/__pycache__/mod.pyc`,
      `${A}/.venv/lib/python3.13/site-packages/x.py`,
      `${A}/coverage/lcov.info`,
      `${A}/packages/web/node_modules/react/index.js`,
    ],
    [],
  );
  assert.deepEqual(kept, [`${A}/src/main.ts`]);
  assert.equal(removed.length, 8);
  for (const entry of removed) assert.equal(entry.rule, "build-tree");
  assert.equal(removed[0].path, `${A}/node_modules/@scope/pkg/index.js`);
});

test("the boundary is a path segment, never a substring", () => {
  const paths = [
    `${A}/src/build-info.ts`,
    `${A}/docs/distribution.md`,
    `${A}/outbox/note.md`,
    `${A}/vendor-report.md`,
    `${A}/.github/workflows/ci.yml`,
  ];
  const { kept, removed } = pruneCarriedPaths(paths, []);
  assert.deepEqual(kept, paths);
  assert.deepEqual(removed, []);
});

test("the pass being compacted is never pruned, even when it is a build tree", () => {
  // The ADR protects the newest pass's additions: a path read NOW stays, build tree or not.
  const current = [`${A}/dist/main.js`, `${A}/node_modules/@scope/pkg/index.js`];
  const { kept, removed } = pruneCarriedPaths([], current);
  assert.deepEqual(kept, []);
  assert.deepEqual(removed, []);
});

test("a carried path that is also current is protected, not dropped", () => {
  const path = `${A}/node_modules/@scope/pkg/index.js`;
  const { kept, removed } = pruneCarriedPaths([path], [path]);
  assert.deepEqual(kept, [path]);
  assert.deepEqual(removed, []);
});

test("drops a carried directory a listed file beneath it already implies", () => {
  const { kept, removed } = pruneCarriedPaths([`${A}/src`, `${A}/src/main.ts`], []);
  assert.deepEqual(kept, [`${A}/src/main.ts`]);
  assert.deepEqual(removed, [{ path: `${A}/src`, rule: "redundant-directory" }]);
});

test("a current file also makes a carried directory redundant", () => {
  const { kept, removed } = pruneCarriedPaths([`${A}/src`], [`${A}/src/main.ts`]);
  assert.deepEqual(kept, []);
  assert.deepEqual(removed, [{ path: `${A}/src`, rule: "redundant-directory" }]);
});

test("a carried path that merely shares a prefix is not redundant", () => {
  // `src` is a directory only when a listed path sits beneath it; `src-utils` never is.
  const { kept, removed } = pruneCarriedPaths([`${A}/src`], [`${A}/src-utils/helper.ts`]);
  assert.deepEqual(kept, [`${A}/src`]);
  assert.deepEqual(removed, []);
});

test("neither input is mutated or reordered", () => {
  const carried = [`${A}/node_modules/x`, `${A}/b.ts`];
  const current = [`${A}/c.ts`];
  const carriedCopy = [...carried];
  const currentCopy = [...current];
  pruneCarriedPaths(carried, current);
  assert.deepEqual(carried, carriedCopy);
  assert.deepEqual(current, currentCopy);
});
