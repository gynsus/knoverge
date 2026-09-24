import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '../src/components/knowledge/Markdown.tsx';

/**
 * The body of an item is written by people and by agents. What matters is not
 * how it looks but what it is allowed to become.
 */
describe('rendering knowledge', () => {
  it('renders what Markdown means', () => {
    const { container } = render(
      <Markdown>
        {'## Heading\n\nA paragraph with `code` and **weight**.\n\n- one\n- two'}
      </Markdown>,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Heading');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('does not let an item become HTML', () => {
    // An agent writes the body. A renderer that parsed raw HTML would let one
    // put a script tag in a page a person is reading, and no amount of
    // sanitising afterwards is as good as never parsing it.
    const { container } = render(
      <Markdown>{'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'}</Markdown>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('refuses a link that is not a link', () => {
    render(<Markdown>{'[press me](javascript:alert(1))'}</Markdown>);
    const link = screen.getByText('press me').closest('a');
    // The protocol never reaches the document.
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('gives an ordinary link no handle on this page', () => {
    render(<Markdown>{'[the spec](https://example.com/spec)'}</Markdown>);
    const link = screen.getByText('the spec').closest('a');
    expect(link).toHaveAttribute('href', 'https://example.com/spec');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
