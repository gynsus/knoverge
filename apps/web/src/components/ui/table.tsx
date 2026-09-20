import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A table on a wide screen, a stack of labelled rows on a narrow one.
 *
 * There is one DOM either way, so a screen reader and a search both see the
 * same content, and the explicit roles keep the table semantics that changing
 * `display` would otherwise throw away. On a phone each cell carries its column
 * heading, which the stylesheet reads from `data-label`, because a column of
 * values with the headings left behind at the top is unreadable.
 *
 * Every cell therefore needs `data-label`, and the value has to come from the
 * message catalogue like any other text a person reads.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <table role="table" className={cn('w-full border-collapse text-sm', className)} {...props} />
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  // Headings are the one thing the narrow layout does not repeat: each cell
  // carries its own.
  return <thead className={cn('max-md:hidden', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn(className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      role="row"
      className={cn(
        'border-b border-border last:border-0',
        'max-md:flex max-md:flex-col max-md:gap-1 max-md:py-3',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'py-2 pr-3 text-left text-xs font-medium text-muted-foreground last:pr-0',
        className,
      )}
      {...props}
    />
  );
}

export type TableCellProps = ComponentProps<'td'> & {
  /** The column heading, shown beside the value on a narrow screen. */
  label: string;
};

export function TableCell({ className, label, ...props }: TableCellProps) {
  return (
    <td
      role="cell"
      data-label={label}
      className={cn(
        'py-2 pr-3 align-top last:pr-0',
        // A flex item refuses to shrink below its content by default, so an
        // unbreakable value — an email, a token prefix, a user agent — pushed
        // the whole page sideways on a phone. It wraps instead.
        'max-md:flex max-md:min-w-0 max-md:flex-wrap max-md:gap-x-2 max-md:break-words max-md:py-0.5',
        // A cell whose content is conditional prints its heading and nothing
        // else. Not on a phone, where the heading is the only thing on the row.
        'max-md:empty:hidden',
        'max-md:before:content-[attr(data-label)] max-md:before:min-w-28 max-md:before:shrink-0 max-md:before:text-xs max-md:before:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The controls inside a cell, laid out as a wrapping row.
 *
 * A table cell is not a flex container, so two adjacent buttons sit with no gap
 * between them; on a phone the cell is a flex row and a confirmation sentence
 * plus two buttons are forced onto one line. Both are the same missing wrapper.
 */
export function TableActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />;
}
