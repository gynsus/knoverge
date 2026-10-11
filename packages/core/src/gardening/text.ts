/**
 * The form two bodies are compared in before a rule calls them the same text.
 *
 * `normalise` in `git-store` already settles line endings, trailing spaces and
 * runs of blank lines, because those are a file-format question and the content
 * hash rests on them. This goes one step further and sets aside what typing the
 * same sentence a second time changes without changing what it says:
 * capitalisation, accents, and where the lines happened to break.
 *
 * Deliberately no further. Punctuation is content — "its" and "it's" are a
 * character apart and mean different things — and folding Markdown away would
 * make a heading and a sentence the same string. Two bodies that fold together
 * here are the same words in the same order, and nothing weaker than that is a
 * duplicate anybody can decide without reading both (ADR 0039 puts what two
 * nearly-identical items should *become* in the optional layer, because that is
 * a draft, and a draft is writing).
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(/\p{Mn}/gu, '')
    .toLowerCase()
    .replaceAll(/\s+/gu, ' ')
    .trim();
}
