# ADR 0013: Tailwind CSS and shadcn/ui for the web interface

- Status: Accepted
- Date: 2026-09-20
- Amends: ADR 0006 (implementation stack)

## Context

The web interface was built on about 240 lines of hand-written CSS with colour
tokens. That was the right size for Milestone 1, and it is the wrong size for
what comes next: Milestone 2 adds the largest interface surface so far, a
knowledge editor with history, comparison and restore, and Milestone 3 adds the
review workflow.

Two problems were already visible. An audit found the primary action colour at
2.49:1 against its text in dark mode, where WCAG AA asks for 4.5:1, and no
focus style at all; both were fixed by hand, and both are the kind of thing a
component library gets right once rather than per component. And there was no
responsive layout: one media query in the whole stylesheet, for dark mode, with
member lists, agents, credentials, sessions and policy rules all in tables that
a phone can only scroll sideways.

Tailwind Plus, the commercial component set, was considered and ruled out. Its
terms do not allow redistributing the components so that others can use them,
and publishing the source in this repository is exactly that.

## Decision

**Tailwind CSS** (MIT) for styling and **shadcn/ui** (MIT) for components.

shadcn components are copied into the repository rather than installed as a
package. They become our code under our licence, they are reviewed like any
other code, and there is no dependency that can change what a button does in a
patch release. Their behaviour comes from Radix, which handles the keyboard,
focus and ARIA work that is easy to get wrong.

### Colour is semantic, and there is no `dark:` variant

Components ask for `bg-card` and `text-muted-foreground`. The tokens are
redefined under `prefers-color-scheme: dark`, so a new component cannot forget
to handle the dark case, and there is no class to toggle and keep in sync. The
values carry the contrast fixes: the text on the accent is dark in dark mode,
because white on it measured 2.49:1.

### A table is a table on a desktop and a list on a phone

`components/ui/table.tsx` renders one DOM either way. Below the medium
breakpoint the rows become blocks and each cell prints its own column heading
from `data-label`, so a screen reader and a search see the same content and a
phone reader is not left matching values to headings that scrolled away. The
explicit `role` attributes keep the table semantics that changing `display`
would otherwise discard.

Every cell therefore has to pass a `label`, and it comes from the message
catalogue like any other text a person reads.

### The native select stays

shadcn ships a Radix listbox, and it is right where a plain select cannot do
the job. For a short list of fixed values it is not: the platform control is
what a phone opens as a wheel, what a screen reader already knows, and what
keeps working when JavaScript does not.

## Consequences

- `apps/web/src/components/ui` is generated code in shadcn's shape, so
  `shadcn add` keeps working. Lint's fast-refresh rule is switched off there,
  because exporting a variant helper beside its component is that shape.
- Tailwind compiles to a static stylesheet, so the content security policy
  keeps `style-src 'self'` with no exception. A library that injected styles at
  runtime would have needed one, or a nonce.
- Fonts stay system fonts. Nothing is fetched from another origin, which rule
  12 requires and the policy enforces.
- Tailwind installs a native binary with a build step, so it is listed
  explicitly in the `.npmrc` allowlist.
- The message catalogue rules are unchanged, and the check that English and
  Russian hold the same keys still runs in lint.

## Alternatives considered

**React Aria Components** (Apache-2.0, the project's own licence) has the best
handling of touch, pointer and keyboard as one thing. It remains the better
answer if the interface grows past what Radix covers, and the two can live side
by side.

**Mantine** (MIT) is the most complete out of the box. It brings its own
theming system, which would sit on top of the tokens rather than use them.

**Flowbite** and **HeroUI** have the same shape of problem as Tailwind Plus:
the parts worth having are behind a licence this repository cannot satisfy.
