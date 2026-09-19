import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/index.ts';

describe('canonicalJson', () => {
  it('sorts keys recursively and omits whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('normalises undefined to null and dates to RFC 3339', () => {
    expect(canonicalJson({ a: undefined, b: new Date('2026-09-19T09:20:00.000Z') })).toBe(
      '{"a":null,"b":"2026-09-19T09:20:00.000Z"}',
    );
  });

  it('is stable regardless of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('orders keys by UTF-16 code units', () => {
    expect(canonicalJson({ é: 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
  });

  it('rejects values that have no canonical form', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});
