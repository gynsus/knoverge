import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/** The top of one settings section: where it is, and the way back out. */
export function SettingsHeader({ title, intro }: { title: string; intro: string }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5">
      <Link
        to="/settings"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        {t('settings.title')}
      </Link>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">{intro}</p>
    </div>
  );
}
