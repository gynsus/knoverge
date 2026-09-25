import type { EvidenceRole, FrontmatterSource, SourceType } from '@knoverge/contracts';
import { EvidenceRole as Roles, SourceType as Types } from '@knoverge/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ExternalLink } from '@/components/ui/external-link';
import { Select } from '@/components/ui/select';
import { isOpenable } from '@/lib/external-url';
import { describeSource } from './source-text.ts';

/**
 * Where an item's knowledge came from.
 *
 * Provenance is one of the things this product is for, so a bare "no sources"
 * badge that cannot be acted on is the wrong end of it: the list is here, and
 * so is the way to add one.
 */
export function SourceList({ sources }: { sources: readonly FrontmatterSource[] }) {
  const { t } = useTranslation();
  if (sources.length === 0)
    return <p className="text-sm text-muted-foreground">{t('knowledge.no_sources')}</p>;
  return (
    <ul className="grid gap-2 text-sm">
      {sources.map((source, index) => {
        const detail = describeSource(source);
        return (
          <li key={index} className="flex flex-wrap items-baseline gap-2">
            <Badge variant="outline" className="font-normal">
              {t(`knowledge.source_types.${source.type}`)}
            </Badge>
            {/* A source worth citing is one somebody can go and read, so
                where it is reachable it is reachable from here. What is not
                a web address — a repository path, a ticket, a session — is
                text, which is what it was. */}
            {isOpenable(source.uri) ? (
              <ExternalLink href={source.uri}>{source.uri}</ExternalLink>
            ) : detail ? (
              <span className="min-w-0 break-all">{detail}</span>
            ) : (
              <span className="text-muted-foreground">{t('knowledge.source_unnamed')}</span>
            )}
            {/* The role is what makes a source evidence rather than a link:
                a contradicting source is not a weaker primary one. */}
            <span className="text-xs text-muted-foreground">
              {t(`knowledge.evidence_roles.${source.role}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Adding and removing sources.
 *
 * Three fields, not seven. A source recorded by an agent carries the client
 * and the session it came out of, and neither is something a person types; a
 * person adding one is naming a page, a file or a commit, and the type says
 * which. The fields an agent filled in are kept as they were.
 */
export function SourceEditor({
  sources,
  onChange,
}: {
  sources: readonly FrontmatterSource[];
  onChange: (sources: FrontmatterSource[]) => void;
}) {
  const { t } = useTranslation();

  const replace = (index: number, patch: Partial<FrontmatterSource>) =>
    onChange(sources.map((source, i) => (i === index ? { ...source, ...patch } : source)));

  return (
    <div className="grid gap-2">
      {sources.map((source, index) => (
        <div key={index} className="grid gap-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap gap-2">
            <Select
              value={source.type}
              onChange={(e) => replace(index, { type: e.target.value as SourceType })}
              aria-label={t('knowledge.source_type')}
              className="sm:w-52"
            >
              {Types.options.map((type) => (
                <option key={type} value={type}>
                  {t(`knowledge.source_types.${type}`)}
                </option>
              ))}
            </Select>
            <Select
              value={source.role}
              onChange={(e) => replace(index, { role: e.target.value as EvidenceRole })}
              aria-label={t('knowledge.source_role')}
              className="sm:w-44"
            >
              {Roles.options.map((role) => (
                <option key={role} value={role}>
                  {t(`knowledge.evidence_roles.${role}`)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(sources.filter((_, i) => i !== index))}
              aria-label={t('knowledge.remove_source', {
                what: describeSource(source) || index + 1,
              })}
              className="text-destructive"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <Input
            value={source.uri ?? ''}
            onChange={(e) => {
              const uri = e.target.value.trim();
              const { uri: _dropped, ...rest } = source;
              replace(index, uri === '' ? ({ ...rest, uri: undefined } as never) : { uri });
            }}
            aria-label={t('knowledge.source_where')}
            placeholder={t('knowledge.source_where_hint')}
            maxLength={2048}
          />
          {/* What an agent recorded and a person did not type. Shown so it is
              not silently carried, and not editable for the same reason. */}
          {(source.client ?? source.session_id ?? source.external_key) && (
            <p className="text-xs break-all text-muted-foreground">
              {[source.client, source.session_id, source.external_key].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...sources, { type: 'web_url', role: 'primary' }])}
      >
        <Plus aria-hidden="true" className="size-4" />
        {t('knowledge.add_source')}
      </Button>
    </div>
  );
}
