/**
 * Opaque transaction handle. Repositories receive it and unwrap it to the
 * storage-specific transaction; domain code never inspects it.
 */
export type Tx = { readonly __brand: 'Tx' };

export interface UnitOfWork {
  /** Runs fn inside one database transaction; rolls back when fn throws. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
