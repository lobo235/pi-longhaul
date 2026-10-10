#!/usr/bin/env node
/**
 * Load smoke: load this extension exactly the way pi loads it.
 *
 * pi's extension loader (dist/core/extensions/loader.js in
 * @earendil-works/pi-coding-agent) transforms .ts with jiti and resolves the
 * `@earendil-works/*` + typebox specifiers through a fixed alias set. That
 * transform is STRICTER than Node's own type stripping: a module that
 * `node --test` loads happily can still be a ParseError for pi (2026-09-16:
 * a duplicate `Usage` type import in summarize.ts loaded fine under node and
 * killed every pi launch on every host). So the unit tests and the
 * type-check are not sufficient on their own — this smoke re-runs the real
 * load and fails `npm test` when pi could not load the extension.
 *
 * It resolves jiti and the aliases from THIS directory's pinned
 * pi-coding-agent devDependency (package.json + package-lock.json), not from
 * whatever pi happens to be on PATH, so the gate is hermetic and checks the
 * extension against the same pi version pi-compat.json records. If you bump
 * the pi-coding-agent devDependency, re-run the reverification procedure in
 * README.md first.
 *
 * It loads index.ts (the entry point from package.json "pi.extensions") with
 * its full module graph and asserts the entry point exports the extension
 * factory: a non-function default export is not an error to pi's loader, it
 * is a SILENTLY NO-OP extension, so the assertion is part of the contract.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// --- resolve the alias set, mirroring getAliases() in pi's loader.js -------
// pi's loader is a file inside the pi-coding-agent package, so everything it
// resolves (jiti, typebox, the pi sub-packages) resolves from THERE. Anchor a
// require at the package's dist tree to reproduce that exactly.
const piPkgDir = path.join(here, "node_modules/@earendil-works/pi-coding-agent");
const piAnchor = createRequire(path.join(piPkgDir, "dist/noop.js"));
const resolvePi = (specifier) => piAnchor.resolve(specifier);

let jitiModule;
try {
  // pi imports { createJiti } from "jiti/static" (loader.js, unbundled Node path). The
  // subpath is import-only in jiti's exports map, so resolve it through the map itself
  // (require.resolve would apply the "require" condition and fail where ESM does not).
  const jitiPkgJson = piAnchor.resolve("jiti/package.json");
  const jitiPkg = JSON.parse(fs.readFileSync(jitiPkgJson, "utf8"));
  const staticEntry = jitiPkg.exports?.["./static"]?.import;
  if (!staticEntry) throw new Error('jiti exports map has no ".static" import entry');
  jitiModule = await import(pathToFileURL(path.join(path.dirname(jitiPkgJson), staticEntry)).href);
} catch (e) {
  console.error(`FAIL: cannot resolve jiti inside the pinned pi-coding-agent install: ${e.message}`);
  process.exit(1);
}
const { createJiti } = jitiModule;

// pi's getAliases() tries monorepo workspace paths first and falls back to
// import.meta.resolve(specifier) in an npm install. The pi sub-packages are
// import-only (no "require" condition in their exports maps), so reproduce
// that import-condition resolve by walking node_modules and reading the
// exports map directly.
function resolveFromPi(specifier) {
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const sub = specifier.slice(name.length).replace(/^\//, "");
  let dir = piPkgDir;
  for (;;) {
    const pkgDir = path.join(dir, "node_modules", name);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const entry = pkg.exports?.[sub === "" ? "." : `./${sub}`];
      if (entry) {
        const file = typeof entry === "string" ? entry : entry.import ?? entry.default;
        if (typeof file === "string") return path.join(pkgDir, file);
      }
      // wildcard patterns (e.g. pi-ai's "./providers/*")
      if (pkg.exports) {
        for (const [key, val] of Object.entries(pkg.exports)) {
          if (!key.includes("*") || !key.startsWith("./")) continue;
          const pattern = key.slice(2);
          const star = pattern.indexOf("*");
          const prefix = pattern.slice(0, star);
          const suffix = pattern.slice(star + 1);
          if (!sub.startsWith(prefix) || !sub.endsWith(suffix)) continue;
          const rest = sub.slice(prefix.length, sub.length - suffix.length);
          const file = (typeof val === "string" ? val : val.import ?? val.default)?.replace("*", rest);
          if (typeof file === "string") return path.join(pkgDir, file);
        }
      }
      if (!pkg.exports && pkg.main) return path.join(pkgDir, pkg.main); // e.g. pi-tui
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot resolve ${specifier} from ${piPkgDir}`);
    dir = parent;
  }
}

const alias = {
  "@earendil-works/pi-coding-agent": path.join(piPkgDir, "dist", "index.js"),
  "@earendil-works/pi-agent-core": resolveFromPi("@earendil-works/pi-agent-core"),
  "@earendil-works/pi-tui": resolveFromPi("@earendil-works/pi-tui"),
  "@earendil-works/pi-ai/providers/all": resolveFromPi("@earendil-works/pi-ai/providers/all"),
  "@earendil-works/pi-ai/compat": resolveFromPi("@earendil-works/pi-ai/compat"),
  "@earendil-works/pi-ai/oauth": resolveFromPi("@earendil-works/pi-ai/oauth"),
  "@earendil-works/pi-ai": resolveFromPi("@earendil-works/pi-ai/compat"),
  "@mariozechner/pi-coding-agent": path.join(piPkgDir, "dist", "index.js"),
  "@mariozechner/pi-agent-core": resolveFromPi("@earendil-works/pi-agent-core"),
  "@mariozechner/pi-tui": resolveFromPi("@earendil-works/pi-tui"),
  "@mariozechner/pi-ai/providers/all": resolveFromPi("@earendil-works/pi-ai/providers/all"),
  "@mariozechner/pi-ai/compat": resolveFromPi("@earendil-works/pi-ai/compat"),
  "@mariozechner/pi-ai/oauth": resolveFromPi("@earendil-works/pi-ai/oauth"),
  "@mariozechner/pi-ai": resolveFromPi("@earendil-works/pi-ai/compat"),
  // typebox DOES have a require condition — pi's own loader uses require.resolve for it.
  typebox: resolvePi("typebox"),
  "typebox/compile": resolvePi("typebox/compile"),
  "typebox/value": resolvePi("typebox/value"),
  "@sinclair/typebox": resolvePi("typebox"),
  "@sinclair/typebox/compile": resolvePi("typebox/compile"),
  "@sinclair/typebox/value": resolvePi("typebox/value"),
};

// The entry point is whatever package.json tells pi to load.
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const entries = pkg?.pi?.extensions ?? [];
if (entries.length === 0) {
  console.error("FAIL: package.json has no pi.extensions entry; pi would load nothing");
  process.exit(1);
}

// pi creates jiti with ITS OWN loader.js url as base and moduleCache off
// (loader.js, loadExtensionModule).
const base = pathToFileURL(path.join(piPkgDir, "dist", "core", "extensions", "loader.js")).href;
let failures = 0;
for (const entry of entries) {
  const entryPath = path.join(here, entry);
  const jiti = createJiti(base, { moduleCache: false, alias });
  try {
    const factory = await jiti.import(pathToFileURL(entryPath).href, { default: true });
    if (typeof factory !== "function") {
      console.error(`FAIL: ${entry} loaded but does not export the extension factory (got ${typeof factory}); pi would load a silent no-op`);
      failures++;
      continue;
    }
    console.log(`ok: ${entry} loads through pi's jiti transform (factory: ${factory.name || "anonymous"})`);
  } catch (e) {
    // pi reports exactly this: `Failed to load extension "<path>": <error>`
    console.error(`FAIL: pi would report: Failed to load extension "${entry}": ${e.constructor?.name ?? "Error"}: ${String(e.message).split("\n")[0]}`);
    failures++;
  }
}
process.exit(failures === 0 ? 0 : 1);
