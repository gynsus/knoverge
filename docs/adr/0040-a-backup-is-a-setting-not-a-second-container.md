# 40. A backup is a setting, not a second container

Date: 2026-10-09

Status: accepted

## Context

Backups exist and almost nobody gets them. The `backup` service in
`docker-compose.yml` sits behind a profile, so the documented way to install
this product — `docker compose up -d` — starts an installation that keeps no
copies. The comment on the service gives two reasons: rule 10 asks for one
application container plus PostgreSQL, and an operator with their own
arrangement should not be handed a second one.

Neither survives contact with who actually installs this. Rule 10 is about
infrastructure that has to be deployed and operated — Redis, Kafka,
Elasticsearch, object storage — and the backup service is the PostgreSQL image
already on disk running a forty-line shell script with no database, no port and
no configuration of its own. And the operator with their own backups is real but
is not the person reaching for a one-command install of a self-hosted product.
A default is chosen for whoever did not think about the question, because the
one who did will change it in half a minute either way.

The cost is not symmetric. A container nobody wanted is fifty megabytes of an
image already pulled. A copy nobody took is the knowledge base.

There is also something the product says about itself that this contradicts.
Knoverge is built on the claim that knowledge outlives the product: Markdown in
Git, a portable export, a hash-chained ledger. An installation that keeps no
copy answers "what if Knoverge goes away" and not "what if the disk does".

## Decision

**Backups move into the application and are configured in Settings.** The
application image already carries `pg_dump` and `tar`; the job runner already
runs scheduled work. What was missing was not capability but a way to turn it
on without editing a compose file, which is the same thing that was missing
for AI providers before ADR 0021 moved them into the product.

**The default does not change: an installation backs up nothing until somebody
says so.** This is the part of the original reasoning that holds. What changes
is that the absence becomes visible — Settings has a Data and storage section
that says "Backups: off" rather than saying nothing at all. The objection worth
answering was never "everybody must back up"; it was that the person who never
thought about it never finds out.

**The sidecar goes.** Two mechanisms that take the same copy are worse than
one: they have to be kept in step, explained twice, and if both are running the
installation takes every backup twice. The profile and its two scripts are
removed, and an installation using them moves by turning the setting on.

**Retention is in days.** It is what an operator means. Keeping a count only
matches it while the schedule is daily, and the schedule is a setting too.

**The archive does not live inside the directory it archives.** The data
directory is what `data.tar.gz` is made of, so a backup written into it would
be inside the next backup, and the one after that would hold both. Backups keep
a volume of their own. That is a volume, not a service: nothing runs in it.

**A remote copy is optional, and the server only ever writes to it.** An
operator can give one SSH target — host, port, user, directory, and either a
private key or a password — and the finished backup is uploaded there. The
server does not list, prune or delete anything on that machine. Retention in
days applies to the local copies only.

That restraint is the decision, not an omission. A scheduled job that deletes
files on a machine it was merely given access to, and that could one day be
pointed at the wrong directory, is not a feature to enable quietly. Pruning the
far end is the operator's, and the Settings page says so where they configure
it.

**The credential is sealed the way every recoverable secret here is.** Both a
key and a password are encrypted with `KNOVERGE_ENCRYPTION_KEY`, as webhook
signing secrets and provider keys already are (ADR 0033). An installation with
no encryption key cannot configure a remote target at all, and is told why —
the same refusal a webhook gets, for the same reason: refusing is better than
storing a credential the operator believes is encrypted.

The form says a key is the better choice and why: a password is something the
server can read back and reuse, while a key can be revoked at the far end
without touching anything here.

**A failed upload does not fail the backup.** The local copy was taken and is a
backup. The failure is recorded and shown next to the target, the way a failing
webhook endpoint already is, and the next run tries again.

**The job belongs to the worker role.** `KNOVERGE_ROLE` already separates the
process that serves requests from the one that runs scheduled work, and an
installation running several API containers must not take several copies.

## Consequences

An installation that was started with one command and never thought about
backups still has none — and now has a screen that says so, in a section the
settings catalogue has promised since it was written.

The compose file loses a service, which is the direction rule 10 points even
though rule 10 was not the reason. What remains is one application container,
PostgreSQL, and a volume.

The product gains an outbound connection it did not have. Rule 12 is satisfied
in the way it was written to be: the server contacts nothing until an operator
configures it, and what it contacts is an address they typed. It is the same
shape as a webhook and as an AI provider.

An operator who moves from the sidecar to the setting changes nothing about
their existing copies: the format, the order inside an archive and the manifest
are the same, because the job runs the same steps the script did. What they
lose is the script, and what they gain is being able to see whether it ran.

A password in the database is a password in the database, encrypted or not. The
form says so, the documentation says so, and an installation that would rather
not can use a key or no remote target at all.

## Rejected alternatives

### Turn the sidecar on by default and leave it a container

The smaller change, and the one first proposed. Rejected because it answers the
narrow question — are copies taken — and not the one underneath it, which is
whether the operator can tell. A container running or not running is not
something the product can report on its own screen, and a setting the product
owns is.

### Let the Settings page start and stop the container

Would keep the existing script and still give a switch. Rejected because the
application would have to talk to the Docker daemon, which is a far larger
privilege than taking a backup, and because it only works on installations
deployed with compose.

### Prune the remote directory to match the retention

Convenient and symmetrical, and what an operator would expect at first glance.
Rejected for the first version on blast radius: a misconfigured directory plus
a scheduled delete is how a backup target becomes the thing that needed backing
up. If it arrives later it arrives as a switch of its own, off by default and
named plainly.

### Object storage instead of SSH

S3-compatible storage is where backups usually go, and the client is a
dependency rather than infrastructure. Deferred rather than rejected: SSH was
asked for, needs no account anywhere, and an operator who has a second server
has a target already. The upload is written behind one interface so a second
kind of target does not disturb the first.
