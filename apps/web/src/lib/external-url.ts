/**
 * Whether a string is something a browser should be asked to open.
 *
 * `http` and `https` and nothing else. These strings come from agents, and a
 * `javascript:` or `data:` href is a script somebody else wrote running on
 * this page — the same reason knowledge is rendered and never becomes HTML
 * (WEB_UI.md rule 2c). Anything that fails here stays text, which is still
 * readable and still copyable.
 */
export function isOpenable(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    return /^https?:$/u.test(new URL(value).protocol);
  } catch {
    // Not a URL at all: a repository path, a ticket number, a file name.
    return false;
  }
}
