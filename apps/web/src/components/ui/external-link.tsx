import { ExternalLink as Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * Somewhere outside this application, opened in a tab of its own.
 *
 * `noopener` is not a nicety: without it the page that opens gets a handle on
 * this one and can navigate it. `nofollow` because these addresses are given
 * by agents and a knowledge base is not a place to lend authority from.
 *
 * Leaving the application is announced. A link that silently replaces or adds
 * a window is the surprise WCAG 3.2.5 is about, and the icon alone says it
 * only to people who can see it.
 */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn(
        'inline-flex min-w-0 items-baseline gap-1 break-all underline underline-offset-2',
        'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      <span className="min-w-0 break-all">{children}</span>
      <Icon aria-hidden="true" className="size-3 shrink-0 translate-y-0.5" />
      <span className="sr-only">{t('common.opens_elsewhere')}</span>
    </a>
  );
}
