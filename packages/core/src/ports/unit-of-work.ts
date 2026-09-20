/**
 * Opaque transaction handle. Repositories receive it and unwrap it to the
 * storage-specific transaction; domain code never inspects it.
 */
export type Tx = { readonly __brand: 'Tx' };

export interface UnitOfWork {
  /** Runs fn inside one database transaction; rolls back when fn throws. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs fn inside one transaction holding an exclusive named lock for its whole
   * duration, so two callers with the same key never overlap. Use it when a
   * check-then-act cannot be expressed as a unique constraint.
   */
  runExclusive<T>(key: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs fn holding the workspace's write lock, across as many transactions as
   * fn opens and across work outside the database entirely.
   *
   * A canonical write commits to Git and then to PostgreSQL, so the lock has to
   * outlive a transaction; runExclusive's lock is released when its transaction
   * ends. This one is session-scoped on a connection of its own, and a process
   * that dies loses the connection and the lock with it, which is what leaves
   * the operation row for recovery rather than a lock nobody can release.
   *
   * It holds a connection for the whole call and the work inside opens
   * transactions on others, so a write needs two connections at its peak. The
   * implementation must not let waiting writers take connections the writer
   * holding the lock still needs to finish: with one connection per waiter,
   * enough concurrent writes to different workspaces take the whole pool and
   * nothing can proceed. Callers must still size the pool for the number of
   * workspaces written to at once, plus headroom for reads; four is the floor
   * for a single-workspace installation.
   */
  withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
}
