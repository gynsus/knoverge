import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * How long a `findBy*` waits for the page to catch up.
 *
 * The default is one second. Every page here renders after at least two
 * rounds of mocked fetch and React Query, and on a loaded CI runner one
 * second is not reliably enough: the setup page failed once that way, with an
 * assertion that was correct and a budget that was not. Five seconds is still
 * far below the test timeout, so a genuinely broken page fails as fast as it
 * ever did.
 */
configure({ asyncUtilTimeout: 5000 });

/**
 * jsdom implements no media queries, and the interface asks both whether the
 * viewport is a phone and whether it is wide enough for two columns. The stub
 * answers from the window width jsdom does report, which is 1024 by default,
 * so tests see the wide layout unless they say otherwise.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = max
      ? window.innerWidth <= Number(max[1])
      : min
        ? window.innerWidth >= Number(min[1])
        : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  };
}

/**
 * jsdom implements no ResizeObserver, and Radix measures elements with one.
 * A stub that observes nothing is enough: the tests assert behaviour, not
 * layout, and jsdom reports every box as zero anyway.
 */
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/**
 * jsdom implements no scrolling, and a list that moves under the arrow keys
 * brings the row it lands on into view. A stub that scrolls nothing is enough:
 * the tests assert which row is current, and jsdom has no viewport to scroll.
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

afterEach(() => {
  cleanup();
});
