/**
 * A user agent, as somebody would say it out loud.
 *
 * `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 …` is
 * the truth and not the answer: somebody looking at their own sessions is
 * asking which of these is the laptop and which is the phone. The raw string
 * stays available for the case where the guess is wrong.
 *
 * Deliberately crude. Getting this exactly right needs a table somebody
 * maintains, and being wrong costs a line that reads "Unknown browser" beside
 * a date that is still correct.
 */
export interface Client {
  browser: string | null;
  platform: string | null;
}

export function readUserAgent(value: string | null): Client {
  if (!value) return { browser: null, platform: null };
  return { browser: browserOf(value), platform: platformOf(value) };
}

function browserOf(ua: string): string | null {
  // Order matters: Edge and Chrome both say Chrome, and Chrome says Safari.
  for (const [name, pattern] of [
    ['Edge', /Edg\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Firefox', /Firefox\/(\d+)/],
    ['Chrome', /Chrome\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari/],
  ] as const) {
    const match = pattern.exec(ua);
    if (match) return `${name} ${match[1]}`;
  }
  return null;
}

function platformOf(ua: string): string | null {
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}
