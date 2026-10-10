import type {
  BackupAuthKind,
  BackupSettings,
  SaveBackupSettingsRequest,
} from '@knoverge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { BACKUPS_KEY, BACKUP_SETTINGS_KEY } from '@/lib/query-keys';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * The whole setting, in one form with one button.
 *
 * Not three forms. `backups.save` takes the schedule, the window and the target
 * together on purpose: they are read together, and a half-applied change to
 * them is a copy going somewhere nobody meant. The form that sends them has to
 * be the same shape as the call, or the screen promises a granularity the
 * server does not have (WEB_UI.md rule 2m).
 */
export function BackupForm({
  settings,
  mayAdminister,
}: {
  settings: BackupSettings;
  mayAdminister: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [intervalHours, setIntervalHours] = useState(String(settings.interval_hours));
  const [retentionDays, setRetentionDays] = useState(String(settings.retention_days));
  const [sending, setSending] = useState(settings.target !== null);
  const [host, setHost] = useState(settings.target?.host ?? '');
  const [port, setPort] = useState(String(settings.target?.port ?? 22));
  const [username, setUsername] = useState(settings.target?.username ?? '');
  const [directory, setDirectory] = useState(settings.target?.directory ?? '');
  const [authKind, setAuthKind] = useState(settings.target?.auth_kind ?? 'private_key');
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);

  /**
   * Whether the stored credential still fits what the form asks for.
   *
   * A key is not a password, so changing the kind means the stored one cannot
   * be kept and the server will refuse without a new one. Said here rather
   * than after the save, which is the difference between a hint and a rejection
   * (WEB_UI.md rule 2m).
   */
  const stored = settings.target_secret_set && settings.target?.auth_kind === authKind;

  const save = useMutation({
    mutationFn: (body: SaveBackupSettingsRequest) => adminApi.backups.save(body),
    onSuccess: async () => {
      // Typed once and never again: what comes back says whether one is stored,
      // never which (ADR 0033).
      setSecret('');
      setSaved(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: BACKUP_SETTINGS_KEY }),
        client.invalidateQueries({ queryKey: BACKUPS_KEY }),
      ]);
    },
  });

  return (
    <form
      className="grid gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.mutate({
          enabled,
          interval_hours: Number(intervalHours),
          retention_days: Number(retentionDays),
          target: sending
            ? {
                host: host.trim(),
                port: Number(port),
                username: username.trim(),
                directory: directory.trim(),
                auth_kind: authKind,
              }
            : null,
          // Omitted when nothing was typed, which is how a port is changed
          // without finding the key again.
          ...(secret === '' ? {} : { target_secret: secret }),
        });
      }}
    >
      <ErrorNotice error={save.error} />

      <section aria-labelledby="schedule-title" className="grid gap-4">
        <div className="grid gap-1.5">
          <h3 id="schedule-title" className="text-lg font-semibold">
            {t('backups.schedule')}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('backups.schedule_hint')}</p>
        </div>
        <FieldSet disabled={!mayAdminister}>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(next) => setEnabled(next === true)}
              disabled={!mayAdminister}
            />
            <span className="grid gap-1">
              <span className="font-medium">{t('backups.enabled')}</span>
              <span className="text-xs text-muted-foreground">{t('backups.enabled_hint')}</span>
            </span>
          </label>
          <Field label={t('backups.interval')} hint={t('backups.interval_hint')}>
            <Input
              type="number"
              min={1}
              max={168}
              required
              value={intervalHours}
              onChange={(event) => setIntervalHours(event.target.value)}
            />
          </Field>
          <Field label={t('backups.retention')} hint={t('backups.retention_hint')}>
            <Input
              type="number"
              min={1}
              max={365}
              required
              value={retentionDays}
              onChange={(event) => setRetentionDays(event.target.value)}
            />
          </Field>
        </FieldSet>
      </section>

      <section aria-labelledby="target-title" className="grid gap-4">
        <div className="grid gap-1.5">
          <h3 id="target-title" className="text-lg font-semibold">
            {t('backups.target')}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('backups.target_hint')}</p>
        </div>
        <FieldSet disabled={!mayAdminister}>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={sending}
              onCheckedChange={(next) => setSending(next === true)}
              disabled={!mayAdminister || !settings.secret_storage_configured}
            />
            <span className="grid gap-1">
              <span className="font-medium">{t('backups.sending')}</span>
              <span className="text-xs text-muted-foreground">{t('backups.sending_hint')}</span>
            </span>
          </label>
          {sending && (
            <>
              <Field label={t('backups.host')}>
                <Input
                  required
                  autoComplete="off"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                />
              </Field>
              <Field label={t('backups.port')}>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </Field>
              <Field label={t('backups.username')}>
                <Input
                  required
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field label={t('backups.directory')} hint={t('backups.directory_hint')}>
                <Input
                  required
                  autoComplete="off"
                  placeholder={t('backups.directory_example')}
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                />
              </Field>
              <Field label={t('backups.auth_kind')} hint={t('backups.auth_kind_hint')}>
                <Select
                  value={authKind}
                  onChange={(event) => setAuthKind(event.target.value as BackupAuthKind)}
                >
                  <option value="private_key">{t('backups.auth_private_key')}</option>
                  <option value="password">{t('backups.auth_password')}</option>
                </Select>
              </Field>
              <Field
                label={authKind === 'private_key' ? t('backups.key') : t('backups.password')}
                hint={stored ? t('backups.secret_stored') : t('backups.secret_needed')}
              >
                {authKind === 'private_key' ? (
                  <Textarea
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={t('backups.key_example')}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                ) : (
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                )}
              </Field>
            </>
          )}
        </FieldSet>
      </section>

      {mayAdminister && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="w-fit" disabled={save.isPending}>
            {save.isPending ? t('common.working') : t('backups.save')}
          </Button>
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('backups.saved')}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
