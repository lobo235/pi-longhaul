/**
 * The harm-based path prune.
 *
 * The carried bundle's bulk is the file lists: in a long session the `modifiedFiles` paths alone
 * have run to 25k characters, re-rendered on every pass. The answer is not a size target -- a
 * removal driven by "we are too big" takes out whatever is in reach, and the summary then lies
 * about work that was really done. A path is removed here only when BOTH hold:
 *
 *   * its presence cannot help a resumed session, and
 *   * its absence cannot make the summary untrue.
 *
 * Two rules meet that bar today:
 *
 *   * `build-tree` -- a path under a generated or dependency tree (`node_modules/`, `dist/`, ...).
 *     Nothing resumes from build output, and its absence is not a stale fact. The matched boundary
 *     is a whole path SEGMENT, so `src/build-info.ts` and `docs/distribution.md` are untouched.
 *   * `redundant-directory` -- a listed directory that a listed file beneath it already implies.
 *     The specific file is the resumable fact; the directory adds nothing a reader can act on.
 *
 * The protection that makes the first rule safe is the caller's: only CARRIED paths are offered
 * here, never the pass being compacted. The newest pass's additions are protected, and a carried
 * build-tree path that still mattered would have been re-read this pass -- which makes it current,
 * hence protected. A carried path that is also current is protected here too.
 *
 * Every removal is returned with its rule, so the audit has exactly one source.
 */

/** Why a path was removed. */
export type PruneRule = "build-tree" | "redundant-directory";

export interface PruneRemoval {
  path: string;
  rule: PruneRule;
}

export interface PruneResult {
  /** The carried paths worth keeping, in the order they were offered. */
  kept: string[];
  removed: PruneRemoval[];
}

/**
 * Path segments that name generated or dependency content: nothing resumes from them.
 *
 * This is DATA, not logic: extending it is a deliberate commit like any other policy change. Each
 * entry is matched as a whole segment at any depth, so a file merely named after one of them
 * (`src/build-info.ts`) never matches.
 */
export const BUILD_TREE_SEGMENTS: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  ".git",
  ".next",
  ".cache",
  ".turbo",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".terraform",
  "vendor",
];

function isBuildTreePath(path: string): boolean {
  return path.split("/").some((segment) => BUILD_TREE_SEGMENTS.includes(segment));
}

/** True when another listed path sits beneath `path`, which is what makes `path` a redundant directory. */
function impliedByDescendant(path: string, listed: ReadonlySet<string>): boolean {
  const prefix = `${path}/`;
  for (const other of listed) {
    if (other.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Split carried paths into the ones worth carrying further and the ones the harm rules remove.
 *
 * `current` is the pass being compacted: those paths are never offered for removal (they are the
 * newest additions) and they count as listed, so a carried directory they sit beneath is
 * redundant. Neither input is mutated.
 */
export function pruneCarriedPaths(carried: readonly string[], current: readonly string[]): PruneResult {
  const currentSet = new Set(current);
  const listed = new Set<string>([...carried, ...current]);
  const kept: string[] = [];
  const removed: PruneRemoval[] = [];
  for (const path of carried) {
    if (currentSet.has(path)) {
      kept.push(path);
    } else if (isBuildTreePath(path)) {
      removed.push({ path, rule: "build-tree" });
    } else if (impliedByDescendant(path, listed)) {
      removed.push({ path, rule: "redundant-directory" });
    } else {
      kept.push(path);
    }
  }
  return { kept, removed };
}
