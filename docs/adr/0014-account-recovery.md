# ADR 0014: Regaining access to an account without a mail server

- Status: Accepted
- Date: 2026-09-20

## Context

ADR 0004 rejected SMTP as a dependency: email-based login would require a mail
server on every self-hosted installation, and one-time codes by email were
rejected for the same reason. That decision stands. What it did not answer is
what happens when somebody cannot get in.

Today there is no answer at all. `POST /v1/auth/password` changes a password for
somebody who already knows it. `UpdateMemberRequest` carries a role and nothing
else. No repository method updates a user's email address. So:

- a person who forgets their password has no route back;
- an owner who loses access cannot be helped by anyone, because a workspace
  always keeps at least one owner and the last one cannot be demoted or removed;
- an address typed wrongly at `knoverge bootstrap` is permanent.

The only remaining recourse is editing `users` in PostgreSQL by hand, which
writes a password hash past the ledger — precisely the kind of unattributed
change rule 3 exists to prevent.

## Decision

Three routes, none of which needs a mail server.

### A person changes their own address, with their password

`POST /v1/auth/email` takes the new address and the current password. It checks
the password, rejects an address another account already holds, and revokes
every other session.

There is no confirmation link, because there is nothing to send it with. That is
a real weakness and is written down rather than implied: somebody holding a
stolen session still needs the password to move the account, so the session
alone is not enough, but the new address is not proven to belong to anybody.

### An administrator sets a temporary password for a member

`POST /v1/admin/members.reset_password` sets a password an administrator passes
on out of band, exactly as `initial_password` already works when adding a member
to an installation with no mail server.

The authority rule is the one membership already uses: you may act on somebody
only if you hold every permission their role includes. An admin therefore
cannot reset an owner's password, because the owner role includes permissions an
admin does not hold. Without that rule this endpoint would be a promotion from
admin to owner that no role change records.

Two more limits. It cannot be used on yourself — that is what the settings page
is for, and self-service through an administrative endpoint bypasses the
password check. And it revokes every session of the person it acts on, so an
account that was taken over does not stay taken over, and a person who did not
ask for this finds out immediately.

### An operator resets from the command line

`knoverge user password-reset` and `knoverge user email` do the same work
without a browser, for the case the routes above cannot cover: the last owner,
who by construction has nobody above them.

This grants nothing new. Whoever can run a command in the server's container can
already read `KNOVERGE_LEDGER_KEY` and write to the database directly. The point
is that they no longer have to: the operation goes through the domain service,
so it is validated, attributed and appended to the ledger like any other.

### An administrator's reset is a ledger event; changing your own address is not

`user.password_reset` records the actor and the user acted on. It is one person
acting on another inside a workspace, which is exactly what rule 3 is about, and
the workspace is unambiguous because the authority came from a membership in it.

Changing your own address is not a ledger event, for the same reason changing
your own password is not one: it is instance-level authentication hygiene, not a
governed change to anything a workspace holds. The ledger is per-workspace and
an account is not. Writing the event into whichever workspace happened to be
selected would record it in one place and hide it from the others; writing it
into every workspace the person belongs to would make an unrelated audit feed
noisier each time somebody fixed a typo.

Neither the event nor any log line carries an address. The ledger holds ids,
hashes, actor context and safe metadata, and an email address is none of those —
it is personal data, and an append-only table is the wrong place to accumulate
it.

## Consequences

### Positive

- A forgotten password is recoverable at every level: by an administrator for a
  member, and by the operator for anyone including the last owner.
- No installation gains a dependency. SMTP is still not required for anything.
- An administrator acting on somebody else is attributable: the reset writes an
  event naming who did it and to whom. Hand-editing `users` writes nothing.
- A change of address is available to the person who owns the account rather
  than only to whoever can reach the database.

### Negative

- A new address is not verified. With no mail server it cannot be, and a person
  who mistypes it locks themselves out of a login they can still recover through
  an administrator or the operator. The settings page says so before submitting.
- An administrator can read nothing new, but can now deny service to a member by
  resetting their password. That is visible in the ledger and bounded by the
  role rule, and it is a lesser evil than a member with no way back in.
- Two more ways to change a password means two more paths to keep correct when
  TOTP arrives. TOTP must gate all three, and this ADR is the list of them.

## Rejected alternatives

### A recovery code printed at bootstrap

A one-time code shown when the installation is created, stored hashed, spendable
once to reset the first owner. It needs no mail server and no shell access.

Rejected because a code generated once and needed years later is a code nobody
still has, and the failure mode is identical to the one being fixed — except
that the operator now also believes they are covered. The command line is
available exactly when it is needed.

### An admin impersonation route

"Sign in as this member" is shorter than a reset and much harder to reason
about: every subsequent action is taken by somebody who is not who the session
says they are, which is a direct contradiction of rule 3.

### Waiting for OIDC

ADR 0004 already plans OIDC sign-in, which moves recovery to the identity
provider. It does not help a single-user self-hosted installation, which is the
default deployment, and it is several milestones away.
