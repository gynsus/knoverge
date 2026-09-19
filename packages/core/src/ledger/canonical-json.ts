/**
 * Canonical JSON (RFC 8785, JSON Canonicalization Scheme) for hashing.
 * Object keys are sorted by UTF-16 code units, whitespace is omitted, undefined
 * becomes null, Dates become RFC 3339 strings. Number and string serialisation
 * follow JSON.stringify, which matches the scheme for finite numbers.
 */
export function canonicalJson(value: unknown): string {
  return serialize(normalize(value));
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function normalize(value: unknown): Json {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('canonical JSON cannot encode non-finite numbers');
    return value;
  }
  if (typeof value === 'bigint') throw new TypeError('canonical JSON cannot encode bigint');
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

function compareCodeUnits(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function serialize(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  return `{${Object.keys(value)
    .map((k) => `${JSON.stringify(k)}:${serialize(value[k] as Json)}`)
    .join(',')}}`;
}
