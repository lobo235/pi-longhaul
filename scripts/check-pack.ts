/**
 * Checks what `npm pack` would publish: everything pi needs to load and run Longhaul, and nothing that only the
 * repository needs (tests, snapshots, scripts, internal docs). Exits 1 naming each problem.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const repo = path.join(import.meta.dirname, "..");
const REQUIRED = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "pi-compat.json", "config.example.json",
  "src/index.ts", "fixtures/setup-check-session.jsonl", "docs/setup-with-an-agent.md", "docs/security.md"];
/** Clone-only code never ships: test helpers, the offline scorer and the transcript inspector that imports it. */
const FORBIDDEN = [/\.test\.ts$/, /test-support\.ts$/, /^src\/score\//, /^src\/state-cli\.ts$/, /\.snapshots\//, /^scripts\//, /^eval\//, /^\.github\//, /internal/i, /^AGENTS\.md$/, /^CLAUDE\.md$/, /\.env/];

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repo, encoding: "utf8" })) as
  { files: { path: string }[]; unpackedSize: number }[];
const files = packed[0].files.map((file) => file.path);

const problems = [
  ...REQUIRED.filter((name) => !files.includes(name)).map((name) => `missing: ${name}`),
  ...files.filter((name) => FORBIDDEN.some((pattern) => pattern.test(name))).map((name) => `must not ship: ${name}`),
];
for (const problem of problems) console.error(`check-pack: ${problem}`);
console.log(`check-pack: ${files.length} files, ${packed[0].unpackedSize} bytes unpacked: ${problems.length ? "FAIL" : "ok"}`);
process.exit(problems.length ? 1 : 0);
