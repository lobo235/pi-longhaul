import assert from "node:assert/strict";
import { test } from "node:test";

import { childEnv } from "./child-env.ts";

test("childEnv: pi gets the variables it needs and the smoke's own HOME and agent dir, nothing else from the parent", () => {
  const parent = { PATH: "/usr/bin", LANG: "C.UTF-8", TMPDIR: "/tmp", HOME: "/home/user", FAKE_API_KEY: "sk-sentinel", OPENAI_API_KEY: "sk-real", NODE_OPTIONS: "--require=/x.js", GIT_CONFIG: "/x", PI_COMPACTOR: "thinking-off", PI_CODING_AGENT_DIR: "/home/user/.pi/agent" };
  const env = childEnv(parent, "/tmp/smoke", "/tmp/smoke/agent");
  assert.deepEqual(env, { PATH: "/usr/bin", LANG: "C.UTF-8", TMPDIR: "/tmp", HOME: "/tmp/smoke", PI_CODING_AGENT_DIR: "/tmp/smoke/agent" });
});

test("childEnv: Windows keeps what a process needs to start there", () => {
  const env = childEnv({ Path: "C:\\bin", SystemRoot: "C:\\Windows", PATHEXT: ".EXE;.CMD", TEMP: "C:\\t", USERPROFILE: "C:\\Users\\u" }, "C:\\s", "C:\\s\\agent");
  assert.deepEqual(env, { Path: "C:\\bin", SystemRoot: "C:\\Windows", PATHEXT: ".EXE;.CMD", TEMP: "C:\\t", HOME: "C:\\s", USERPROFILE: "C:\\s", PI_CODING_AGENT_DIR: "C:\\s\\agent" });
});
