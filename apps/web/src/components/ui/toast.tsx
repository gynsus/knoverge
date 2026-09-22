import { X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/** How long a message stays before it goes on its own. */
const DISMISS_AFTER_MS = 5000;

export interface ToastProps {
  /** The message, or null for nothing on screen. */
  message: string | null;
  /** Called when it dismisses itself, or when somebody dismisses it. */
  onDismiss: () => void;
  /** `error` for something that did not work; `status` otherwise. */
  tone?: 'status' | 'error';
  className?: string;
}

/**
 * A short message about something that just happened.
 *
 * `role="status"` with `aria-live="polite"`, so a screen reader hears it
 * without being interrupted mid-sentence — which is right for "copied" and
 * would be wrong for anything a person has to act on.
 *
 * It dismisses itself after five seconds and can be dismissed sooner. The
 * timer restarts when the message changes, so pressing the same button twice
 * does not leave the second message with the first one's remaining time.
 */
export function Toast({ message, onDismiss, tone = 'status', className }: ToastProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(onDismiss, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (message === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3',
        'rounded-md border px-4 py-3 text-sm shadow-lg sm:left-auto sm:right-4 sm:translate-x-0',
        tone === 'error'
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border bg-popover text-popover-foreground',
        className,
      )}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('common.dismiss')}
        className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
