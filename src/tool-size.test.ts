/** The README's figure for what the two tools add to every request, kept within 5% of what they really add. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { registerRecallTool } from "./recall-tool.ts";
import { registerRememberTool } from "./remember-tool.ts";

test("README: the stated size of the two tools' schemas and prompt guidelines is within 5% of the real size", () => {
  const tools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[]; promptSnippet?: string }> = [];
  const pi = { registerTool: (tool: (typeof tools)[number]) => tools.push(tool) } as never;
  registerRecallTool(pi);
  registerRememberTool(pi);
  const size = tools.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length + (tool.promptGuidelines ?? []).join("\n").length + (tool.promptSnippet ?? "").length, 0);
  const stated = /The two tools add about ([\d,]+) characters to every request/.exec(readFileSync(new URL("../README.md", import.meta.url), "utf8"));
  assert.ok(stated, "the README states the size");
  const claimed = Number(stated[1].replace(/,/g, ""));
  assert.ok(Math.abs(claimed - size) <= size * 0.05, `README says about ${claimed}; the tools add ${size}`);
});
