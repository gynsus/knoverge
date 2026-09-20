import { useTranslation } from 'react-i18next';

import { ApiRequestError } from '../api/client.ts';

/** Renders an API error through the catalogue by error code, with a generic fallback. */
export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const key = error instanceof ApiRequestError ? `errors.${error.code}` : 'errors.NETWORK';
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {t(key, { defaultValue: t('errors.UNKNOWN') })}
    </p>
  );
}
