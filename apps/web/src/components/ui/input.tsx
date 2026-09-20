import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs transition-colors',
        'placeholder:text-muted-foreground focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
