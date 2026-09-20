import { useCallback, useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;

/**
 * Whether the viewport is phone-sized.
 *
 * Subscribed to rather than mirrored into state: the generated hook started as
 * undefined and set state inside an effect, which renders twice on every mount
 * and reports the wrong answer on the first pass.
 */
export function useIsMobile(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    // Nothing renders on a server, so this is only the safety net a stricter
    // build would ask for.
    () => false,
  );
}
