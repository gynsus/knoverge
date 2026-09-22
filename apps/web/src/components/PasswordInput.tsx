import { Eye, EyeOff, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyToClipboard, generatePassword } from '@/lib/password';

export interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Told what happened, and whether it went well. */
  onNotice: (message: string, tone: 'status' | 'error') => void;
  /** Set by `Field`, which is why this forwards both rather than spreading. */
  id?: string;
  'aria-describedby'?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  /** Icon only, for a row that has no width to spare. */
  compact?: boolean;
}

/**
 * A password somebody can generate, read and copy.
 *
 * `Field` clones its child to attach the label's id, so this takes `id` and
 * `aria-describedby` and passes them to the input rather than to the wrapper
 * around it — a wrapper carrying the id leaves the label pointing at a div
 * and the field unlabelled.
 *
 * Generating reveals as well as copies. A password put on the clipboard and
 * hidden is one the person has no way to check they still have, and the
 * first thing they would do is press the eye anyway.
 */
export function PasswordInput({
  value,
  onChange,
  onNotice,
  id,
  'aria-describedby': describedBy,
  required,
  minLength,
  autoComplete,
  compact = false,
}: PasswordInputProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  const generate = async () => {
    const password = generatePassword();
    onChange(password);
    setVisible(true);
    const ok = await copyToClipboard(password);
    onNotice(
      ok ? t('password.generated_copied') : t('password.generated_not_copied'),
      ok ? 'status' : 'error',
    );
  };

  const toggle = async () => {
    const next = !visible;
    setVisible(next);
    // Revealing copies too, which is what was asked for: the reason to look
    // at a password is almost always to put it somewhere else.
    if (next && value !== '') {
      const ok = await copyToClipboard(value);
      onNotice(ok ? t('password.copied') : t('password.copy_failed'), ok ? 'status' : 'error');
    }
  };

  return (
    // Wraps rather than squeezing: at phone width the two buttons would
    // leave the field too narrow to read a generated password in, and a
    // password nobody can read is the one thing this control must not be.
    <div className="flex flex-wrap items-center gap-2">
      <Input
        id={id}
        aria-describedby={describedBy}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        className="min-w-48 flex-1 font-mono"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => void toggle()}
        aria-label={visible ? t('password.hide') : t('password.show')}
        aria-pressed={visible}
        title={visible ? t('password.hide') : t('password.show')}
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="outline"
        {...(compact ? { size: 'icon' as const } : {})}
        onClick={() => void generate()}
        // Named either way: without the label showing, the icon alone is what
        // a screen reader would have to guess at.
        aria-label={t('password.generate')}
        title={t('password.generate')}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        {!compact && t('password.generate')}
      </Button>
    </div>
  );
}
