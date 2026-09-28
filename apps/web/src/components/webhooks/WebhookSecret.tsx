import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
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
import { copyToClipboard } from '@/lib/password';

/**
 * What a receiver does with the secret, ready to paste.
 *
 * The timestamp is inside the signed material rather than beside it, so a body
 * captured today cannot be replayed tomorrow with its signature intact, and the
 * comparison is over digests rather than strings. Both are easy to get wrong and
 * neither is guessable from the header names alone, which is why this is here
 * and not only in the documentation.
 */
function verifier(secret: string): string {
  return `import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = '${secret}';

// body is the raw request body, before any JSON parsing.
export function verify(headers, body) {
  const expected =
    'sha256=' +
    createHmac('sha256', SECRET)
      .update(\`\${headers['x-knoverge-timestamp']}.\${body}\`)
      .digest('hex');
  const given = headers['x-knoverge-signature'] ?? '';
  return (
    expected.length === given.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(given))
  );
}`;
}

/**
 * The one moment the signing secret exists.
 *
 * Sealed at rest and never served back, like an agent's token — so this dialog
 * is not dismissed by a stray click past it, and the button that closes it waits
 * until somebody says they have the secret.
 */
export function WebhookSecret({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState<'secret' | 'code' | null>(null);

  const copy = (what: 'secret' | 'code', text: string) => {
    void copyToClipboard(text).then((ok) => setCopied(ok ? what : null));
  };

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="sm:max-w-xl" dismissable={false}>
        <DialogHeader>
          <DialogTitle>{t('webhooks.secret_title')}</DialogTitle>
          <DialogDescription>{t('webhooks.secret_once')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3">
            <code className="min-w-0 flex-1 text-xs break-all">{secret}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copy('secret', secret)}
            >
              {copied === 'secret' ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
              {t('webhooks.copy_secret')}
            </Button>
          </div>

          <div className="grid gap-2">
            <h4 className="text-sm font-medium">{t('webhooks.verify_title')}</h4>
            <p className="text-sm text-muted-foreground">{t('webhooks.verify_intro')}</p>
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
              {verifier(secret)}
            </pre>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => copy('code', verifier(secret))}
            >
              {copied === 'code' ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
              {t('webhooks.copy_verifier')}
            </Button>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={kept} onCheckedChange={(next) => setKept(next === true)} />
            {t('webhooks.secret_kept')}
          </label>
          <DialogFooter>
            <Button type="button" onClick={onClose} disabled={!kept}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
