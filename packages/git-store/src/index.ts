// Markdown serialisation, content hashing, file layout and Git revision
// operations. See docs/GIT_REPOSITORY.md for the format this implements.
export { contentHash, frontmatterHash, normalise } from './content.ts';
export { MAX_SLUG_LENGTH, slugifyTitle, uniqueSlug } from './slug.ts';
export {
  GitError,
  WorkspaceGitRepository,
  repositoryPath,
  type CommitIdentity,
  type CommitRequest,
  type FileWrite,
} from './git.ts';
export {
  TAXONOMY_PATH,
  renderReadme,
  renderTaxonomy,
  type FlatCategory,
  type TaxonomyFile,
  type TaxonomyNode,
} from './taxonomy-file.ts';
