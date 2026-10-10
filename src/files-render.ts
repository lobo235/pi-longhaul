/**
 * The `## Files` section: the file lists the pass carries (carry.ts), shown to the model the way
 * a `<read-files>` / `<modified-files>` summary footer shows them, under a character budget
 * (`caps.filesChars`). Modified files come first, then read files, each newest first, and the cut
 * is a single newest-first prefix: everything listed is newer than anything left out, and what is
 * left out stays answerable by `recall files <pattern>`.
 */
import { RECALL_TOOL } from "./tool-names.ts";
import type { FileLists } from "./carry.ts";
import { oneLine } from "./one-line.ts";

const SEPARATOR = ", ";

/** Modified first, then read (a file both modified and read counts as modified), each newest first, deduped. */
export function orderedFiles(files: FileLists): { modified: string[]; read: string[] } {
  const modified = [...new Set(files.modifiedFiles.map(oneLine))].filter(Boolean).reverse();
  const shown = new Set(modified);
  return { modified, read: [...new Set(files.readFiles.map(oneLine))].filter((file) => file && !shown.has(file)).reverse() };
}

export function renderFilesSection(files: FileLists, budgetChars: number): string[] {
  const { modified, read } = orderedFiles(files);
  if (modified.length + read.length === 0) return ["## Files", "(none recorded)"];
  const kept = { modified: [] as string[], read: [] as string[] };
  let used = 0;
  let full = false;
  for (const [list, out] of [[modified, kept.modified], [read, kept.read]] as const) {
    for (const file of list) {
      const cost = file.length + (out.length ? SEPARATOR.length : 0);
      if (full || used + cost > budgetChars) { full = true; break; }
      out.push(file);
      used += cost;
    }
  }
  const omitted = modified.length + read.length - kept.modified.length - kept.read.length;
  const heading = `## Files (modified, then read; newest first${omitted ? `; ${omitted} more: ${RECALL_TOOL} files` : ""})`;
  return [
    heading,
    ...(kept.modified.length ? [`Modified: ${kept.modified.join(SEPARATOR)}`] : []),
    ...(kept.read.length ? [`Read: ${kept.read.join(SEPARATOR)}`] : []),
  ];
}
