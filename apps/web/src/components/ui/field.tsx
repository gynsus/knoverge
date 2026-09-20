import { Label } from 'radix-ui';
import { cloneElement, isValidElement, useId, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface FieldProps {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A labelled control with an optional hint.
 *
 * The hint sits outside the label so it stays out of the accessible name, and
 * is tied to the control with aria-describedby so it is still announced. A hint
 * only sighted readers get is half a hint.
 */
export function Field({ label, hint, className, children }: FieldProps) {
  const controlId = useId();
  const hintId = useId();
  const described = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, {
        id: children.props.id ?? controlId,
        ...(hint
          ? {
              'aria-describedby': [children.props['aria-describedby'], hintId]
                .filter(Boolean)
                .join(' '),
            }
          : {}),
      })
    : children;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label.Root htmlFor={controlId} className="text-sm font-medium">
        {label}
      </Label.Root>
      {described}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
