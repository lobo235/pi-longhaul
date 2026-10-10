import assert from "node:assert/strict";
import { test } from "node:test";

import { installEnv, parseArgs } from "./cross-version-smoke.ts";

test("cross-version parseArgs: --extra adds a version (repeatable), --keep keeps the directory", () => {
  assert.deepEqual(parseArgs([]), { extras: [], keep: false });
  assert.deepEqual(parseArgs(["--extra", "1.2.0", "--keep", "--extra", "1.3.0"]), { extras: ["1.2.0", "1.3.0"], keep: true });
});

test("cross-version parseArgs: refuses an unknown argument and an --extra without a version", () => {
  assert.deepEqual(parseArgs(["1.2.0"]), { error: "unexpected argument: 1.2.0" });
  assert.deepEqual(parseArgs(["--extra"]), { error: "unexpected argument: --extra" });
});

test("cross-version installEnv: drops the npm settings `npm run` passes down, keeps everything else", () => {
  const env = installEnv({ PATH: "/usr/bin", HOME: "/home/user", npm_config_allow_scripts: "x", NPM_CONFIG_REGISTRY: "https://example.invalid", npm_execpath: "/npm-cli.js" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/user", npm_execpath: "/npm-cli.js" });
});
