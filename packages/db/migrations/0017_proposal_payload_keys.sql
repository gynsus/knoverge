-- A proposal's payload becomes a contract, so its keys become the contract's.
--
-- The payload was assembled by hand at each call site and spelled its fields
-- however that site happened to: `title` beside `validFrom`, `newItem` beside
-- `existingItem`. It is served as `proposed_payload` and read by the review
-- screen, where everything else on the wire is snake_case — and the screen
-- already carried a workaround that looked for both spellings.
--
-- Pending rows are the only ones this matters for: a resolved proposal's payload
-- is a record of what was proposed and is only ever read back by a person.
-- Rewriting both keeps one spelling in the table.
UPDATE proposals
SET proposed_payload = (proposed_payload - 'validFrom')
  || jsonb_build_object('valid_from', proposed_payload -> 'validFrom')
WHERE proposed_payload ? 'validFrom';
--> statement-breakpoint
UPDATE proposals
SET proposed_payload = (proposed_payload - 'validUntil')
  || jsonb_build_object('valid_until', proposed_payload -> 'validUntil')
WHERE proposed_payload ? 'validUntil';
--> statement-breakpoint
UPDATE proposals
SET proposed_payload = (proposed_payload - 'observedAt')
  || jsonb_build_object('observed_at', proposed_payload -> 'observedAt')
WHERE proposed_payload ? 'observedAt';
--> statement-breakpoint
UPDATE proposals
SET proposed_payload = (proposed_payload - 'newItem')
  || jsonb_build_object('new_item', proposed_payload -> 'newItem')
WHERE proposed_payload ? 'newItem';
--> statement-breakpoint
-- The inner keys as well: this one is an object of its own, not a value.
UPDATE proposals
SET proposed_payload = (proposed_payload - 'existingItem')
  || jsonb_build_object(
    'existing_item',
    jsonb_build_object(
      'item_id', proposed_payload -> 'existingItem' -> 'itemId',
      'base_revision_id', proposed_payload -> 'existingItem' -> 'baseRevisionId',
      'base_content_hash', proposed_payload -> 'existingItem' -> 'baseContentHash'
    )
  )
WHERE proposed_payload ? 'existingItem';
