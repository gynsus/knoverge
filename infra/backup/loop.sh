#!/bin/sh
# Runs backup.sh every KNOVERGE_BACKUP_INTERVAL seconds.
#
# A loop rather than cron because this container does one thing, and a sleep
# that the container runtime restarts is easier to reason about than a crond
# whose failures go to a log nobody reads.
set -eu
: "${KNOVERGE_BACKUP_INTERVAL:=86400}"
: "${KNOVERGE_BACKUP_DIR:=/backups}"

# Docker creates a named volume's mount point owned by root when the path is
# not in the image, so the directory has to be handed over before the process
# can stop being root. Everything after this line runs as postgres: this
# container reads canonical knowledge and writes an archive of it, and neither
# needs the privileges of the machine.
if [ "$(id -u)" = '0' ]; then
  mkdir -p "$KNOVERGE_BACKUP_DIR"
  # Recursive, because rotation has to be able to remove what earlier runs
  # wrote — including anything left by a version of this that ran as root.
  chown -R postgres:postgres "$KNOVERGE_BACKUP_DIR"
  exec gosu postgres "$0" "$@"
fi

while true; do
  # A failed run must not stop the schedule: the next one may well succeed,
  # and a backup container that quietly exited is worse than a failed backup.
  /backup.sh || echo "backup failed; the next run is in ${KNOVERGE_BACKUP_INTERVAL}s" >&2
  sleep "$KNOVERGE_BACKUP_INTERVAL"
done
