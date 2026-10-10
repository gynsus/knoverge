import type { BackupSettings, BackupSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BACKUPS_KEY, BACKUP_SETTINGS_KEY } from '@/lib/query-keys';
import { readableSize } from '@/lib/readable-size';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { BackupForm } from '../components/backups/BackupForm.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SettingsHeader } from '../components/settings/SettingsHeader.tsx';

/**
 * Whether this installation keeps copies of itself, and where they go.
 *
 * The screen leads with what leaves rather than with the address field, because
 * pointing this at a second machine is a decision about what that machine then
 * holds: the whole database and every workspace repository, which is all of the
 * knowledge (WEB_UI.md rule 2o).
 *
 * It also shows how it is going. The upload is the one part of this that fails
 * for reasons inside somebody else's building, and a screen showing only the
 * address looks the same whether every copy is arriving or none of them are.
 */
export function StorageSettingsPage() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const mayAdminister = workspaces.can('workspace.admin');
  const [forgetting, setForgetting] = useState(false);

  const settings = useQuery({
    queryKey: BACKUP_SETTINGS_KEY,
    queryFn: ({ signal }) => adminApi.backups.settings(signal),
  });
  const copies = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: ({ signal }) => adminApi.backups.list(signal),
  });

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: BACKUP_SETTINGS_KEY }),
      client.invalidateQueries({ queryKey: BACKUPS_KEY }),
    ]);

  const run = useMutation({
    mutationFn: () => adminApi.backups.run(),
    onSuccess: refresh,
  });

  const forget = useMutation({
    mutationFn: () => adminApi.backups.clearHostKey(),
    onSuccess: async () => {
      setForgetting(false);
      await refresh();
    },
  });

  const current = settings.data?.settings;

  return (
    <div className="grid gap-8">
      <SettingsHeader title={t('settings.sections.storage.title')} intro={t('backups.intro')} />

      <ErrorNotice error={settings.error ?? copies.error ?? run.error ?? forget.error} />

      {/* Above the control rather than behind it: a screen that offers a target
          field and then refuses what it produced has wasted somebody's time and
          taught them nothing about their installation (WEB_UI.md rule 2o). */}
      {current !== undefined && !current.secret_storage_configured && (
        <div className="grid gap-1 rounded-lg border border-dashed border-border p-4">
          <p className="text-sm font-medium">{t('backups.no_key_title')}</p>
          <p className="text-sm text-muted-foreground">{t('backups.no_key')}</p>
          <code className="mt-1 w-fit rounded bg-muted px-2 py-1 text-xs">
            KNOVERGE_ENCRYPTION_KEY
          </code>
        </div>
      )}

      {settings.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : current === undefined ? null : (
        <BackupForm settings={current} mayAdminister={mayAdminister} />
      )}

      {current?.target !== null && current !== undefined && (
        <HostKey
          settings={current}
          mayAdminister={mayAdminister}
          onForget={() => setForgetting(true)}
        />
      )}

      <section aria-labelledby="copies-title" className="grid gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1.5">
            <h3 id="copies-title" className="text-lg font-semibold">
              {t('backups.copies')}
            </h3>
            <p className="max-w-2xl text-sm text-muted-foreground">{t('backups.copies_hint')}</p>
          </div>
          {mayAdminister && (
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? t('backups.running') : t('backups.run')}
            </Button>
          )}
        </div>

        {current !== undefined && (
          <LastRun settings={current} any={(copies.data?.backups.length ?? 0) > 0} />
        )}

        {copies.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : (copies.data?.backups.length ?? 0) === 0 ? (
          <div className="grid justify-items-start gap-2 rounded-lg border border-dashed border-border px-4 py-6">
            <Archive aria-hidden="true" className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('backups.copies_empty')}</p>
          </div>
        ) : (
          <ul className="grid gap-3">
            {(copies.data?.backups ?? []).map((copy) => (
              <li key={copy.name}>
                <Copy copy={copy} language={i18n.language} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={forgetting} onOpenChange={(next) => !next && setForgetting(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('backups.forget_title')}</DialogTitle>
            {/* The consequence before the click, and it is not a small one: the
                next copy will go to whatever answers at that address, whoever
                that turns out to be (WEB_UI.md rule 4). */}
            <DialogDescription>{t('backups.forget_effect')}</DialogDescription>
          </DialogHeader>
          <code className="rounded-md border border-border bg-muted/40 p-3 text-xs break-all">
            {current?.target_host_fingerprint}
          </code>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setForgetting(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={forget.isPending}
              onClick={() => forget.mutate()}
            >
              {forget.isPending ? t('common.working') : t('backups.forget')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The key this installation pinned, for an operator to check by eye.
 *
 * Shown because that is the whole point of trust on first use: the product
 * cannot tell a rebuilt machine from somebody in the middle, and a person with
 * shell access to the far end can. The command to compare it with is on the
 * screen, built from the address that was actually saved.
 */
function HostKey({
  settings,
  mayAdminister,
  onForget,
}: {
  settings: BackupSettings;
  mayAdminister: boolean;
  onForget: () => void;
}) {
  const { t } = useTranslation();
  const pinned = settings.target_host_fingerprint;
  const target = settings.target;

  return (
    <section aria-labelledby="host-key-title" className="grid gap-4">
      <div className="grid gap-1.5">
        <h3 id="host-key-title" className="text-lg font-semibold">
          {t('backups.host_key')}
        </h3>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('backups.host_key_hint')}</p>
      </div>
      {pinned === null ? (
        <p className="text-sm text-muted-foreground">{t('backups.host_key_none')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
          <div className="grid min-w-0 gap-2">
            <code className="text-sm break-all">{pinned}</code>
            {target !== null && (
              <code className="w-fit max-w-full rounded bg-muted px-2 py-1 text-xs break-all">
                {`ssh-keyscan -p ${target.port} ${target.host} | ssh-keygen -lf -`}
              </code>
            )}
          </div>
          {mayAdminister && (
            <Button type="button" variant="ghost" size="sm" onClick={onForget}>
              {t('backups.forget')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * How the last run went.
 *
 * Two outcomes rather than one, because the domain has two: a copy that was
 * taken and did not reach the target is a success with a reason beside it. The
 * local copy is a backup, and saying "failed" of it would send an operator
 * looking for a database problem that is not there (ADR 0040).
 */
function LastRun({ settings, any }: { settings: BackupSettings; any: boolean }) {
  const { t, i18n } = useTranslation();
  if (settings.last_run_at === null) {
    // Copies with no recorded run are copies this installation did not take:
    // what the sidecar left behind, and what every installation looks like
    // after an upgrade. The list below speaks for them, and saying "none taken"
    // above three of them is a contradiction a reader has to resolve.
    return any ? null : <p className="text-sm text-muted-foreground">{t('backups.never_run')}</p>;
  }
  return (
    <div className="grid gap-1">
      <p className="text-sm text-muted-foreground">
        {t('backups.last_run', { when: relativeTime(settings.last_run_at, i18n.language) })}
      </p>
      {settings.last_error !== null && (
        // Verbatim. The server keeps it to one line and never a command line,
        // and an error nobody can read is a support ticket rather than an answer.
        <p className="text-sm break-words text-destructive">
          {t('backups.last_error', { error: settings.last_error })}
        </p>
      )}
      {settings.last_upload_error !== null && (
        <p className="text-sm break-words text-destructive">
          {t('backups.last_upload_error', { error: settings.last_upload_error })}
        </p>
      )}
    </div>
  );
}

/** One copy on this machine, and whether it is on the other one too. */
function Copy({ copy, language }: { copy: BackupSummary; language: string }) {
  const { t } = useTranslation();
  // Null is not "no": it is a copy the settings cannot speak for, which is
  // every copy but the last one. A badge saying "not sent" of those would
  // report a problem nobody has.
  const sent =
    copy.uploaded === null ? 'unknown' : copy.uploaded ? ('sent' as const) : ('not_sent' as const);

  return (
    <div className="grid gap-2 rounded-lg border border-border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="grid min-w-0 gap-1">
        <code className="text-sm break-all">{copy.name}</code>
        <p className="text-sm text-muted-foreground">
          {t('backups.taken', {
            when: relativeTime(copy.taken_at, language),
            size: readableSize(copy.size_bytes),
          })}
        </p>
      </div>
      {sent !== 'unknown' && (
        <Badge variant={sent === 'sent' ? 'default' : 'destructive'}>{t(`backups.${sent}`)}</Badge>
      )}
    </div>
  );
}
