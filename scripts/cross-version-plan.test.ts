import assert from "node:assert/strict";
import { test } from "node:test";

import { installCutoff, planChains } from "./cross-version-plan.ts";

test("planChains: one transcript upgraded through every version, oldest first, and one downgraded, newest first", () => {
  assert.deepEqual(planChains(["1.0.0", "0.87.1", "1.1.0"]), [
    { name: "upgrade", versions: ["0.87.1", "1.0.0", "1.1.0"] },
    { name: "downgrade", versions: ["1.1.0", "1.0.0", "0.87.1"] },
  ]);
});

test("planChains: a version given twice (the nightly's newest pi already listed) is visited once", () => {
  assert.deepEqual(planChains(["1.1.0", "1.0.4", "1.1.0"])[0], { name: "upgrade", versions: ["1.0.4", "1.1.0"] });
});

test("planChains: refuses a version that is not plain x.y.z, before anything is installed", () => {
  for (const bad of ["latest", "1.0", "1.0.0-rc.1", "1.0.0; rm -rf ~", ""]) {
    assert.throws(() => planChains(["1.0.0", bad]), /not a pi version/, bad);
  }
});

test("planChains: needs two versions, since a chain of one hands the transcript to nobody", () => {
  assert.throws(() => planChains(["1.1.0", "1.1.0"]), /at least two/);
});

test("installCutoff: a pi's dependencies resolve as on its release day, with an hour for its lockstep packages", () => {
  const times = { "1.1.0": "2026-10-07T22:16:26.802Z", modified: "2026-10-07T22:16:27.157Z" };
  assert.equal(installCutoff(times, "1.1.0"), "2026-10-07T23:16:26.802Z");
});

test("installCutoff: refuses a version npm has no publish time for, or a time that is not a date", () => {
  assert.throws(() => installCutoff({ "1.1.0": "2026-10-07T22:16:26.802Z" }, "1.0.4"), /no publish time for pi 1.0.4/);
  assert.throws(() => installCutoff({ "1.0.4": "yesterday" }, "1.0.4"), /no publish time for pi 1.0.4/);
});
