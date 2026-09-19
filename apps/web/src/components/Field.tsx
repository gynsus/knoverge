import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

/** A labelled control with an optional hint that stays out of the accessible name. */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <p className="field">
      <label>
        {label}
        {children}
      </label>
      {hint && <small>{hint}</small>}
    </p>
  );
}
