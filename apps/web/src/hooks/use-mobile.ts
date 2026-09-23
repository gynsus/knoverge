import { useCallback, useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;

/** Tailwind's `lg`, where the taxonomy gains a column for the detail panel. */
export const LARGE_BREAKPOINT = 1024;

/**
 * Whether the viewport is narrower than a breakpoint.
 *
 * Subscribed to rather than mirrored into state: the generated hook started as
 * undefined and set state inside an effect, which renders twice on every mount
 * and reports the wrong answer on the first pass.
 *
 * Asked in JavaScript rather than answered with a CSS class, because some
 * things cannot be hidden. A dialog hidden with `lg:hidden` still renders its
 * overlay through a portal the class never reaches, still traps focus, and
 * still locks the page's scrolling — all of it invisibly.
 */
export function useBelow(breakpoint: number): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const query = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    [breakpoint],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth < breakpoint,
    // Nothing renders on a server, so this is only the safety net a stricter
    // build would ask for.
    () => false,
  );
}

/** Whether the viewport is phone-sized. */
export function useIsMobile(): boolean {
  return useBelow(MOBILE_BREAKPOINT);
}
