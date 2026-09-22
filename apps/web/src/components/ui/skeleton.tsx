import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A block standing in for something still being fetched.
 *
 * Always `aria-hidden`: it carries no information, and a screen reader
 * announcing eight grey rectangles is worse than silence. The container
 * around a group of them says `role="status"` and names what is loading, so
 * the fact is stated once rather than drawn eight times.
 *
 * `motion-reduce:animate-none` because a pulse is decoration. Somebody who
 * has asked their system for less movement should get a still placeholder,
 * not a slower one.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
