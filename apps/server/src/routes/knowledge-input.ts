import type {
  CreateKnowledgeRequest,
  ProposeCreateRequest,
  ProposeUpdateRequest,
  UpdateKnowledgeRequest,
} from '@knoverge/contracts';
import type { CreateItemInput, UpdateItemInput } from '@knoverge/core';

/**
 * The wire's words for an item, in the domain's.
 *
 * One place, because there were six: the admin create, the admin update, the
 * three propose routes and the supersession's replacement each wrote the mapping
 * out again, and a field added to the contract reached whichever of them somebody
 * remembered. A validity window reached three of them and a summary's
 * dependencies reached one, so proposing a dated fact through the tool an agent
 * has to use quietly dropped the dates.
 *
 * The mapped type is the guard: every key of the request has to be named here, so
 * the next field to arrive is a compile error rather than a field that goes
 * missing on one route out of six.
 */
type ContentRequest = Omit<CreateKnowledgeRequest, 'request_id' | 'idempotency_key'>;

export function contentInput(body: ContentRequest): CreateItemInput {
  const {
    title,
    body: text,
    type,
    language,
    categories,
    tags,
    slug,
    valid_from,
    valid_until,
    observed_at,
    external,
    sources,
    relations,
    summary_of,
    drafted_by,
    reason,
    ...rest
  } = body as Required<ContentRequest>;
  nothingLeft(rest);
  return {
    title,
    body: text,
    type,
    language,
    categories,
    tags,
    slug,
    validFrom: valid_from,
    validUntil: valid_until,
    observedAt: observed_at,
    external,
    sources,
    relations,
    summaryOf: summary_of,
    draftedBy: drafted_by,
    reason,
  };
}

/** The same for a change, where every content field is optional. */
export function changeInput(
  body: Omit<UpdateKnowledgeRequest, 'request_id' | 'idempotency_key'>,
): Omit<UpdateItemInput, 'itemId' | 'baseRevisionId' | 'baseContentHash'> & {
  itemId: UpdateItemInput['itemId'];
  baseRevisionId: UpdateItemInput['baseRevisionId'];
  baseContentHash: UpdateItemInput['baseContentHash'];
} {
  const {
    item_id,
    base_revision_id,
    base_content_hash,
    title,
    body: text,
    type,
    language,
    categories,
    tags,
    valid_from,
    valid_until,
    observed_at,
    sources,
    relations,
    summary_of,
    drafted_by,
    reason,
    ...rest
  } = body as Required<Omit<UpdateKnowledgeRequest, 'request_id' | 'idempotency_key'>>;
  nothingLeft(rest);
  return {
    itemId: item_id,
    baseRevisionId: base_revision_id,
    baseContentHash: base_content_hash,
    title,
    body: text,
    type,
    language,
    categories,
    tags,
    validFrom: valid_from,
    validUntil: valid_until,
    observedAt: observed_at,
    sources,
    relations,
    summaryOf: summary_of,
    draftedBy: drafted_by,
    reason,
  };
}

/** What a proposal adds to a create, which the domain takes under its own names. */
export function proposalExtras(body: ProposeCreateRequest | ProposeUpdateRequest) {
  return {
    reason: body.reason,
    confidence: body.confidence,
    ...('acknowledged_duplicate_ids' in body
      ? { acknowledgedDuplicateIds: body.acknowledged_duplicate_ids }
      : {}),
    ...('sync_session_id' in body ? { syncSessionId: body.sync_session_id } : {}),
  };
}

/** Nothing left over: a field the request carries and this does not pass on. */
function nothingLeft(_rest: Record<string, never>): void {}
