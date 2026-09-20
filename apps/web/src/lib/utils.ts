import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and lets a later one win over an earlier one.
 *
 * This is the helper every shadcn/ui component expects, which is what keeps
 * components added later with the generator working without edits.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
