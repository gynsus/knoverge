import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '../auth/use-auth.ts';
import { StatusPage } from './StatusPage.tsx';

export function HomePage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;
  return (
    <>
      {me && (
        <Card aria-labelledby="workspaces-title">
          <CardHeader>
            <CardTitle id="workspaces-title">{t('home.workspaces')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {me.memberships.map((m) => (
                <li key={m.workspace_id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{m.workspace_name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{m.workspace_slug}</code>
                  <Badge variant="outline">{t(`roles.${m.role}`)}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <StatusPage />
    </>
  );
}
