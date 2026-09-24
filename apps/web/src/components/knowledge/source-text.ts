import type { FrontmatterSource } from '@knoverge/contracts';

/**
 * What a source says about itself, in one line.
 *
 * Which field carries it depends on what kind of source it is: a web source
 * has a URI, an external system has a key, an agent session has a client and
 * a session. The first one present is the one worth showing.
 */
export function describeSource(source: FrontmatterSource): string {
  return (
    source.uri ??
    source.external_key ??
    [source.client, source.session_id].filter(Boolean).join(' · ')
  );
}
