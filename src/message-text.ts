/** Reading pi's transcript shapes without trusting them: entries and content blocks arrive as untyped JSON. */
export type Rec = Record<string, unknown>;

export const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;

/** The text of a message's content: a plain string, or its text blocks joined by newlines; anything else is "". */
export const contentText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block) => (isRec(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n") : "";
