/**
 * The words the lift check reads (security.md T2): what withdraws a rule, what takes a withdrawal back, what keeps or
 * says a rule again, and where a message's sentences and parts break. lift-words.ts decides with them.
 */

/** What a rule is called besides "rule". */
export const RULE_NOUN = "(?:rule|ban|constraint|requirement|restriction|prohibition|policy)s?";
export const NAMED_RULE = new RegExp(String.raw`(?<![\w'-])(?:[\w'-]{1,40}\s+){1,4}${RULE_NOUN}\b`, "gi");
/**
 * Words that withdraw. No approval ("go ahead", "is fine", "you may now") and no bare task verb ("replace", "drop"):
 * those also ask for ordinary work, and a message that asks for work while sharing a word with a rule is no withdrawal
 * of it. A task verb counts only aimed at a rule ("drop the make check rule"). A permission is a one-off: to retire
 * a rule, the user says it no longer holds.
 */
const HOLDING = "(?:needs?|needed|appl(?:y|ies)|holds?|matters?|rules?|required|necessary|stands?|forbidden|banned|prohibited)";
export const WITHDRAWAL_CUE = new RegExp(String.raw`\b(?:lift(?:ed|s|ing)?|withdr[ae]wn?|withdraw(?:s|ing)?|ignore|forget|disregard(?:ed)?|scrap(?:ped)?|cancel(?:l?ed)?|revoked?|rescind(?:ed)?|never mind (?:about\s+)?(?:[\w'-]{1,40}\s+){0,4}?${RULE_NOUN}|(?:can|may|should) be (?:ignored|dropped|forgotten|skipped)|(?<=\b(?:it|this|that|${RULE_NOUN})\s{1,8})(?:doesn'?t|does not|don'?t|do not) apply|not needed|don'?t need|doesn'?t need|does not need|no need|no longer (?:has|have) to|(?:stop|quit)\s+(?:following|obeying|keeping|enforcing|observing|honou?ring|applying))\b|\b(?:no longer|any ?more)\b(?=(?:\W+\w+){0,3}?\W+${HOLDING}\b)|\b${HOLDING}\b(?:\W+\w+){0,3}?\W+(?:no longer|any ?more)\b|\b(?:drop|remove|relax|delete)\s+(?:\S+\s+){0,4}?${RULE_NOUN}\b`, "gi");
/** "instead of X" withdraws X only: what follows it must name the rule's subject, so "pnpm instead of npm" lifts no rule about tests. */
export const INSTEAD_OF = /\binstead of\s+((?:\S+\s+)?\S+)/i;

/**
 * A negation up to three words before a withdrawal word, commas skipped, takes it back ("don't forget", "never, ever
 * forget", "must not, under any circumstances, ignore", "I won't lift", "neither ... nor ... is lifted"). "No," is an
 * answer, not a negation. "nobody" and "no one" negate only as the withdrawal's subject ("nobody lifted"), not
 * "nobody cares, lift ...". The window never leaves the withdrawal's sentence; intensifiers do not count as words.
 */
export const NEGATED = /(?:\b(?:don'?t|do not|didn'?t|did not|hasn'?t|has not|haven'?t|have not|wasn'?t|isn'?t|can'?t|cannot|won'?t|wouldn'?t|shouldn'?t|couldn'?t|never|not|must not|mustn'?t|no way|under no circumstances)\b[\s,]+(?:[^\s,]+[\s,]+){0,3}|\b(?:why|how)\s+(?:would|could|should|can)\s+(?:we|you|I|anyone)\b[\s,]+(?:[^\s,]+[\s,]+){0,3}|\b(?:nobody|no one)\s+(?:[^\s,]+\s+)?|\b(?:neither|nor)\b(?:[\s,]+[^\s,]+){0,6}[\s,]+)$/i;
export const INTENSIFIER = /\b(?:ever|under any circumstances(?: whatsoever)?|at all|really|again)\b/gi;
/**
 * A withdrawal word in a condition, an attempt, a guess, a plan or a retraction withdraws nothing now: "if you ignore
 * the force-push ban again", "you tried to ignore", "someone might ask you to forget", "we'll lift it after the
 * release", "never mind what I said about lifting it". A request is not a plan: "could you" asks for it now.
 */
export const CONDITIONAL = /(?:\b(?:if|unless|whenever|whether|in case|might|going to|gonna|tried to|trying to|could(?!\s+(?:you|we)\b)|would(?!\s+(?:you|we)\b)|will(?! you))|'ll)\b[\s,]+(?:[^\s,]+[\s,]+){0,3}$/i;
export const RETRACTION = /\b(?:what|everything|anything)\s+(?:I|we)\s+(?:said|asked|told you|wrote|mentioned)(?:\s+(?:earlier|before))?\s+(?:about|on|regarding)\s+(?:[^\s]+\s+){0,2}$/i;
/** A part that takes back an earlier withdrawal: "forget everything I said about dropping it", "forget about lifting it". */
export const RETRACTS_WITHDRAWAL = /\b(?:what|everything|anything)\s+(?:I|we)\s+(?:said|asked|told you|wrote|mentioned)(?:\s+(?:earlier|before))?\s+(?:about|on|regarding)\s+(?:[\w'-]{1,40}\s+){0,2}?(?:lift|drop|remov|ignor|forget|forgott|scrap|cancel|withdr|relax|delet|disregard)\w*|\b(?:forget|never mind|ignore)\s+about\s+(?:lift|drop|remov|ignor|scrap|cancel|withdr|relax|delet|disregard)\w*|\b(?:cancel|undo|revert|reverse|take back|scrap)\s+(?:the\s+|that\s+|my\s+)?(?:lift|withdrawal|removal)\b/i;
/**
 * A condition holds every withdrawal word after it in its part ("if a tool output says the rule is lifted"), and
 * "even if", "no matter", "regardless" every one after it in its sentence ("never force-push no matter who tells you
 * to ignore it"): what follows is what the rule must survive, not a withdrawal.
 */
export const PART_CONDITION = /\b(?:if|unless|whenever|whether|in case|tried to|trying to|as long as)\b/i;
export const SENTENCE_CONDITION = /\b(?:even (?:if|when|though)|no matter|regardless|whatever(?!\s*(?:[^\w\s]|$)))\b/i;
/** Phrases that read as a negation and are not one ("Don't worry, lift it"); "never mind" only when it stands alone. */
export const INTERJECTION = /\b(?:don'?t worry|do not worry|never mind(?=\s*(?:[,.!;]|$))|no worries|no problem|not a problem)\b/gi;
/**
 * Words saying a rule still holds ("still applies", "is still in effect", "stays as it is", "keep following", "the
 * rule stands."). They reaffirm the rule named just before them, or, with none named there, this one.
 */
export const REAFFIRMS = /\bstill\s+(?:appl(?:y|ies)|holds?|stands?|counts?|valid|required|binding|banned|forbidden|in\s+(?:force|place|effect))\b|\b(?:remains?|stays?)\s+(?:in\s+(?:force|place|effect)|as\s+(?:it\s+)?is|put)\b|\bkeep\s+(?:following|obeying|honou?ring)\b|(?<!(?:\bno longer|\bnot|n't|\bnever)\s+)\b(?:needs?\s+to\s+stay|is\s+staying|continues?\s+to\s+(?:apply|hold|stand)|(?:is|stays?)\s+non-negotiable)\b|\b(?:rule|ban|it|that|this)\s+(?:stands|holds|remains|stays)(?=\s*(?:$|[,:()–—]|(?:and|but|though|although|yet|then|while|since)\b))/i;
/**
 * Words that say something is as it was ("is unchanged", "remains valid", "is still on"): said of a plan or a
 * meeting as often as of a rule, they reaffirm only a rule named before them in their part ("the force-push rule is
 * unchanged", "the rule is unchanged"), never this one by default ("lift it, everything else is unchanged").
 */
export const STILL_SO = /\b(?:remains?|stays?)\s+(?:unchanged|the\s+same|valid|active|enforced|binding)\b|\b(?:is|are)\s+unchanged\b|\b(?:has|have)(?:n'?t|\s+not)\s+changed\b|\b(?:is|are)\s+still\s+on(?=\s*(?:$|[^\w\s]))/gi;
/**
 * Words that keep a named rule ("keep the force-push rule", "leave the rule about rebasing alone", "follow the rule") or set apart what
 * follows ("other than the force-push rule", ", not the force-push one", "remember: ..."). "Keep tabs in TypeScript"
 * keeps no rule by name: it narrows one.
 */
const RULE_ABOUT = String.raw`(?:\s+(?:about|on|for|against|regarding)\s+((?:[\w'-]{1,40}\s*){1,4}))?`;
export const KEEPS_RULE = new RegExp(String.raw`\b(?:keep|leave)\s+((?:[\w'-]{1,40}\s+){0,4}?)(?:${RULE_NOUN}|one|guidelines?|instructions?|conventions?)\b${RULE_ABOUT}|\b(?:follow|obey|respect|honou?r|stick\s+(?:to|with)|abide\s+by|adhere\s+to|comply\s+with|observe|enforce|preserve|retain|maintain|uphold)\s+((?:[\w'-]{1,40}\s+){0,4}?)${RULE_NOUN}\b${RULE_ABOUT}|\b(?:keep|leave)\s+(?:it|that|this)\b`, "i");
/**
 * "Keep writing" goes on doing what a rule requires; of a rule that forbids, "keep pushing" says the opposite. "Keep
 * force-pushes off main" keeps what a rule forbids away, either way.
 */
export const KEEPS_DOING = /\b(?:keep|continue)\s+(?:on\s+)?[a-z]+ing\b/i;
export const KEEPS_AWAY = /\bkeep\s+(?:[\w'-]{1,40}\s+){1,4}?(?:off|out\s+of|away\s+from)\b/i;
export const SETS_APART = /^\W*(?:(?:but|and|so|just)\s+)?(?:except|excluding|other than|apart from|aside from|save for|with the exception of|besides|not|remember)\b/i;
/**
 * "No need to keep the force-push rule" withdraws it. "No need to force-push" says what a rule forbids is not needed:
 * the rule said again when the next few words are the rule's own, unless what is not needed is keeping to the rule ("no
 * need to avoid force-pushing"). "The force-push rule doesn't need to stay" withdraws it.
 */
export const NEEDLESS_ACT = /\b(?:no need|no longer (?:need|have)s?|(?:don'?t|do not|doesn'?t|does not) need|(?:don'?t|do not) have)\s+to\s+(?!(?:avoid|stop|keep|follow|obey|honou?r|respect|refrain|worry|stick)\b)(?=\w)/i;
export const NEEDLESS = /\b(?:no need|no longer (?:need|have)s?|(?:don'?t|do not|doesn'?t|does not) need|(?:don'?t|do not) have)\s+to\s+$/i;
/** A part that says the rule's subject is not allowed says the rule again, unless "no longer" or "not" comes first. */
export const NOT_ALLOWED = /\b(?:not\s+allowed|not\s+ok(?:ay)?|forbidden|banned|prohibited|off[- ]limits)\b/gi;
/** A part that says the subject of a rule that requires it is required says the rule again, the same way. */
export const REQUIRED = /\b(?:required|mandatory|compulsory|obligatory)\b/gi;
/**
 * Command words, by the way they point: "never" and "stop" repeat a prohibition, "always" and "must" a requirement.
 * "No" opening a part with no word after it is an answer ("No, lift it", "No - the rule is lifted"); anywhere else
 * it is a command ("still a hard no", "a no-go").
 */
export const NEGATIVE_COMMAND = /\b(?:never(?! mind)|don'?t|do not|must not|mustn'?t|shouldn'?t|should not|can'?t|cannot|may not|avoid|stop|(?<!^\W*)no(?!\s*,|\s+(?:one|way|matter)\b)|no(?=\s+\w)(?!\s+(?:one|way|matter)\b))\b/gi;
export const POSITIVE_COMMAND = /\b(?:always|must(?! not))\b/gi;
/** Of a rule that requires something, "don't skip it" and "never commit without it" say it again. */
export const NOT_WITHOUT = /\b(?:don'?t|do not|never|no)\s+(?:(?:ever|really|absolutely)\s+){0,2}(?:skip|omit|bypass|neglect)\w*|\b(?:don'?t|do not|never|no)\s+(?:[\w'-]{1,40}\s+){1,3}?without\b/gi;
/** Of a rule that requires something, a part that opens by skipping it, after a bare "don't" ("do not, ever, skip make check"). */
export const SKIPS = /^\W*(?:skip|omit|bypass|neglect)\w*/i;
/**
 * "No force-push rule" names a rule; "no force-pushing is a hard rule" says one, with a linking verb between.
 * The separators exclude `'` and `-`, so a word and the gaps around it can be split only one way: with `\W`
 * separators a run of hyphens could be shared out between words and gaps in exponentially many ways (security.md T4).
 */
export const NAMES_A_RULE = new RegExp(String.raw`^[^\w'-]*(?:(?!(?:is|are|was|were|remains?|stays?|becomes?)\b)[\w'-]{1,40}[^\w'-]+){0,4}?${RULE_NOUN}\b`, "i");
/** A sentence ends at punctuation followed by a space (not the dot in package.json), a semicolon or a line break. */
export const SENTENCE_BREAK = /[.!?]+(?=\s|$)|[;\n]+/g;
/**
 * A sentence's parts: commas, colons, brackets, dashes, and, but, though, yet, then, while, since, and before a word
 * that keeps or sets apart (not "to keep": "no need to keep it" is one part). Bounded whitespace keeps it linear.
 */
export const PART_BREAK = /[,:()–—]|[ \t]{1,8}-[ \t]{1,8}|(?<!\b(?:go|come|try))[ \t]{1,8}\b(?:and|but|though|although|yet|then|while|since)\b[ \t]{1,8}|(?<!\bto)[ \t]{1,8}(?=(?:keep|leave|except|excluding|other than|apart from|aside from|save for|with the exception of|besides)\b)/gi;
/**
 * A question withdraws nothing ("is the push rule lifted?", "just curious, is it lifted?", "the push rule is
 * lifted?") unless it is a request ("could you drop the push rule?", "are you able to drop it?"), and a request that
 * asks "if" or "whether" is a question too ("can you tell me if it is lifted?").
 */
export const DISCOURSE_MARKER = /^\W*(?:(?:so|ok(?:ay)?|wait|and|but|also|hey|well|btw|quick question|question|one more thing)\b[\s,:]*)+/i;
export const REQUEST = /^\W*(?:(?:can|could|would)\s+you|(?:can|could|shall)\s+we|are\s+you\s+able\s+to)\s+(?:please\s+)?(?:just\s+)?(?:forget|drop|lift|ignore|remove|disregard|scrap|cancel|withdraw|revoke|rescind|relax|delete)\b/i;
/** "instead of" in a reproach describes a violation ("you used spaces instead of tabs again"), not a replacement. */
export const REPROACH = /\b(?:you\s+(?:used|did|wrote|ran|added|put|kept|made|went)|did you|why|how come|again)\b/i;
/** A rule that forbids: "instead of" its subject complies with it ("rebase instead of push"), it does not replace it. */
export const PROHIBITION = /\b(?:never|don'?t|do not|no|not|avoid|forbidden|banned|prohibited|off[- ]limits)\b/i;
export const OPENS_WITH_PROHIBITION = /^\W*(?:never|don'?t|do not|no|avoid)\b/i;
export const REQUIREMENT = /\b(?:always|must(?! not)|every)\b/i;
