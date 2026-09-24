import ReactMarkdown from 'react-markdown';

/**
 * Knowledge, rendered.
 *
 * The text comes from agents as often as from people, so the question is not
 * how it looks but what it is allowed to become. `react-markdown` builds React
 * elements rather than an HTML string: there is no `dangerouslySetInnerHTML`
 * anywhere in the path, raw HTML in the source is not parsed unless a plugin
 * is added to do it, and none is. A `<script>` in an item's body is therefore
 * text that says `<script>`.
 *
 * Links are the other way in. The library refuses a URL whose protocol is not
 * one of the safe ones, and anything that survives that opens in a new tab
 * without a handle on this one.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="grid gap-3 text-sm leading-6 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:grid [&_ol]:grid">
      <ReactMarkdown
        components={{
          a: ({ children: text, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline underline-offset-2"
            >
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
