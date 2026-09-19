import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/use-auth.ts';
import { StatusPage } from './StatusPage.tsx';

export function HomePage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;
  return (
    <>
      {me && (
        <section className="card" aria-labelledby="workspaces-title">
          <h2 id="workspaces-title">{t('home.workspaces')}</h2>
          <ul>
            {me.memberships.map((m) => (
              <li key={m.workspace_id}>
                {m.workspace_name} <code>{m.workspace_slug}</code> — {t(`roles.${m.role}`)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <StatusPage />
    </>
  );
}
