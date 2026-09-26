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

**Where this stands.** Every screen is built this way: taxonomy, workspaces,
agents, policy, knowledge and reconciliation. The list keeps the page; the
thing in it opens over the page.

**The one exception: a queue.** Review is not a list somebody browses, it is a
queue somebody works down. Every decision there is followed by the next one, so
a drawer costs an open and a close per proposal, and the queue disappears at
the moment a reviewer most wants to see how much is left. On a wide screen the
queue and the decision are side by side; below it there is no room for both and
the decision opens over the queue, as everything else does. Two columns on a
phone are two columns too narrow to read.

A screen may only choose this when the list is worked through rather than
looked at. If in doubt it is a drawer.

One copy of the panel, not two. `hidden lg:block` hides an element and leaves
it in the document, so a panel rendered in both places is two of every field,
two elements carrying the same id, and two effects fighting over the focus.
Which one exists is decided in JavaScript, with `useMediaQuery`.

## 2. A drawer somebody may want to link to lives in the address

`?new` opens the create drawer; `?edit=<id>` opens the edit drawer for one
object. A reload keeps it open, and the navigation elsewhere in the application
can point straight at it — the workspace switcher links to
`/workspaces?edit=<current>` rather than to a list somebody would have to find
their workspace in again.

Which object is merely being *looked at* is local state. It is a glance, not a
place, and putting it in the address means a back button that walks through
every card somebody opened.

The line between the two is whether somebody else may need to arrive at the
same thing. Looking at a workspace card to decide which workspace you want is a
glance. A proposal under review is not: it is work, somebody may have to be
sent it, and it opens from `?proposal=<id>`. When in doubt, ask whether you
would ever paste the link.

## 2a. A list that outgrows one screen narrows on the server

A filter applied in the browser filters the page that happens to be loaded,
which answers a different question than the one asked — and answers it
differently depending on how far somebody scrolled. Narrowing belongs where the
paging does.

The filters go in the address for the same reason drawers do: "the unreviewed
decisions in architecture" is a place, and somebody may need to be sent it.

## 2b. Reading an object is not editing it

A drawer opens in read mode. Editing is something somebody chose, from a
control that says so.

This matters more here than in most applications: every change to an item is a
revision and a Git commit, so a screen that opens with the fields already
editable is inviting a commit from somebody who came to read. The same drawer
holds both, and the destructive action is never in the row with Save — it lives
behind the menu, with what it does spelled out before it happens.

Leaving edit mode with unsaved changes asks first.

## 2c. Knowledge is rendered, and never becomes HTML

An item's body is Markdown, and it is written by agents as often as by people.
The renderer builds elements rather than an HTML string — no
`dangerouslySetInnerHTML` anywhere in the path — so raw HTML in a body is text
that says `<script>` rather than a script. Nothing is sanitised afterwards,
because nothing is parsed that would need it.

Links get `rel="noopener"` and a new tab, and a URL whose protocol is not a
safe one never reaches the document.

## 2d. A list of values is entered as a list

A comma-separated text box asks somebody to remember a syntax in order to type
two words, and it stopped being merely unpleasant when a tag became able to
contain a space (ADR 0019): the separator was then the only thing telling two
tags from one.

Values are entered one at a time and shown as chips with their own remove
button. Enter and comma both commit, Backspace on an empty box takes the last
one back, and what was typed and never committed is kept rather than thrown
away when the field loses focus. Where a set of likely values exists — category
paths — they are offered, and nothing outside the set is refused.

## 2e. Settings are a catalogue, split by whose they are

A screen that collects unrelated switches becomes one long canvas, and every
addition makes it worse. Settings are an index of sections, each with its own
address, split into what belongs to the person and what belongs to the
installation. A workspace's own settings are neither: they live with the
workspace.

A section that is planned and not built is shown, marked, and not a link.
Hiding it would let somebody looking for backups conclude they were in the
wrong place; a disabled button would invite a press that does nothing. It is
a card that says so.

## 2f. A connection is tested against what was typed, not what was saved

A form that can only test a connection after it has been stored teaches people
to store connections that do not work, and leaves a broken one configured while
they find out. The check takes the address from the field.

Saving is the last step, and it is a separate question from turning something
on. The wizard asks whether anything is there, then whether the chosen model
does the job, and only then writes anything — so abandoning it halfway leaves
the installation as it was.

What the far end said is shown in its own words. "Could not connect" is the
same sentence for the wrong port, the wrong machine and a firewall;
`ECONNREFUSED 192.168.1.7:11434` is the only thing that tells them apart.

## 2g. A thing is named once on the screen

A card titled "Change password" whose first child is a fieldset with the legend
"Change password" says the same words twice in a row, and the second one tells
the reader nothing the first did not. `FieldSet` is the group with no name of
its own, for the common case where the card or dialog above already names the
section; `FieldGroup` is for a group that genuinely needs a subheading.

Where a name is already on screen at some widths and not at others, the second
copy is hidden at exactly those widths and no further. A wizard's step
indicator shows its labels from `sm` up, so the matching legend is
`sm:sr-only`: drawn on a phone, where the indicator shows only numbers, and
silent above it. It is never removed outright — a fieldset named only on a
phone has no name on a laptop, and a screen reader is not a narrow screen.

The button that performs the action is not a repetition. "Change password" as a
card's title and on the button under the form is a heading and a verb, and the
reader needs both.

## 2h. A frame around a list of frames separates nothing

A card whose contents are already framed objects draws a line that carries no
meaning: the objects are separated from each other by their own borders, and
the outer one only makes the page look like a box inside a box. Where a section
holds framed objects — a list of providers, a grid of workspaces, a queue of
rules — its heading and intro are plain text on the page, and the objects carry
the frames.

A card is right where the card *is* the object. One of anything, or a block of
prose with nothing framed inside it, is a card.

A dashed border means "nothing here yet", and means it in both directions: an
empty list and a section that exists in the plan and not yet in the product get
the same treatment, because a reader is asking the same question of both.

## 2i. A queue says why each thing is in it

Review is a queue of decisions. Somebody arrives at it asking "should this
happen", and the screen's job is to answer the questions that decision rests
on before offering the controls that make it.

Every item says why it is waiting. A proposal is in the queue because policy
asked for review, or because it no longer applies cleanly, or because nobody
chose a category — and a reviewer who cannot tell which is deciding without the
one fact that frames the decision. The reason is read off the record rather
than stored as a sentence, so it cannot drift from what is true.

Read first, edit second. The panel opens showing what was proposed, what it
would change and where it came from; the form appears when somebody says they
want to change it before approving. A panel that opens as five input boxes has
answered "how do I edit this record", which is not the question a reviewer
arrived with.

Provenance is stated even when there is none. "No sources given" is a finding
about an agent's proposal; a section that is simply absent is not.

A count at the top of a pile is also the filter for it. Seeing that three of
twelve are conflicts, and being able to say "those three", is the difference
between a queue and a list.

An irreversible decision is never one keypress. Keyboard shortcuts move
through the queue and open things; rejecting opens the dialog that asks why,
because "rejected, no reason given" teaches an agent nothing.

## 2j. A key never does something that cannot be undone

Keyboard shortcuts are worth having on a screen somebody works down. What they
may do is move, open and start a form; what they may not do is save, approve or
delete. A single key that writes is a single key somebody presses while
reading, and a ledger is the wrong place to find out.

Where a key opens something that takes the focus, the key-down that opened it
is prevented, or the key-up lands on whatever the focus moved to. Enter opening
a drawer and instantly shutting it again is that bug.

A shortcut nobody is told about is a shortcut nobody uses, so the list of them
is on the screen behind a control, not only in a document.

## 2k. An address somebody could open is a link, and only if it is safe to be one

Where a screen shows something a browser can fetch — a source, a document, a
page — it is a link. A citation nobody can follow is a citation that has to be
selected, copied and pasted to be worth anything, and the whole point of
recording where knowledge came from is that somebody can go and read it.

`http` and `https` and nothing else. These addresses are written by agents, and
a `javascript:` or `data:` href is a script somebody else wrote running on this
page — the same reason knowledge is rendered and never becomes HTML. Anything
that is not one of the two stays text, which is still readable and still
copyable: a repository path and a ticket number are not less useful for failing
to be links, they were never links.

`target="_blank"` always comes with `rel="noopener noreferrer nofollow"`.
Without `noopener` the page that opens gets a handle on this one and can
navigate it; `nofollow` because a knowledge base is not a place to lend
authority from.

Leaving the application is said, not only drawn. An icon announces it to people
who can see it, and the text beside it announces it to everybody else.

## 2l. A state a row asserts is a state the drawer can explain

A badge is a claim about an item, so opening the item has to say what the claim
rests on. "Disputed" with nothing beside it tells a reader that somewhere in the
workspace something disagrees with what they are reading, and leaves them to
find it.

Where the reason lives on another object, it is fetched and named. A
contradiction is recorded on the item that reported it, so the item it was
reported against has nothing of its own to show — its drawer names the other
items, by title, as things to open. The same rule already governs sources:
provenance is stated even when there is none, because "no sources given" is a
finding and an absent section is not.

This is what keeps a flag from becoming decoration. A field the product carries
everywhere and never explains is one somebody learns to ignore, and then it may
as well not be there.

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
