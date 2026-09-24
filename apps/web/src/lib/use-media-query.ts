import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches, as a value a component can branch on.
 *
 * For the cases where `hidden lg:block` is not enough: a CSS class hides an
 * element and leaves it in the document, so a panel rendered in both places is
 * two of every field, two elements carrying the same id, and two effects
 * fighting over the focus. Where only one copy may exist, the decision has to
 * be made in JavaScript.
 *
 * `useSyncExternalStore` rather than state kept in step by an effect: the
 * browser already holds the answer, and reading it as a store means there is
 * never a render showing the wrong one.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const read = useCallback(
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    [query],
  );
  // The server has no viewport, so it gets the narrow layout rather than an
  // exception. Nothing renders on a server today; this keeps it honest.
  return useSyncExternalStore(subscribe, read, () => false);
}
