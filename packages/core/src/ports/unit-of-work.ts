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
}
