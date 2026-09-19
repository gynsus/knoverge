import { ID_PREFIXES, type IdPrefix } from '@knoverge/contracts';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * Generates a prefixed ULID (DATA_MODEL.md section 0). Ids identify objects only;
 * ordering always comes from explicit sequence columns.
 */
export function newId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}`;
}

export { ID_PREFIXES };
export type { IdPrefix };
