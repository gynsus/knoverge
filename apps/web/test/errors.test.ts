import { ErrorCode } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import { resources, SUPPORTED_LOCALES } from '../src/i18n.ts';

describe('error catalogue', () => {
  it('translates every error code the API can return', () => {
    // Without this a new code silently renders the generic fallback.
    for (const locale of SUPPORTED_LOCALES) {
      const errors = resources[locale].common.errors as Record<string, string>;
      for (const code of ErrorCode.options) {
        expect(errors[code], `${locale} is missing ${code}`).toBeTruthy();
      }
    }
  });

  it('keeps the generic fallbacks for anything else', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const errors = resources[locale].common.errors as Record<string, string>;
      expect(errors['NETWORK']).toBeTruthy();
      expect(errors['UNKNOWN']).toBeTruthy();
    }
  });
});
