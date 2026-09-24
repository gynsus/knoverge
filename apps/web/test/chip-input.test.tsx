import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { ChipInput } from '../src/components/ui/chip-input.tsx';
import { createI18n } from '../src/i18n.ts';

function Harness({ initial = '', suggestions }: { initial?: string; suggestions?: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <I18nextProvider i18n={createI18n('en')}>
      <ChipInput
        label="Tags"
        value={value}
        onChange={setValue}
        {...(suggestions ? { suggestions } : {})}
      />
      <output>{value}</output>
    </I18nextProvider>
  );
}

describe('entering a list of short values', () => {
  it('shows what is already there as chips', () => {
    render(<Harness initial="git, portability" />);
    expect(screen.getByText('git')).toBeInTheDocument();
    expect(screen.getByText('portability')).toBeInTheDocument();
  });

  it('commits on Enter and on a comma', async () => {
    // Comma as well, so somebody who learned the old box keeps working.
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByLabelText('Tags');
    await user.type(box, 'machine learning{Enter}');
    await user.type(box, 'вторая тема,');
    // A tag may contain a space (ADR 0019), which is exactly why the old
    // comma-separated box stopped being good enough.
    expect(document.querySelector('output')?.textContent).toBe('machine learning, вторая тема');
  });

  it('keeps what was typed and never committed', async () => {
    // Leaving the field is not a decision to throw the word away.
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Tags'), 'unfinished');
    await user.tab();
    expect(document.querySelector('output')?.textContent).toBe('unfinished');
  });

  it('ignores the same value twice', async () => {
    const user = userEvent.setup();
    render(<Harness initial="git" />);
    await user.type(screen.getByLabelText('Tags'), 'git{Enter}');
    expect(document.querySelector('output')?.textContent).toBe('git');
  });

  it('takes one back with Backspace on an empty box', async () => {
    const user = userEvent.setup();
    render(<Harness initial="git, portability" />);
    await user.click(screen.getByLabelText('Tags'));
    await user.keyboard('{Backspace}');
    expect(document.querySelector('output')?.textContent).toBe('git');
  });

  it('removes one by its own button, named for a screen reader', async () => {
    const user = userEvent.setup();
    render(<Harness initial="git, portability" />);
    await user.click(screen.getByRole('button', { name: 'Remove git' }));
    expect(document.querySelector('output')?.textContent).toBe('portability');
  });

  it('offers suggestions without refusing anything else', async () => {
    const user = userEvent.setup();
    render(<Harness suggestions={['architecture', 'architecture/constraints']} />);
    const box = screen.getByLabelText('Tags');
    expect(box).toHaveAttribute('list');
    // A path nobody suggested is still a path the server may know about.
    await user.type(box, 'somewhere/else{Enter}');
    expect(document.querySelector('output')?.textContent).toBe('somewhere/else');
  });
});
