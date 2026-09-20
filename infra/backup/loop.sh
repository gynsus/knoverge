#!/bin/sh
# Runs backup.sh every KNOVERGE_BACKUP_INTERVAL seconds.
#
# A loop rather than cron because this container does one thing, and a sleep
# that the container runtime restarts is easier to reason about than a crond
# whose failures go to a log nobody reads.
set -eu
: "${KNOVERGE_BACKUP_INTERVAL:=86400}"

while true; do
  # A failed run must not stop the schedule: the next one may well succeed,
  # and a backup container that quietly exited is worse than a failed backup.
  /backup.sh || echo "backup failed; the next run is in ${KNOVERGE_BACKUP_INTERVAL}s" >&2
  sleep "$KNOVERGE_BACKUP_INTERVAL"
done
