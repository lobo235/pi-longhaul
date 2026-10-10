/**
 * The two tools' names. Prefixed because pi keeps the FIRST registration of a tool name and drops the rest
 * without a word, and the pi ecosystem has many memory extensions that would want `remember` and `recall`: a
 * clash would send the model's writes to another extension while this state never sees them. The names are part
 * of the public contract, so they changed once, before the first public release.
 */
export const REMEMBER_TOOL = "longhaul_remember";
export const RECALL_TOOL = "longhaul_recall";

/** The names transcripts written before the rename carry, mapped to today's. */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = { remember: REMEMBER_TOOL, recall: RECALL_TOOL };
