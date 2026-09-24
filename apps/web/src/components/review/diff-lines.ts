/** Line-by-line, which is what a person reads a change as. */
export function diffLines(
  before: string,
  after: string,
): { mark: ' ' | '-' | '+'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const common = new Set(b);
  const kept = new Set(a.filter((line) => common.has(line)));
  const rows: { mark: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (i < a.length && j < b.length && left === right) {
      rows.push({ mark: ' ', text: left as string });
      i += 1;
      j += 1;
    } else if (i < a.length && !kept.has(left as string)) {
      rows.push({ mark: '-', text: left as string });
      i += 1;
    } else if (j < b.length) {
      rows.push({ mark: '+', text: right as string });
      j += 1;
    } else {
      rows.push({ mark: '-', text: left as string });
      i += 1;
    }
  }
  return rows;
}
