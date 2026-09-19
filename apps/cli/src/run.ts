import { DomainError } from '@knoverge/core';

import { createServices } from './services.ts';

export type Services = ReturnType<typeof createServices>;

/**
 * Runs a command with the services open, and reports a failure the same way
 * whichever command it came from.
 *
 * Every command used to carry its own copy of this, and they disagreed: two set
 * an exit code, two threw into the entry point, and one caught nothing. The
 * entry point exits immediately after writing to stderr, which can truncate it
 * when the output is a pipe.
 */
export async function withServices(fn: (services: Services) => Promise<void>): Promise<void> {
  const services = createServices();
  try {
    await fn(services);
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(`${err.code}: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exitCode = 1;
  } finally {
    await services.close();
  }
}

/**
 * Parses a value that came from the command line, reporting what was expected
 * rather than the schema's own message. A mistyped identifier used to print a
 * page of JSON.
 */
export function parseOrFail<T>(
  schema: { safeParse: (value: string) => { success: true; data: T } | { success: false } },
  value: string,
  expected: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(expected);
  return result.data;
}

/**
 * Writes a result as rows or as JSON.
 *
 * Anything that is not the result goes to stderr: a header or a failure notice
 * mixed into stdout makes the output impossible to read with a script.
 */
export function emit(json: boolean, value: unknown, rows: () => string[]): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const row of rows()) console.log(row);
}

/** Tab-separated field, with the separators that would break it removed. */
export function field(value: string | null | undefined): string {
  return (value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}
