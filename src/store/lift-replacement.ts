/**
 * A replacement's own words (verify.ts): what a rule that replaced others set beyond them, so a lift of it is judged
 * on those words and not through a name it shares with a rule it replaced. Split from lift-words.ts, whose matching
 * (stems, sentences, parts, liftNamesRule) it reads.
 */
import { ENDING, JUDGED_CHARS, liftNamesRule, sentencesOf, stemsOf, wordsOf, type Part } from "./lift-words.ts";

/**
 * What a replacement set beyond the rules it replaced: the parts of its message that name none of them, or "" when
 * every part is about them (a narrowing). A replacement is quoted whole, so it names the rule it lifted too, and a
 * repeated lift of that rule would pass the check against it: a lift of a replacement is judged on these parts as well.
 */
export function ownRuleOf(replacementText: string, replacedRules: readonly string[]): string {
  const parts = sentencesOf(replacementText.slice(0, JUDGED_CHARS).replace(/[ \t]+/g, " ")).flatMap((sentence) => sentence.parts);
  const abouts = replacedRules.map((rule) => aboutRule(parts, rule));
  return parts.filter((part) => part.stems.size > 0 && !abouts.some((about) => about(part))).map((part) => part.text.trim()).join("; ");
}

/**
 * A replacement's own words as a lift of it is judged on them: without the words of the rules it replaced, so a part
 * the splitter could not split ("now that the tab rule is lifted you must never force-push") is not named by a
 * repeated lift of the old rule through that rule's own name.
 */
export function withoutReplacedWords(own: string, replacedRules: readonly string[]): string {
  // By the 5-letter stems liftNamesRule matches with, so no word it could name the old rule through survives
  // ("checkout" goes beside "check"): masking more only refuses, since the own words must be named both ways.
  const replaced = new Set(replacedRules.flatMap((rule) => wordsOf(rule).flatMap(stemsOf)));
  return own.replace(/[A-Za-z0-9]+/g, (word) => (word.length >= 3 && stemsOf(word.toLowerCase()).some((stem) => replaced.has(stem)) ? "" : word)).replace(/[ \t]{2,}/g, " ");
}

/**
 * The forms a word may have without its inflection, uncut: "merging" -> merg, merge; "committing" -> committ, commit;
 * "tabs" -> tab; "paste" -> paste only. Two words are the same when their forms meet; "checkout" stays apart from "check" and "confirm"
 * from "config", which only a 5-letter prefix merged.
 */
function lemmasOf(word: string): string[] {
  const ending = ENDING.exec(word);
  if (ending === null || ending.index < 3) return [word];
  const base = word.slice(0, ending.index);
  // Only where -ing, -ed or -es came off: "past" is not "paste", nor "plan" "plane".
  if (ending[0] === "s") return [base];
  const undoubled = /([b-df-hj-np-tv-z])\1$/.test(base) ? base.slice(0, -1) : base;
  return [...new Set([base, `${base}e`, undoubled])];
}
const sameWord = (a: readonly string[], b: readonly string[]) => a.some((lemma) => b.includes(lemma));
/**
 * A remark that scopes what is kept of a rule by pointing back at it: the pronoun is the verb's object ("keep it for
 * the package itself", "leave them alone", "keep that for src/", "except for it in tests"). "Keep secrets out of this
 * repo" points nowhere: "this" there belongs to a noun.
 */
const SCOPES_BACK = /^\W*(?:(?:keep|leave)\s+(?:it|them)\b|(?:keep|leave)\s+(?:this|that|those|these)\s*(?:$|\b(?:for|in|on|to|under|where|when|as|unchanged|alone)\b)|(?:except|excluding|other than|apart from|aside from|save for|besides)\s+(?:for\s+)?(?:it|them|this|that|those|these)\b)/i;

/**
 * Which parts of a replacement are about a rule it replaced: a part that withdraws that rule, one that carries every
 * word the withdrawal named it by ("keep tabs in the TypeScript files" after "the tab rule doesn't apply to the JSON
 * files", both naming "tab" and "file"), or one that scopes what is kept of it by
 * pointing back. A word the two merely share ("main", "push", a first verb like "write") or a shared 5-letter prefix
 * ("checkout" and "check") is not enough: a part that is not about the old rule is a rule of the replacement's own.
 */
function aboutRule(parts: readonly Part[], ruleText: string): (part: Part) => boolean {
  const ruleWords = wordsOf(ruleText).map(lemmasOf);
  const withdrawing = new Set(parts.filter((part) => liftNamesRule(part.text, ruleText)));
  // Each word of the old rule the withdrawal named it by, once: "the committing-to-main rule" names commit and main.
  const naming = ruleWords.filter((ruleWord) => [...withdrawing].some((part) => wordsOf(part.text).some((word) => sameWord(lemmasOf(word), ruleWord))));
  const carriesName = (part: Part) => { const words = wordsOf(part.text).map(lemmasOf); return naming.length > 0 && naming.every((ruleWord) => words.some((word) => sameWord(word, ruleWord))); };
  return (part) => withdrawing.has(part) || SCOPES_BACK.test(part.text) || carriesName(part);
}
