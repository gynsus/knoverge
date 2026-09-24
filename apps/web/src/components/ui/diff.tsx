import { cn } from '@/lib/utils';

/**
 * A patch, rendered.
 *
 * Two screens show a change — a proposal against what an item says now, and a
 * revision against the one before it — and the colours a diff uses mean
 * something: `--added` and `--removed` are tokens for that reason, and both
 * screens read them here rather than each carrying its own copy.
 */
export function Patch({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
      {text.split('\n').map((line, index) => (
        <div key={index} className={cn(lineTone(line))}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

/**
 * Which side of the change a line is on.
 *
 * `+++` and `---` are a unified diff's file headers, not content, so they are
 * neither added nor removed.
 */
function lineTone(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-removed';
  return 'text-muted-foreground';
}

/**
 * One value becoming another.
 *
 * For the fields that are values rather than prose — a category, a tag, a
 * type — where a patch would be a strange way to say "this became that".
 */
export function WasNow({ label, was, now }: { label: string; was: string; now: string }) {
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      <span className="text-removed line-through">{was || '—'}</span>
      <span aria-hidden="true"> → </span>
      <span className="text-added">{now || '—'}</span>
    </p>
  );
}
