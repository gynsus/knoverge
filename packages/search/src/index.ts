// @knoverge/search: what retrieval knows that is neither SQL nor orchestration.
//
// The SQL lives in @knoverge/db, because that is what a repository is for, and
// the service that calls both lives in @knoverge/core. Here is the part that
// decides how text becomes searchable and how two opinions about relevance
// become one number (ADR 0020).
export { MAX_CHUNK_CHARS, TARGET_CHUNK_CHARS, chunkBody, type Chunk } from './chunk.ts';
