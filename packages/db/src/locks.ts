/**
 * Namespaces for PostgreSQL advisory locks.
 *
 * The two-argument form of `pg_advisory_xact_lock` takes a class and an object,
 * which keeps unrelated keys apart. With the single-argument form every lock in
 * the installation shares one 32-bit space, so a hash collision between, say, a
 * taxonomy key and a ledger key would serialise two operations that have
 * nothing to do with each other, and could deadlock against the documented
 * lock order.
 *
 * The order is: workspace write, then named key, then taxonomy, then ledger. A
 * transaction takes them in that order and never in another. The workspace
 * write lock comes first because it is session-scoped and held across the
 * transactions that take the others.
 */
export const LOCK_NAMED = 1;
/**
 * Reserved. The workspace write lock replaced it: a taxonomy mutation validates
 * against the tree and rewrites it in one operation that spans a Git commit, so
 * the exclusion has to outlive a transaction. The number is kept so a future
 * transaction-scoped taxonomy lock does not collide with an older one.
 */
export const LOCK_TAXONOMY = 2;
export const LOCK_LEDGER = 3;
export const LOCK_MIGRATIONS = 4;
/** Held for a whole canonical write, across transactions and a Git commit. */
export const LOCK_WORKSPACE_WRITE = 5;
