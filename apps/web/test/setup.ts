import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * jsdom implements no media queries, and the sidebar asks whether the viewport
 * is a phone. The stub answers from the window width jsdom does report, which
 * is 1024 by default, so tests see the wide layout unless they say otherwise.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = max ? window.innerWidth <= Number(max[1]) : false;
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

afterEach(() => {
  cleanup();
});
