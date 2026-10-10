/**
 * Text that renders as one line: control characters (C0, DEL, C1) and whitespace runs collapse to one space, so a
 * value cannot add a line, a heading or an escape sequence to what it is rendered into (security.md T1).
 */
export const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
