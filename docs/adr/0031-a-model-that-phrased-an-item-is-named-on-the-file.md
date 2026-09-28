# 31. A model that phrased an item is named on the file

Date: 2026-09-27

Status: accepted

## Context

`knowledge.draft_summary` sends a model the items a summary is being made from and
returns text for a person to read. Nothing is written by that call: the person saves
it through the ordinary create or update, which is where provenance, review and Git
already live (ADR 0021 and rule 9).

So the model's part disappeared. The browser says "Drafted by llama3.1" while the
draft is on screen, and the saved revision says nothing. ADR 0028 named this while
removing `summary.generated` from the event types — that event never recorded it
either, because it was never written — and left it open.

Three places it could go, and two of them are wrong.

**The event's `model`.** Every event carries the client and model of the request that
caused it. For a browser save the request was made by a person, and writing the
drafting model there would say the model made the write. It did not: a person read
the text and chose to keep it.

**A source.** Sources are what a claim rests on, and `evidenceFrom` counts them to
decide whether an item is source-backed. A model is not evidence of anything; adding
one as a source would make a summary look better attested for having been phrased by
a machine.

**The frontmatter.** The file is canonical and has to be readable without the
application (rule 1). "A model produced this text" is a property of the text, so a
reader of the file is exactly who needs to know it.

## Decision

`drafted_by` on the frontmatter, holding the model's own name, and therefore on the
revision — the revision stores the frontmatter it wrote, so nothing else has to
carry it.

A create or an update may set it. It says a model produced the text this revision
saved; the person who saved it read it first, which is what the review state already
records.

**It survives a write that does not touch the body, and is cleared by one that
does.** Changing a tag does not make a drafted summary hand-written, and rewriting the
body does: a field that said "drafted by" over text a person typed would be worse than
no field. A write that changes the body and means to keep it says so by passing it
again.

What it does not claim is how much of the text survived the reading. A person who
edited three words and a person who edited thirty leave the same field, and the
alternative — a similarity threshold deciding whether a draft is still a draft — would
be a guess with a number on it.

## Consequences

An item read out of the repository with no application anywhere says whether a model
phrased it. `knowledge_get` answers it, the item's drawer shows it, and the browser
sends it for a summary it drafted, which is the one place in the product where a model
writes text a person then keeps.

The claim that this is the only place a model writes text a person keeps stopped
being true in Milestone 12: a description of a picture and a transcript of a
recording carry the same field and are written without being read first. ADR 0032
records that.

It is not a review state and does not weaken one: `human_reviewed` and `drafted_by`
together are the ordinary case for a drafted summary, and they say different things —
who checked it, and what produced the first version of it.

The field is per revision, so the history says when the text stopped being a model's
and became somebody's own.
