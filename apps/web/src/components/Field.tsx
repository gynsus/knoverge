import { cloneElement, isValidElement, useId, type ReactNode } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

/**
 * A labelled control with an optional hint.
 *
 * The hint sits outside the label so it stays out of the accessible name, and
 * is tied to the control with aria-describedby so it is still announced. A hint
 * nobody hears is a hint only sighted readers get.
 */
export function Field({ label, hint, children }: FieldProps) {
  const hintId = useId();
  const described =
    hint && isValidElement<{ 'aria-describedby'?: string }>(children)
      ? cloneElement(children, {
          'aria-describedby': [children.props['aria-describedby'], hintId]
            .filter(Boolean)
            .join(' '),
        })
      : children;
  return (
    <p className="field">
      <label>
        {label}
        {described}
      </label>
      {hint && (
        <small id={hintId} className="hint">
          {hint}
        </small>
      )}
    </p>
  );
}
