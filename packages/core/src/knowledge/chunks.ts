import { chunkBody, type Chunk } from '@knoverge/search';

/**
 * The chunks an item is indexed as.
 *
 * A wrapper over the splitter for one reason: an item whose body chunks to
 * nothing still has to have a row, or the startup fill would see it as never
 * indexed and rebuild it on every boot. A body cannot be empty — the domain
 * refuses one — so this is a floor rather than a path anybody takes, and the
 * title is what the one chunk holds.
 */
export function chunksFor(body: string, title: string): Chunk[] {
  const chunks = chunkBody(body);
  return chunks.length > 0 ? chunks : [{ ordinal: 0, text: title }];
}
