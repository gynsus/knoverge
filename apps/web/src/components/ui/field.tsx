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
 *
 * The child may be a component rather than an element, in which case it has to
 * forward `id` and `aria-describedby` to the control it renders. One that
 * swallows them leaves the label pointing at nothing and the hint unannounced,
 * and nothing about the rendered page says so.
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

export interface FieldSetProps {
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A group of fields with no subheading of its own, used where the card's or
 * dialog's title already names the section. That is most of them, and it is
 * the one to reach for by default: a legend repeating the title above it puts
 * the same words twice in a row and tells the reader nothing the first did not.
 *
 * It exists so the layout is written once: the same class list repeated at
 * every form is the thing that drifts.
 *
 * The width cap is here for the same reason. A card fills the content area, so
 * an uncapped text field is as wide as the monitor, and a line that long is
 * hard to read and absurd to type a name into.
 */
export function FieldSet({ disabled, className, children }: FieldSetProps) {
  return (
    <fieldset disabled={disabled} className={cn('grid max-w-md gap-4 border-0 p-0', className)}>
      {children}
    </fieldset>
  );
}

export interface FieldGroupProps {
  /** The subheading for this group of fields. */
  legend: string;
  /**
   * Applied to the legend, for a group whose name is already drawn nearby.
   *
   * `sm:sr-only` is what a step in a wizard passes: the step indicator shows
   * the labels from `sm` up and hides them below it, so the legend is drawn
   * exactly where the indicator is not showing the same words. It stays in the
   * accessibility tree at every width, because a fieldset that names itself
   * only on a phone is a fieldset with no name on a laptop.
   */
  legendClassName?: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A group of fields under a subheading.
 *
 * The heading and the spacing live here rather than at each call site, so a
 * group added later cannot end up looking like a different kind of thing. A
 * legend takes no part in the grid's gap, which is why its spacing is its own:
 * relying on the gap left it sitting against the first field's label.
 */
export function FieldGroup({
  legend,
  legendClassName,
  disabled,
  className,
  children,
}: FieldGroupProps) {
  return (
    <fieldset disabled={disabled} className={cn('grid max-w-md gap-4 border-0 p-0', className)}>
      <legend className={cn('mb-3 text-base font-semibold', legendClassName)}>{legend}</legend>
      {children}
    </fieldset>
  );
}
