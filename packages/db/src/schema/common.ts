import { jsonb, timestamp, varchar } from 'drizzle-orm/pg-core';

/** Prefixed ULID columns: longest prefix (5) + underscore + 26 characters. */
export const id = (name: string) => varchar(name, { length: 40 });

export const timestampTz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const json = (name: string) => jsonb(name).$type<Record<string, unknown>>();
