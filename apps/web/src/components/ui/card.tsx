import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      // A shadow as well as a border: the card's fill differs from the page's
      // by 1.04:1, so the border is otherwise the only thing separating them.
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4 sm:p-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg font-semibold leading-none', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

/**
 * The body of a card that has a `CardHeader` above it.
 *
 * `pt-0` is why: the header already carries the space at the top, and two lots
 * of it would open a gap between a title and the thing it titles. A card with
 * no header does not want this — and cannot simply pass `p-5` to undo it,
 * because that overrides `pt-0` and leaves `sm:pt-0` standing, so the padding
 * is right on a phone and gone on everything wider. Such a card uses its own
 * padded element instead.
 */
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0 sm:p-6 sm:pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center gap-2 p-4 pt-0 sm:p-6 sm:pt-0', className)} {...props} />
  );
}
