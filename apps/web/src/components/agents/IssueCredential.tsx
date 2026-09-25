import type { AgentSummary } from '@knoverge/contracts';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { copyToClipboard } from '@/lib/password';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/** How long a credential may live. Never is a choice, not the only one. */
const LIVES = ['30', '90', '365', 'never'] as const;

/**
 * The configuration a client needs, ready to paste.
 *
 * This is the step that decides whether somebody connects an agent in a
 * minute or goes looking for documentation: the endpoint is this
 * installation's, and the token is the one that was just issued and will
 * never be shown again.
 */
function mcpConfig(name: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          type: 'http',
          url: `${window.location.origin}/mcp`,
          headers: { authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Issuing a credential, and the one moment its secret exists.
 *
 * Two screens, because they are two different things: what to issue, and what
 * was issued. The second cannot be reached again — the token is stored as a
 * hash — so it is not closed by a stray click on the overlay, and the button
 * that closes it waits until somebody says they have the token.
 */
export function IssueCredential({
  agent,
  open,
  onOpenChange,
  onIssued,
}: {
  agent: AgentSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [life, setLife] = useState<(typeof LIVES)[number]>('never');
  const [token, setToken] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState<'token' | 'config' | null>(null);

  const issue = useMutation({
    mutationFn: () =>
      adminApi.agents.issue({
        agent_id: agent.id,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(life === 'never' ? {} : { expires_in_days: Number(life) }),
      }),
    onSuccess: async (answer) => {
      setToken(answer.token);
      await onIssued();
    },
  });

  const close = () => {
    setToken(null);
    setKept(false);
    setLabel('');
    setLife('never');
    issue.reset();
    onOpenChange(false);
  };

  const copy = (what: 'token' | 'config', text: string) => {
    void copyToClipboard(text).then((ok) => setCopied(ok ? what : null));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    issue.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While the token is on screen it is the only copy there will ever
        // be, so it is not dismissed by clicking past it.
        if (!next && token !== null) return;
        if (!next) close();
      }}
    >
      {/* While the token is on screen there is no cross: this is the only
          copy there will ever be, and a cross that refuses reads as broken. */}
      <DialogContent className="sm:max-w-xl" dismissable={token === null}>
        {token === null ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('agents.issue_title')}</DialogTitle>
              <DialogDescription>{t('agents.issue_intro')}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4">
              <FieldSet disabled={issue.isPending} className="max-w-none">
                <Field
                  label={t('agents.credential_label')}
                  hint={t('agents.credential_label_hint')}
                >
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    maxLength={120}
                    autoFocus
                    placeholder={t('agents.credential_label_example')}
                  />
                </Field>
                <Field label={t('agents.expiry')} hint={t('agents.expiry_hint')}>
                  <Select
                    value={life}
                    onChange={(e) => setLife(e.target.value as (typeof LIVES)[number])}
                  >
                    {LIVES.map((value) => (
                      <option key={value} value={value}>
                        {t(`agents.lives.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FieldSet>
              <ErrorNotice error={issue.error} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={issue.isPending}>
                  {issue.isPending ? t('common.working') : t('agents.issue_token')}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('agents.issued_title')}</DialogTitle>
              <DialogDescription>{t('agents.token_once')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3">
                <code className="min-w-0 flex-1 text-xs break-all">{token}</code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy('token', token)}
                >
                  {copied === 'token' ? (
                    <Check aria-hidden="true" className="size-4" />
                  ) : (
                    <Copy aria-hidden="true" className="size-4" />
                  )}
                  {t('agents.copy_token')}
                </Button>
              </div>

              {/* So that registering an agent and connecting one are the same
                  minute, rather than a trip to the documentation. */}
              <div className="grid gap-2">
                <h4 className="text-sm font-medium">{t('agents.connect_title')}</h4>
                <p className="text-sm text-muted-foreground">{t('agents.connect_intro')}</p>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                  {mcpConfig(agent.name, token)}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => copy('config', mcpConfig(agent.name, token))}
                >
                  {copied === 'config' ? (
                    <Check aria-hidden="true" className="size-4" />
                  ) : (
                    <Copy aria-hidden="true" className="size-4" />
                  )}
                  {t('agents.copy_config')}
                </Button>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={kept} onCheckedChange={(next) => setKept(next === true)} />
                {t('agents.token_kept')}
              </label>
              <DialogFooter>
                <Button type="button" onClick={close} disabled={!kept}>
                  {t('common.close')}
                </Button>
              </DialogFooter>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
