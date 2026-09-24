// @knoverge/intelligence: the optional provider abstraction.
//
// No core domain module may require this package to function (rule 9). What it
// offers is a port and an HTTP adapter for it; whether anything is configured
// is the server's question, and every feature that uses one has an answer for
// "nothing is".
export {
  EmbeddingError,
  createHttpEmbeddingProvider,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type HttpEmbeddingOptions,
} from './embeddings.ts';
