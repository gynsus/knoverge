# ADR 0008: Attachments and document ingestion

- Status: Accepted
- Date: 2026-09-19

## Context

Users want to bring files into the knowledge base: text documents, PDFs, office files, and eventually audio, video and images. The architecture forbids object storage in MVP and requires canonical knowledge to stay Markdown in Git. Binary files do not belong in the Git repository.

## Decision

1. Original files are stored on the local filesystem under `KNOVERGE_DATA_DIR/workspaces/<workspace_id>/attachments/<sha256>`, content-addressed and deduplicated. They are part of the backup boundary but never committed to Git.
2. An `Attachment` record in PostgreSQL holds media type, size, original filename, original location (`original_uri`) and extraction status.
3. Files that contain text are extracted by a background job into a `document` knowledge item whose Markdown is the extracted text. The item carries a source reference of type `attachment` plus the original location, so search, briefing and reconciliation treat the content as ordinary knowledge.
4. Text-bearing formats in the first ingestion milestone: plain text, Markdown, HTML, PDF, DOCX. Extraction runs without an AI provider.
5. Audio, video and images are handled in a later milestone through the intelligence provider abstraction (transcription, image description, OCR). Until a provider is configured, such files are stored by reference only.
6. Files that cannot be interpreted are stored by reference only, with no `document` item.
7. Size limits are configurable (`KNOVERGE_ATTACHMENT_MAX_MB`). Optional object storage may be added later through a new ADR behind the same `AttachmentStore` interface.

## Consequences

### Positive

- Every readable document becomes searchable, reviewable, versioned knowledge with provenance.
- The Git repository stays small and text-only.
- No new infrastructure.

### Negative

- Large attachment directories make backups larger.
- Extracted text may need cleanup; reviewers can edit the `document` item like any other.
- Media understanding depends on optional providers.

## Rejected alternatives

### Storing files in Git

Would bloat the repository and break the "human-readable text" property. Rejected.

### Requiring object storage

Violates the no-new-infrastructure rule for MVP. Rejected; kept as an optional later extension.
