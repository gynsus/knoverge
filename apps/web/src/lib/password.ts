/**
 * Characters a generated password is built from.
 *
 * `l`, `I`, `O`, `0` and `1` are left out. The password can be revealed, so
 * somebody will read it off a screen or dictate it, and a pair nobody can
 * tell apart costs more than the bit of entropy it carries. What remains is
 * seventy characters, which at the length below is far more than enough.
 */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.!@#$%^&*+=?';

/** Long enough that the alphabet's small gaps cost nothing. */
export const GENERATED_PASSWORD_LENGTH = 24;

/**
 * A random password.
 *
 * `crypto.getRandomValues` rather than `Math.random`, which is not
 * unpredictable and was never meant to be. Values that would fall outside a
 * whole number of alphabet-sized blocks are drawn again rather than folded
 * with a modulo, which would make the first few characters of the alphabet
 * slightly likelier than the rest.
 */
export function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const out: string[] = [];
  const buffer = new Uint8Array(length);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length] as string);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/**
 * Puts text on the clipboard, and says whether it got there.
 *
 * The API needs a secure context and a permission the browser may refuse, so
 * failure is ordinary rather than exceptional: the caller tells the person
 * what happened instead of pretending it worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
