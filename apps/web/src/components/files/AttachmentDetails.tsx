import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ATTACHMENTS_KEY, ATTACHMENT_KEY } from '@/lib/query-keys';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { readableSize } from '@/lib/readable-size';
import { toneOf } from './attachment.ts';

/**
 * One file: what it is, what became of it, and how to get it back.
 *
 * The question this answers is the one the list cannot: a file is read a minute
 * after it arrives, and what comes out is an ordinary knowledge item that lives
 * somewhere else entirely. Both halves are here, and the way between them is a
 * link rather than an id.
 */
export function AttachmentDetails({ attachmentId }: { attachmentId: string }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const file = useQuery({
    queryKey: [...ATTACHMENT_KEY, attachmentId],
    queryFn: ({ signal }) => adminApi.attachments.get(attachmentId, signal),
    // While the sweep has not run, the answer changes without anybody doing
    // anything. Ten seconds is often enough to feel immediate and rare enough
    // not to be a poll.
    refetchInterval: (query) => {
      const state = query.state.data?.attachment.extraction_state;
      return state === 'pending' || state === 'extracting' ? 10_000 : false;
    },
  });

  const reread = useMutation({
    mutationFn: () => adminApi.attachments.reread({ attachment_id: attachmentId }),
    onSuccess: async () => {
      // Both: the drawer shows this file's state and the list behind it shows
      // the same state in a row.
      await client.invalidateQueries({ queryKey: [...ATTACHMENT_KEY, attachmentId] });
      await client.invalidateQueries({ queryKey: ATTACHMENTS_KEY });
    },
  });

  if (file.isPending) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }
  if (file.error) return <ErrorNotice error={file.error} />;

  const attachment = file.data.attachment;
  const items = file.data.items;
  /**
   * Whether this one can be tried again.
   *
   * Only the two states that produced nothing. A file that already became an
   * item would become a second one, and one a worker is holding is not
   * somebody's to take back.
   */
  const rereadable =
    attachment.extraction_state === 'unsupported' || attachment.extraction_state === 'failed';

  return (
    <div className="grid content-start gap-5 overflow-y-auto p-4">
      <div className="grid gap-1.5">
        <p className="font-medium break-all">{attachment.filename}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={toneOf(attachment.extraction_state)}>
            {t(`files.states.${attachment.extraction_state}`)}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{attachment.media_type}</span>
          <span className="text-xs text-muted-foreground">
            {readableSize(attachment.size_bytes)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('files.added_when', { when: relativeTime(attachment.created_at, i18n.language) })}
        </p>
      </div>

      {/* What the state means, said once rather than left to be inferred from a
          badge. `unsupported` in particular is an answer and not a problem. */}
      <p className="text-sm text-muted-foreground">
        {t(`files.explained.${attachment.extraction_state}`)}
      </p>
      {attachment.extraction_error && (
        <p className="text-sm break-words text-destructive">
          {t('files.error', { error: attachment.extraction_error })}
        </p>
      )}
      {rereadable && (
        <div className="grid justify-items-start gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => reread.mutate()}
            disabled={reread.isPending}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t('files.reread')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('files.reread_hint')}</p>
        </div>
      )}
      <ErrorNotice error={reread.error} />

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t('files.made_from_this')}</h3>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('files.nothing_yet')}</p>
        ) : (
          <ul className="grid gap-2">
            {items.map((item) => (
              <li key={item.id}>
                {/* A link and not an id: the whole point of recording where
                    knowledge came from is that somebody can go and read it. */}
                <Link
                  to={`/knowledge?item=${item.id}`}
                  className="text-sm underline-offset-4 hover:underline"
                >
                  {item.title}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t(`knowledge.types.${item.type}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t('files.original')}</h3>
        <p className="text-sm text-muted-foreground">{t('files.original_hint')}</p>
        {attachment.original_uri && (
          <p className="font-mono text-xs break-all text-muted-foreground">
            {attachment.original_uri}
          </p>
        )}
        <Button asChild variant="outline" size="sm" className="w-fit">
          {/* An ordinary link, so the browser's own download does the work and a
              large file is never held in a tab's memory. */}
          <a href={adminApi.attachments.downloadUrl(attachment.id)} download={attachment.filename}>
            <Download aria-hidden="true" className="size-4" />
            {t('files.download')}
          </a>
        </Button>
        <p className="font-mono text-xs break-all text-muted-foreground">
          {attachment.content_hash}
        </p>
      </div>
    </div>
  );
}
