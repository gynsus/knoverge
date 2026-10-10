# 41. The server speaks SSH itself, and pins the host key it met first

Date: 2026-10-10

Status: accepted

## Context

ADR 0040 decided that a finished backup may be uploaded to one SSH target the
operator configures, and that the server only ever writes there. It did not say
what speaks SSH.

The runtime image is `node:24-alpine` with `git` and `postgresql17-client`
added. It has no `ssh`, no `scp`, no `sftp` and no `rsync`. So there are two
ways to send the file, and they are not equivalent once the details are looked
at.

The credential is sealed in the database under `KNOVERGE_ENCRYPTION_KEY` and is
opened in memory when a run needs it. OpenSSH takes a private key from a file
and from nowhere else — not from standard input, not from an argument, not from
an environment variable. Using it means decrypting the key, writing it to a
temporary file inside the container with the right mode, and removing it
afterwards; a process killed in between leaves the key on disk. The library
takes the key as a string.

The settings offer two kinds of authentication, a key and a password, because a
target that only accepts one is not a reason to have no second copy at all.
`scp` cannot authenticate with a password non-interactively. That needs
`sshpass`, which hands the password over through an argument or an environment
variable — exactly what `systemTools` avoids for `pg_dump` by putting the
database password in `PGPASSWORD` rather than on a command line that `ps` shows
to everyone on the machine. The library has password authentication as a
parameter.

Host key verification is a decision in both cases and an easy one to get wrong
by omission. OpenSSH needs a `known_hosts` file, which would have to be
generated from something; with no file and no option, the first connection
either fails or accepts whoever answers, depending on `StrictHostKeyChecking`.
The library hands the key to a callback and does whatever the callback says.

## Decision

**The server speaks SSH itself, through `ssh2`.** It is added as a dependency
of `packages/backups`, the package that already owns taking the copy. Nothing
is added to the image.

This is not a preference for libraries. It is three concrete differences: the
private key never reaches a filesystem, password authentication needs no second
external program and no password on a command line, and host key verification
is code in this repository rather than the default of a program configured by a
file that does not exist.

The cost is real and worth stating. A protocol implementation and its key
parsing now ship inside the product, maintained by one person, where OpenSSH is
the implementation everything else in the world is tested against. `ssh2` is
already in the dependency tree through `testcontainers`, but as a development
dependency, which is not the same as shipping it. Its optional native parts
(`cpu-features`, `nan`) stay unbuilt, as `allowBuilds` already says; it works
without them.

**SFTP, not `exec`.** The upload opens an SFTP session and writes files. It
runs no command on the far machine, so the account it is given can be
restricted to SFTP with no shell, and the server cannot be the thing that ran
something there.

**The far end gets the same staging rename the local copy gets.** Files go into
`<directory>/<name>.partial/` and the directory is renamed to
`<directory>/<name>` when every file has arrived. A connection that drops
halfway leaves something that is visibly unfinished rather than something that
looks like a backup and is missing a file. This matters more at the far end
than locally, because the far end is where somebody will restore from without
being able to ask what happened.

**The target directory must already exist.** A missing one is an error with the
path in it, not something to create. The operator typed that path; creating a
tree where they did not mean one is how a backup ends up somewhere nobody looks.

**The host key is pinned on first use.** The first successful connection stores
the key the target presented. Every later connection requires the same key and
refuses otherwise, with a message that says the key changed and that the
operator has to clear it to accept a new one. This is what `ssh` itself does
with `known_hosts`, and what the alternatives are:

- Requiring a fingerprint in the form before the first connection is stronger —
  it closes the first connection too — and it asks an operator to run
  `ssh-keyscan` and paste a digest before anything works at all. The screen
  shows the pinned fingerprint afterwards, so they can still check it against
  the far machine out of band, which is the same verification one step later.
- Accepting any key every time is indefensible for a connection that carries
  the whole database and every repository.

Clearing or changing the target's host or port clears the pin, because a pin is
a fact about a machine and those fields are what name the machine.

**A key with a passphrase is refused with its own message.** One secret field
holds one secret, and asking for a second one would change the form and the
column. The failure is clear rather than mysterious.

## Consequences

The image does not grow and the private key does not touch a disk. An operator
who wanted `openssh-client` in there for their own reasons still does not have
it; nothing about this depends on the image, so that can change later without
changing the setting or the data.

A supply-chain compromise of `ssh2` reaches the shipped product, not just the
test suite. It is pinned in the catalogue like every other dependency and moves
through the same two-day minimum release age and the same review.

The first upload to a new target records a fingerprint the operator did not
choose. If they are in a position to be given the wrong one, they are in a
position to have the whole upload intercepted, and no amount of code here fixes
that — what the pin buys is that it can happen at most once and is then visible
on the screen.

An operator whose target machine is rebuilt sees the upload fail with "the host
key changed", which is the correct and annoying answer. Clearing the pin is one
action on the settings screen.

## Rejected alternatives

### `openssh-client` in the image, private key only

Drop password authentication from the contract and shell out to `scp` with
`-i`. The implementation everybody trusts, and the one an operator would use by
hand, which means its behaviour matches what they expect and what every guide
on the internet says.

Rejected on the temporary file. The key is sealed in the database precisely so
that it is not lying around; writing it out for every run, in a container whose
filesystem is shared with nothing but also inspected by nobody, undoes that for
the duration — and for longer than that whenever a run is killed between the
write and the unlink. Losing password authentication is a second cost, paid by
the operator whose target does not take keys.

### `openssh-client` plus `sshpass`

Keeps both kinds of authentication. Rejected because the password then travels
through an argument or an environment variable to a second external program,
which is the thing `systemTools` goes out of its way not to do with the
database password.

### Upload with `exec` and a shell command

`tar` piped into `ssh host 'cat > file'` needs no SFTP and no directory
listing. Rejected because it requires a shell on the far machine and makes this
server something that runs commands there. SFTP lets the operator give an
account that can do nothing else.
