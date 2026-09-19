# Security policy

Knoverge stores knowledge that people and their agents rely on, and it records who changed what. A flaw that lets the wrong actor read, write or rewrite that record matters even when no data is lost.

## Reporting a vulnerability

Report privately, never in a public issue or pull request.

Use GitHub's private reporting form on the [Security tab](https://github.com/gynsus/knoverge/security/advisories/new). It is visible only to the maintainers, and it gives us a place to discuss a fix with you before anything is public.

Useful things to include, as far as you have them:

- what an attacker can do, and what they need to start with;
- the steps to reproduce it, or a short script;
- the version or commit you tested;
- whether you have told anyone else.

You do not need a working exploit. A clear description of the flaw is enough.

## What to expect

- an acknowledgement within a few days;
- an assessment of severity and scope, which we will share with you;
- a fix, or an explanation of why we believe the report is not a vulnerability;
- credit in the advisory, unless you prefer otherwise.

Knoverge is maintained by volunteers, so please allow reasonable time. We will tell you if a fix will take longer than expected rather than leaving you without an answer.

## Scope

In scope: this repository, its published container image, and the deployment configuration it ships.

Out of scope: an installation someone else runs, unless the flaw is in the software itself. Do not test against a server you do not own.

The following are known and documented, not vulnerabilities:

- an operator with shell access on the host controls the installation. The command line runs as the workspace system actor and is not subject to permission grants. This is stated in `docs/SECURITY.md`.
- the hash-chained event ledger detects tampering by anyone without the ledger key. It does not defend against someone who holds both the key and write access to the database. ADR 0007 says exactly what it does and does not prove.
- editing a workspace Git repository outside Knoverge is unsupported and is reported as an integrity error.

## Supported versions

Knoverge is before its first release. Security fixes land on `main`, which is the only supported version until a release is tagged.

## Threat model

`docs/SECURITY.md` in this repository is the design document: trust boundaries, the authorisation model, what the ledger guarantees, and the deployment assumptions. It is not a reporting address. Read it before reporting, so your report can say which assumption is broken.
