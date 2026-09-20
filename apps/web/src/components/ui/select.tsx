import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The platform's own select.
 *
 * shadcn/ui ships a Radix listbox, and it is the right choice where a plain
 * select cannot do the job. For a short list of values it is not: a native
 * select is what a phone opens as a wheel, what a screen reader already knows,
 * and what keeps working with no JavaScript running.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs transition-colors',
        'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
