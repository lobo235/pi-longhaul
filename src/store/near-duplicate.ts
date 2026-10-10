/**
 * Near-duplicate detection within a kind: a new item whose normalised-token overlap with a hot
 * item reaches the threshold is rejected, the earlier item stands.
 * Overlap is |a ∩ b| / min(|a|, |b|): a short restatement of a longer standing item is a duplicate.
 */
const STOP_WORDS = new Set(["a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "or", "is", "are", "be", "it", "this", "that", "with", "as", "by", "we", "i", "you", "do", "not"]);

export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.8;

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}

export function findNearDuplicate(text: string, candidates: Array<{ id: string; text: string }>, threshold: number): { id: string; overlap: number } | undefined {
  const tokens = tokenize(text);
  let best: { id: string; overlap: number } | undefined;
  for (const candidate of candidates) {
    const score = overlap(tokens, tokenize(candidate.text));
    if (score >= threshold && (!best || score > best.overlap)) best = { id: candidate.id, overlap: score };
  }
  return best;
}
