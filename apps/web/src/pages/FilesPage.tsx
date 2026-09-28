import type { AttachmentSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, RefreshCw, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ATTACHMENTS_KEY } from '@/lib/query-keys';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { AttachmentDetails } from '../components/files/AttachmentDetails.tsx';
import { readableSize, toneOf } from '../components/files/attachment.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/**
 * Files this workspace holds.
 *
 * Beside the knowledge rather than inside it, because a file is where knowledge
 * came from and not knowledge itself (ADR 0008). What the list is really for is
 * the state: a file is read by a sweep a minute later, and without a screen the
 * only way to find out what became of one was to read the log.
 */
export function FilesPage() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const [params, setParams] = useSearchParams();
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const files = useQuery({
    queryKey: ATTACHMENTS_KEY,
    queryFn: ({ signal }) => adminApi.attachments.list(signal),
  });

  const upload = useMutation({
    mutationFn: (file: File) => adminApi.attachments.upload(file),
    onSuccess: async (answer) => {
      await client.invalidateQueries({ queryKey: ATTACHMENTS_KEY });
      // Straight to the file that was just added, because the question somebody
      // has next is what became of it — and the answer takes a minute to arrive.
      open(answer.attachment.id);
    },
  });

  const reread = useMutation({
    mutationFn: () => adminApi.attachments.reread({}),
    onSuccess: () => client.invalidateQueries({ queryKey: ATTACHMENTS_KEY }),
  });

  const all = files.data?.attachments ?? [];
  const mayWrite = workspaces.can('knowledge.write');
  /**
   * The files a newly connected model might now be able to read.
   *
   * The button only exists when there are some, because the thing it does is
   * only worth offering to somebody who has just changed what this installation
   * can read.
   */
  const unread = all.filter(
    (file) => file.extraction_state === 'unsupported' || file.extraction_state === 'failed',
  );
  const openId = params.get('file');
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('file', id);
    else next.delete('file');
    setParams(next, { replace: true });
  };

  const take = (list: FileList | null) => {
    const file = list?.[0];
    if (file) upload.mutate(file);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (mayWrite) take(event.dataTransfer.files);
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{t('files.title')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('files.intro')}</p>
      </div>

      <ErrorNotice error={files.error ?? upload.error ?? reread.error} />

      {mayWrite && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`grid justify-items-start gap-2 rounded-lg border border-dashed px-4 py-6 transition-colors ${
            dragging ? 'border-primary bg-muted/40' : 'border-border'
          }`}
        >
          <Upload aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('files.drop_hint')}</p>
          <input
            ref={picker}
            type="file"
            className="sr-only"
            aria-label={t('files.choose')}
            onChange={(event) => {
              take(event.target.files);
              // So the same file can be chosen twice: without this the input
              // holds the last one and the second choice raises no event.
              event.target.value = '';
            }}
          />
          <Button onClick={() => picker.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? t('common.working') : t('files.choose')}
          </Button>
        </div>
      )}

      {mayWrite && unread.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => reread.mutate()}
            disabled={reread.isPending}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t('files.reread_all', { count: unread.length })}
          </Button>
          {/* Why somebody would: a model assigned today cannot have read a file
              that arrived last month, and the sweep only looks at new ones. */}
          <p className="text-sm text-muted-foreground">{t('files.reread_hint')}</p>
        </div>
      )}

      {files.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : all.length === 0 ? (
        <div className="grid justify-items-start gap-2 rounded-lg border border-dashed border-border px-4 py-6">
          <Paperclip aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('files.empty')}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('files.file')}</TableHead>
              <TableHead>{t('files.state')}</TableHead>
              <TableHead>{t('files.size')}</TableHead>
              <TableHead>{t('files.added')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {all.map((file) => (
              <Row key={file.id} file={file} onOpen={() => open(file.id)} locale={i18n.language} />
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={openId !== null} onOpenChange={(next) => !next && open(null)}>
        <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{t('files.details')}</SheetTitle>
          </SheetHeader>
          {openId && <AttachmentDetails attachmentId={openId} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Row({
  file,
  onOpen,
  locale,
}: {
  file: AttachmentSummary;
  onOpen: () => void;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <TableRow onClick={onOpen} className="cursor-pointer transition-colors hover:bg-muted/60">
      <TableCell label={t('files.file')}>
        <button
          type="button"
          onClick={(event) => {
            // The row carries the click; this is here so a keyboard reaches the
            // same place, and so the name is what a screen reader lands on.
            event.stopPropagation();
            onOpen();
          }}
          className="text-left font-medium break-all underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {file.filename}
        </button>
        <span className="block font-mono text-xs text-muted-foreground">{file.media_type}</span>
      </TableCell>
      <TableCell label={t('files.state')}>
        <Badge variant={toneOf(file.extraction_state)}>
          {t(`files.states.${file.extraction_state}`)}
        </Badge>
      </TableCell>
      <TableCell label={t('files.size')}>{readableSize(file.size_bytes)}</TableCell>
      <TableCell label={t('files.added')}>{relativeTime(file.created_at, locale)}</TableCell>
    </TableRow>
  );
}
