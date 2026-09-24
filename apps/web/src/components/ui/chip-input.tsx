import { X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * A list of short values, entered one at a time.
 *
 * It replaces a text box holding a comma-separated string, which asked
 * somebody to remember a syntax in order to type two words — and got worse
 * when a tag became able to contain a space (ADR 0019), because then the
 * separator was the only thing telling two tags from one.
 *
 * The value stays a comma-separated string so the forms around it are
 * unchanged: what is different is what a person has to do, not what is sent.
 */
export function ChipInput({
  value,
  onChange,
  suggestions,
  label,
  id,
}: {
  /** Comma-separated, as the form holds it. */
  value: string;
  onChange: (value: string) => void;
  /** Offered while typing. Nothing is refused for being absent from it. */
  suggestions?: readonly string[];
  /** Names the box for a screen reader, since the chips are separate. */
  label: string;
  id?: string | undefined;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const listId = useId();
  const chips = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const commit = (entry: string) => {
    const next = entry.trim();
    // Silently ignored rather than shown as an error: adding something twice
    // is a slip, and the list already says it is there.
    if (next === '' || chips.includes(next)) {
      setTyped('');
      return;
    }
    onChange([...chips, next].join(', '));
    setTyped('');
  };

  const remove = (entry: string) => onChange(chips.filter((chip) => chip !== entry).join(', '));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Comma as well as Enter: somebody who learned the old box keeps working.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(typed);
      return;
    }
    // Backspace on an empty box takes back the last one, which is what every
    // other chip input does and what a hand expects.
    if (event.key === 'Backspace' && typed === '' && chips.length > 0) {
      event.preventDefault();
      remove(chips[chips.length - 1] as string);
    }
  };

  return (
    <div
      className={cn(
        'flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5',
        'focus-within:ring-2 focus-within:ring-ring',
      )}
    >
      {chips.map((chip) => (
        <span
          key={chip}
          className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
        >
          {chip}
          <button
            type="button"
            onClick={() => remove(chip)}
            aria-label={t('common.remove_entry', { entry: chip })}
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={typed}
        aria-label={label}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={onKeyDown}
        // What is typed and not committed is still what somebody meant.
        onBlur={() => commit(typed)}
        {...(suggestions?.length ? { list: listId } : {})}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
