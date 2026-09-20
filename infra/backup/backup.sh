#!/bin/sh
# One coordinated backup: the database, then the workspace repositories.
#
# The order is not arbitrary. A canonical write commits to Git first and to
# PostgreSQL second (ARCHITECTURE.md section 4), so a backup taken while one is
# in flight can only be skewed one way if the database is dumped first: the
# archive holds a commit the dump does not know about. That is the state
# recovery is built for — the workspace refuses writes and says so. Archiving
# Git first would produce the opposite skew, a revision row with no commit,
# which the architecture calls corruption and cannot repair.
set -eu

: "${KNOVERGE_POSTGRES_HOST:=postgres}"
: "${KNOVERGE_POSTGRES_DB:=knoverge}"
: "${KNOVERGE_POSTGRES_USER:=knoverge}"
: "${KNOVERGE_DATA_DIR:=/data}"
: "${KNOVERGE_BACKUP_DIR:=/backups}"
: "${KNOVERGE_BACKUP_KEEP:=14}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${KNOVERGE_BACKUP_DIR}/${stamp}"
# Built beside the final name and moved into place at the end, so a run that
# dies half way leaves nothing a restore could mistake for a whole backup.
staging="${target}.partial"
mkdir -p "$staging"
trap 'rm -rf "$staging"' EXIT

# Custom format: compressed, and pg_restore can read it selectively.
pg_dump --host="$KNOVERGE_POSTGRES_HOST" --username="$KNOVERGE_POSTGRES_USER" \
  --dbname="$KNOVERGE_POSTGRES_DB" --format=custom --file="$staging/postgres.dump"

tar --create --gzip --file "$staging/data.tar.gz" --directory "$KNOVERGE_DATA_DIR" .

cat > "$staging/manifest.txt" <<MANIFEST
taken_at=${stamp}
database=${KNOVERGE_POSTGRES_DB}
data_dir=${KNOVERGE_DATA_DIR}
order=postgres-then-data
MANIFEST

trap - EXIT
mv "$staging" "$target"
echo "backup written to ${target}"

# Rotation. Only whole backups are counted, so a partial run cannot push a
# good one out of the window.
cd "$KNOVERGE_BACKUP_DIR"
ls -1d [0-9]*Z 2>/dev/null | sort -r | tail -n "+$((KNOVERGE_BACKUP_KEEP + 1))" | while read -r old; do
  echo "removing old backup ${old}"
  rm -rf "$old"
done
