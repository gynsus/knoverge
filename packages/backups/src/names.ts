/**
 * What a whole backup is called on disk.
 *
 * UTC to the second, which sorts in the order the backups were taken and reads
 * the same in every timezone an operator might be in. A directory that does not
 * match this is not one of ours, which is how rotation refuses to remove
 * somebody else's files from a directory they chose to share.
 */
const NAME = /^\d{8}T\d{6}Z$/u;

export function backupName(now: Date): string {
  return `${now.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
}

export function isBackupName(name: string): boolean {
  return NAME.test(name);
}

/**
 * When a backup with this name was taken.
 *
 * Read from the name rather than from the file's timestamps: a copied or
 * restored directory carries the name it was given and whatever modification
 * time the copy produced, and retention is about the former.
 */
export function takenAt(name: string): Date {
  const iso = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(
    9,
    11,
  )}:${name.slice(11, 13)}:${name.slice(13, 15)}Z`;
  return new Date(iso);
}
