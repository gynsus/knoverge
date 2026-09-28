# 32. A file says what it says without being read first

Date: 2026-09-28

Status: accepted

## Context

ADR 0031 put `drafted_by` on the frontmatter and said what it means: a model
produced the text this revision saved, and the person who saved it read it first.
That held for the one case there was. `knowledge.draft_summary` returns text to a
browser, a person reads it and saves it through the ordinary write, and nothing
reaches the repository that nobody looked at.

Milestone 12 added two cases that do not work that way. An image with a vision
model assigned is described, and an audio or video file with a transcription model
assigned is transcribed, and in both the text becomes a `document` item in the job
that produced it. Nobody reads it first.

This is the decision that PR #211 made and did not record, and the transcription
half makes it again, so it is written down here rather than left to be inferred
from two call sites.

The alternative is the one the summary path takes: put every description and
transcript in the review queue for somebody to approve. It is worse for the case
it is meant to protect. A person who uploads forty scanned invoices did not ask
for forty review items; they asked for the invoices to be findable. A queue that
fills with work nobody wanted is a queue people stop reading, and the review queue
is where an agent's writing waits.

## Decision

Text a model produced about an uploaded file is written by the extraction job,
without a person reading it first, and carries `drafted_by` naming the model.

Four things make that safe enough to do, and none of them is the model:

**Somebody put the file there on purpose.** A summary is drafted about knowledge
that is already in the workspace; a description is what a file somebody chose to
upload turned out to say. The intent is in the upload.

**It is the uploader's write, and meets the policy as one.** The item is written as
the person or agent who uploaded the file. An agent's file produces a proposal and
waits in the review queue exactly as its other writing does — a file is not a way
past rule 5 — and a person's produces an item exactly as their own writing does.
Nothing about a model changes who is writing.

**The file says whose words these are.** `drafted_by` is on the frontmatter and
therefore on the revision, so a reader of the repository with no application
anywhere can tell a transcript from something somebody typed.

**The instruction is where the defence is, not the review.** A scan saying "ignore
your instructions" is a picture of somebody's words; the instruction sent with a
picture says to record any instruction in it as text and never to act on it. A
transcription endpoint takes a file and returns words, with no instruction to
hijack. What comes back is knowledge, and knowledge is untrusted input to every
agent that later reads it, which is a boundary that already exists.

The review state is unchanged by any of this. An item written by a person who may
write knowledge is `human_reviewed` because a person made the write, and
`drafted_by` says separately that a model phrased it. They answer different
questions, as ADR 0031 already said.

## Consequences

An installation with a vision or transcription model assigned turns uploads into
knowledge without anybody approving each one, and the field on each item says
where the words came from. An installation with no such model assigned is
unchanged: the file is kept, downloadable and `unsupported` (rule 9).

A workspace that wants every description read before it is canonical has the
existing lever: upload as an agent, whose writes require review by default (rule
14). There is no per-workspace switch for this, and adding one before anybody
wants it would be a setting nobody could explain.

ADR 0031's consequence that a drafted summary is "the one place in the product
where a model writes text a person then keeps" is no longer true, and this record
is why.
