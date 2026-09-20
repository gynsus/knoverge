import { describe, expect, it } from 'vitest';

import { parseItem } from '../src/index.ts';

const HEAD = `---
id: kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3
title: T
type: fact
status: active
language: en
review: unreviewed
evidence: none
disputed: false
created_at: 2026-09-19T09:00:00Z
updated_at: 2026-09-19T09:00:00Z
`;

describe('a file the parser did not write', () => {
  it('refuses a duplicate key rather than silently picking one', () => {
    expect(() => parseItem(`${HEAD}title: Other\n---\n\nBody.\n`)).toThrow();
  });

  it('does not expand an alias bomb hidden under a key it accepts', () => {
    // The obvious version is refused because a, b and c are unknown keys. This
    // one hides the expansion under `tags`, which the schema does accept, so
    // the refusal has to come from the YAML reader rather than from validation.
    const bomb = `---
tags: &a ["x","x","x","x","x","x","x","x","x"]
id: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
title: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
type: [*c,*c,*c,*c,*c,*c,*c,*c,*c]
---

Body.
`;
    const started = Date.now();
    expect(() => parseItem(bomb)).toThrow();
    // Refused, and refused quickly: an expansion that ran to completion would
    // be the denial of service, whatever the verdict afterwards.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a frontmatter block that is absurdly large', () => {
    // The body may be long; the metadata has no reason to be, and it is the
    // part parsed into structures before anything validates it.
    const padded = `${HEAD}tags:\n${'  - x\n'.repeat(20_000)}---\n\nBody.\n`;
    expect(() => parseItem(padded)).toThrow(/larger than/);
  });

  it('keeps a horizontal rule in the body as body', () => {
    const item = parseItem(`${HEAD}---\n\nBefore.\n\n---\n\nAfter.\n`);
    expect(item.body).toContain('Before.');
    expect(item.body).toContain('After.');
  });
});
