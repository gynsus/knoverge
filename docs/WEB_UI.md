# Web interface

How the browser side is put together, and the rules a new screen follows. ADR
0013 records why Tailwind and shadcn/ui, and why the components are copied in
rather than installed; this is what to do with them.

The rules below are not style preferences. Each of them is written down because
breaking it produced a defect somebody had to find.

## 1. An object is made, changed and inspected in a drawer

A list is a page. The things in it are opened in a `Sheet` over that page.

The taxonomy and the workspace list both work this way: the list keeps the
screen, and choosing something opens a panel that says what it is, with the
actions for it. Creating and editing use the same sheet, because what an object
is does not depend on whether it exists yet.

A form that lives permanently below a list takes half the screen from the thing
the page is for, whether or not anybody is filling it in. That is what both of
these screens used to do.

What stays on a page: a list, a table, and anything a person scans rather than
fills in. Members are a page for that reason, not a drawer.

**Where this stands.** Taxonomy and workspaces are built this way. Agents,
policy and knowledge are not yet: each is still a list card, a detail card
below it and a permanent create form, which is the shape both converted screens
had. The rule is what a new screen follows and what those three are owed, not a
description of all seven.

## 2. A drawer somebody may want to link to lives in the address

`?new` opens the create drawer; `?edit=<id>` opens the edit drawer for one
object. A reload keeps it open, and the navigation elsewhere in the application
can point straight at it — the workspace switcher links to
`/workspaces?edit=<current>` rather than to a list somebody would have to find
their workspace in again.

Which object is merely being *looked at* is local state. It is a glance, not a
place, and putting it in the address means a back button that walks through
every card somebody opened.

## 3. A dialog is never turned off with a CSS class

A `Sheet` or `Dialog` hidden with `lg:hidden` is still open. Its overlay is a
separate element rendered through a portal the class never reaches, so it greys
out the page; its content stays in the document with the focus trap around it,
so a keyboard lands inside a panel nobody can see; and the page's scrolling
stays locked the whole time. Only the visible part is hidden, which is the one
part that was harmless.

Ask the viewport in JavaScript instead — `useBelow(breakpoint)` in
`hooks/use-mobile.ts` — and do not render the dialog as open.

## 4. A consequence goes on screen before the click, not after it

Moving a category rewrites the repository's directory layout and the scope of
every permission written against it. Merging one closes a name for good. Both
are `Dialog`s that say how many paths change and how many items travel, with
the destination chosen from a searchable list.

Neither is drag and drop. A gesture that can be made by accident is the wrong
way to ask for a change that large.

Archive is offered where delete would be, wherever the object holds something
somebody else put there.

## 5. What somebody may do comes from the server

`/v1/workspace.get` answers with a `permissions` array for the workspace
somebody is in, and `/v1/workspaces.list` answers with one per workspace they
belong to. Navigation entries and mutation controls are shown from that, never
from the membership role.

The list carries them because an interface offering actions for a workspace
somebody is not in has only the role to go on otherwise, and that is the second
copy of the policy this rule exists to prevent. Deriving
it from the role is a second copy of the policy engine that drifts from the
first: it shows a disabled form to a reviewer who was granted an action
explicitly, and offers a viewer forms whose every submission is refused.

## 6. Colour is a token, and a missing token is invisible

Every colour is a semantic token defined once in `index.css` and flipped for
dark mode there. There is no `dark:` variant anywhere and no class to toggle,
so a new component cannot forget the dark case.

Tailwind resolves `bg-popover` through `--color-popover` and, when that variable
is absent, emits no rule at all — the element renders transparent rather than
wrong, and nothing reports a problem. `scripts/check-theme-tokens.mjs` fails the
lint on a semantic colour the theme does not define. Generated shadcn components
arrive written against a fuller palette than this one, which is how the gap gets
in.

## 7. Every string goes through the catalogues

English is the source, Russian is the first translation, and
`scripts/check-locales.mjs` fails the lint when they disagree. Two shapes to
know:

- a key ending in `_one`, `_few`, `_many` or `_other` is read as a plural, so
  `pick_one` is not a key, it is `pick` with a plural category the other
  languages will be asked for;
- i18next pluralises on `count` and nothing else, so a message counting
  something else is one string with the numbers interpolated into it.

Relative times come from `Intl.RelativeTimeFormat`, so "12 минут назад" and "1
минуту назад" are both right without either being written down.

## 8. A control a keyboard cannot reach does not exist

A clickable card is a real `button` stretched over it with
`after:absolute after:inset-0`, not a `div` with an `onClick`: the second looks
identical to a pointer and is invisible to a keyboard and a screen reader. An
action that appears on hover is also shown on focus, because a keyboard has no
hover.

Placeholders are `aria-hidden` and the region around them says it is busy once,
so a screen reader hears "Loading" rather than eight grey rectangles. The
navigation is a real `nav` landmark. Decoration stops under
`prefers-reduced-motion`.

## 9. The loading state is the shape of the application

The first paint draws the real sidebar, header and footer with the rows inside
them blank. The chrome is the same for everybody, so it is real and nothing
moves when the content arrives; the rows are blank because their number and
their names depend on who is signing in and what they may do.

## 10. A test that has not been seen to fail proves nothing

Every test here asserts against a real defect, and the way to know it does is to
put the defect back and watch it fail. Two tests written during this work passed
against deliberately broken code before anybody checked.

Web tests render the whole `App` against a stubbed `fetch`, so a page is
exercised through the routes and the query cache it actually uses. Fixtures are
parsed with the contract schema in a test of their own, which is what catches a
contract that grew a field while a fixture did not.
