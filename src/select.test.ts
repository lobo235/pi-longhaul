import test from "node:test";
import assert from "node:assert/strict";

import { COMPACTOR_ENV, STATE_LOADED_ENV, selectCompactor, stateLoadedMarker, stateStandsDown } from "./select.ts";

const LOADED = stateLoadedMarker();

test("selectCompactor: unset, empty and whitespace select Longhaul and say it was the default (table)", () => {
  for (const [label, env] of [
    ["unset", {}],
    ["empty", { [COMPACTOR_ENV]: "" }],
    ["whitespace", { [COMPACTOR_ENV]: "   " }],
  ] as const) {
    assert.deepEqual(selectCompactor(env), { longhaul: true, defaulted: true, stateLoaded: false }, label);
  }
});

test("selectCompactor: state selects Longhaul by name, surrounding whitespace ignored", () => {
  assert.deepEqual(selectCompactor({ [COMPACTOR_ENV]: "state" }), { longhaul: true, stateLoaded: false });
  assert.deepEqual(selectCompactor({ [COMPACTOR_ENV]: " state " }), { longhaul: true, stateLoaded: false });
});

test("selectCompactor: any other value, pi's name, another compactor's or a misspelling, stands Longhaul down (table)", () => {
  for (const value of ["pi", "another-compactor", "State", "bogus"]) {
    const selection = selectCompactor({ [COMPACTOR_ENV]: value, [STATE_LOADED_ENV]: LOADED });
    assert.equal(selection.longhaul, false, value);
    assert.equal(stateStandsDown(selection), true, value);
  }
});

test("selectCompactor: the loaded marker counts only when this process set it, so a child pi cannot inherit it (table)", () => {
  assert.equal(selectCompactor({ [STATE_LOADED_ENV]: LOADED }).stateLoaded, true);
  for (const [label, marker] of [
    ["another process", stateLoadedMarker(process.pid + 1)],
    ["a constant", "1"],
    ["garbage", "yes"],
  ] as const) {
    assert.equal(selectCompactor({ [STATE_LOADED_ENV]: marker }).stateLoaded, false, label);
  }
});

test("stateStandsDown: Longhaul compacts exactly when it is selected, whether or not the marker is set (table)", () => {
  const cases = [
    { env: {}, standsDown: false },
    { env: { [STATE_LOADED_ENV]: LOADED }, standsDown: false },
    { env: { [COMPACTOR_ENV]: "state" }, standsDown: false },
    { env: { [COMPACTOR_ENV]: "pi", [STATE_LOADED_ENV]: LOADED }, standsDown: true },
  ];
  for (const { env, standsDown } of cases) assert.equal(stateStandsDown(selectCompactor(env)), standsDown, JSON.stringify(env));
});
