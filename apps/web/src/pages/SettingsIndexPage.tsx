import { Bot, Database, Network, Server, ShieldCheck, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card';

/**
 * One section of the settings, as the catalogue shows it.
 *
 * `to` is absent for a section that exists in the plan and not yet in the
 * product. It is shown rather than hidden on purpose: somebody looking for
 * where backups are configured should find out that the answer is "not yet"
 * rather than conclude they are looking in the wrong place.
 */
interface Section {
  key: string;
  icon: LucideIcon;
  to?: string;
}

/** What belongs to the person, and what belongs to the installation. */
const PERSONAL: Section[] = [
  { key: 'account', icon: UserRound, to: '/settings/account' },
  { key: 'security', icon: ShieldCheck, to: '/settings/security' },
];

const INSTANCE: Section[] = [
  { key: 'ai', icon: Bot },
  { key: 'storage', icon: Database },
  { key: 'network', icon: Network },
  { key: 'system', icon: Server },
];

/**
 * Settings, as a catalogue rather than a scroll.
 *
 * The split is by whose settings they are: a person's account, and the
 * installation's. Keeping the two apart from the start is what stops the page
 * becoming one long canvas again — and it is also the boundary that matters,
 * because one of them is the same on every workspace and the other is not.
 *
 * A workspace's own settings are deliberately not here. They live with the
 * workspace, which is the thing they belong to.
 */
export function SettingsIndexPage() {
  const { t } = useTranslation();

  return (
    <div className="grid gap-8">
      <div className="grid gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('settings.intro')}</p>
      </div>

      {[
        { heading: t('settings.group_personal'), sections: PERSONAL },
        { heading: t('settings.group_instance'), sections: INSTANCE },
      ].map((group) => (
        <section key={group.heading} className="grid gap-3">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.heading}
          </h3>
          <ul className="grid gap-4 md:grid-cols-2">
            {group.sections.map((section) => (
              <li key={section.key} className="grid">
                <SectionCard section={section} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SectionCard({ section }: { section: Section }) {
  const { t } = useTranslation();
  const Icon = section.icon;
  const title = t(`settings.sections.${section.key}.title`);
  const description = t(`settings.sections.${section.key}.description`);

  const body = (
    <CardContent className="flex items-start gap-3 p-5">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      </span>
      <div className="grid min-w-0 gap-1">
        <CardTitle className="flex items-center gap-2 text-base">
          {title}
          {section.to === undefined && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {t('settings.not_yet')}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="leading-5">{description}</CardDescription>
      </div>
    </CardContent>
  );

  if (section.to === undefined) {
    // Not a link and not a disabled button: there is nothing to press, and a
    // control that looks pressable and is not is worse than plain text.
    return <Card className="opacity-60">{body}</Card>;
  }
  return (
    <Card className="group relative transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-foreground/20">
      <Link to={section.to} className="after:absolute after:inset-0 after:content-['']">
        <span className="sr-only">{title}</span>
      </Link>
      {body}
    </Card>
  );
}
