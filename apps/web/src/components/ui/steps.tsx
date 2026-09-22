import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface StepsProps {
  /** One label per step, in order. */
  labels: readonly string[];
  /** Which step is open, counting from zero. */
  current: number;
  className?: string;
}

/**
 * Where somebody is in a short sequence, and how much is left.
 *
 * An ordered list, so a screen reader hears it as one: three items, the
 * current one marked with `aria-current`. A row of coloured circles with no
 * structure is a picture of progress rather than a statement of it.
 *
 * The labels are visible from the small breakpoint up. On a phone they would
 * wrap the row into something unreadable, so the numbers carry it there and
 * the heading of the step itself says what it is.
 */
export function Steps({ labels, current, className }: StepsProps) {
  const { t } = useTranslation();
  return (
    <ol
      aria-label={t('setup.steps_label')}
      className={cn('flex items-center gap-2 sm:gap-3', className)}
    >
      {labels.map((label, index) => {
        const done = index < current;
        const here = index === current;
        return (
          <li
            key={label}
            {...(here ? { 'aria-current': 'step' as const } : {})}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium',
                done && 'border-primary bg-primary text-primary-foreground',
                here && 'border-primary text-primary',
                !done && !here && 'border-border text-muted-foreground',
              )}
            >
              {done ? <Check className="size-4" /> : index + 1}
            </span>
            <span
              className={cn(
                'hidden truncate text-sm sm:inline',
                here ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {/* The gap between one step and the next, which is what makes a
                row of numbers read as a sequence rather than a set. */}
            {index < labels.length - 1 && (
              <span
                aria-hidden="true"
                className={cn('h-px flex-1', done ? 'bg-primary' : 'bg-border')}
              />
            )}
            <span className="sr-only">
              {done ? t('setup.step_done') : here ? t('setup.step_here') : t('setup.step_ahead')}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
