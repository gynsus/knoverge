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
 * The order is: named key, then taxonomy, then ledger. A transaction takes them
 * in that order and never in another.
 */
export const LOCK_NAMED = 1;
export const LOCK_TAXONOMY = 2;
export const LOCK_LEDGER = 3;
export const LOCK_MIGRATIONS = 4;
