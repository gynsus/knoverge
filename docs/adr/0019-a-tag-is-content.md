# ADR 0019: A tag is content

- Status: Accepted
- Date: 2026-09-23

## Context

`Tag` was defined as `CategorySlug`: one to sixty-four characters of lower-case Latin letters, digits and hyphens. The comment gave the reason — "the same shape as a slug, because it appears in paths and queries".

Neither half of that is true. A file path is `knowledge/<category-path>/<item-slug>.md`; no tag appears in it. A query string carries percent-encoded UTF-8 and always has.

What the rule did do was refuse `тег`. A Russian knowledge item — which the language rules explicitly allow, and which carries a `language` field saying so — could not carry Russian tags. This was found by seeding a workspace through MCP: six items written in Russian were refused, with an error that restated the regular expression and explained nothing.

So the question was never about paths. It is what a tag *is*: an identifier the system uses, or content a person wrote.

The comparison that settles it is the category. A category has a `name` a person reads, a `slug` the filesystem uses, and aliases for the names people try instead. The two jobs are separated because they are different jobs. A tag has no such split: the tag is its own label, shown exactly as written, and nothing derives a path or an identifier from it.

## Decision

**A tag is content. Any script, stored as written, matched case- and composition-insensitively.**

`Tag` validates and does not rewrite. It accepts one to sixty-four characters of any script, including spaces inside, and refuses two things:

- **control characters**, because they are invisible in every interface that would show the tag;
- **commas**, because the frontmatter, the query string and the tag input all separate tags with one, and a tag that cannot survive its own separator cannot be round-tripped.

Two tags are the same tag when their normalised forms agree: Unicode NFC, runs of whitespace collapsed to one space, trimmed, case folded. NFC is the part that is easy to forget — a Cyrillic "й" is one code point on one keyboard and "и" plus a combining breve on another, identical on screen and unequal as strings.

The stored `tags` table already had the right shape for this: `name` as written, `normalised_name` unique per workspace. Only the rule changed, and it moved to `packages/contracts` so the API, the domain, the repository and the interface all decide sameness the same way. It used to live in the database package as a local `trim().toLowerCase()`, whose comment claimed it folded spaces and did not — which never showed, because a slug could not contain one.

**The schema validates and never transforms.** Response schemas are also what responses are serialised with, and a Zod transform runs in one direction only: normalising inside the schema made every response carrying a tag fail to encode, with `ZodEncodeError` and a 500. Canonicalising is the domain's job, in `KnowledgeService`, where duplicate tags are already collapsed.

## Consequences

- A Russian item carries Russian tags, a Japanese item carries Japanese ones, and the file in Git shows them as written.
- `machine learning` is one tag, not two words that had to be hyphenated to be legal.
- The first spelling wins the display form. Somebody who writes `PostgreSQL` after somebody wrote `postgresql` joins the existing tag rather than creating a second one; the workspace keeps the first spelling. That is arbitrary but it has to be somebody, and the alternative — last writer renames the tag for everyone — is worse.
- Tags no longer sort in ASCII order. They sort by locale collation, which is what a person reading the list expects.
- No migration. Every tag that existed under the old rule is already canonical and normalises to itself.
- A tag can now contain a space, so anything that joins tags into a single string needs a separator that is not a space. The interface's comma-separated input still works; a chip input would be better and is a separate change.

## Alternatives considered

**Keep tags as slugs and transliterate on input.** Consistent with the item slug, which already transliterates a title. Rejected because transliteration is lossy and one-way: `машинное-обучение` is not a tag anybody would choose to read, and the person who typed the original never sees it again.

**Allow any script but fold to lower case for storage as well.** Simpler — one form instead of two. Rejected because a tag is shown, and `postgresql` is not how anybody writes it.

**Allow commas and escape them at each boundary.** Correct in principle. Rejected as three escaping schemes — YAML, query string, and the input — for a character nobody needs in a tag.
