import type { WorkspaceListEntry } from '@knoverge/contracts';
import { Bot, Check, Copy, Database, LogIn, Pencil, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { copyToClipboard } from '@/lib/password';
import { relativeTime } from '@/lib/relative-time';

export interface WorkspaceDetailsProps {
  workspace: WorkspaceListEntry;
  current: boolean;
  canAdminister: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMembers: () => void;
  onNotice: (message: string, tone: 'status' | 'error') => void;
}

/**
 * A workspace as an object rather than a card.
 *
 * The card says enough to choose between them. This says enough to decide what
 * to do with one: what it holds, who you are in it, when anything last
 * happened, and the identifier an agent has to be told to reach it.
 */
export function WorkspaceDetails({
  workspace,
  current,
  canAdminister,
  onOpen,
  onEdit,
  onMembers,
  onNotice,
}: WorkspaceDetailsProps) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copySlug = async () => {
    const ok = await copyToClipboard(workspace.slug);
    setCopied(ok);
    onNotice(ok ? t('workspaces.slug_copied') : t('password.copy_failed'), ok ? 'status' : 'error');
  };

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="grid gap-2">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
            {workspace.slug}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copySlug()}
            aria-label={t('workspaces.copy_slug')}
            className="size-7 shrink-0 px-0"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
        <p className="text-sm">
          {workspace.description ?? (
            <span className="text-muted-foreground">{t('workspaces.no_description')}</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {current && <Badge>{t('workspaces.current')}</Badge>}
          <Badge variant="outline">{t(`roles.${workspace.role}`)}</Badge>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {!current && (
          <Button type="button" size="sm" onClick={onOpen}>
            <LogIn aria-hidden="true" className="size-4" />
            {t('workspaces.open')}
          </Button>
        )}
        {canAdminister && (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" className="size-4" />
            {t('workspaces.edit')}
          </Button>
        )}
        {canAdminister && (
          <Button type="button" variant="outline" size="sm" onClick={onMembers}>
            <Users aria-hidden="true" className="size-4" />
            {t('workspace.members')}
          </Button>
        )}
      </div>

      <Separator />

      <section className="grid gap-1.5">
        <h4 className="text-sm font-medium">{t('taxonomy.holds')}</h4>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Database aria-hidden="true" className="size-4 shrink-0" />
          {t('workspaces.items', { count: workspace.item_count })}
        </p>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bot aria-hidden="true" className="size-4 shrink-0" />
          {t('workspaces.agents', { count: workspace.agent_count })}
        </p>
      </section>

      <Separator />

      <section className="grid gap-1 text-xs text-muted-foreground">
        <h4 className="text-sm font-medium text-foreground">{t('workspaces.about')}</h4>
        <p>{t('workspaces.language', { language: t(`language.${workspace.default_language}`) })}</p>
        <p>
          {t('workspaces.created', { when: relativeTime(workspace.created_at, i18n.language) })}
        </p>
        <p>
          {workspace.last_activity_at === null
            ? t('workspaces.never_active')
            : t('workspaces.updated', {
                when: relativeTime(workspace.last_activity_at, i18n.language),
              })}
        </p>
      </section>
    </div>
  );
}
