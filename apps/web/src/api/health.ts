import { ReadyResponse } from '@knoverge/contracts';

export async function fetchReadiness(signal?: AbortSignal): Promise<ReadyResponse> {
  const res = await fetch('/health/ready', {
    signal: signal ?? null,
    headers: { accept: 'application/json' },
  });
  // 503 still carries a well-formed body describing what failed.
  if (res.status !== 200 && res.status !== 503) {
    throw new Error(`Unexpected status ${res.status}`);
  }
  return ReadyResponse.parse(await res.json());
}
