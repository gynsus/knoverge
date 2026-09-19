import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from './use-auth.ts';

/** Routes that need a signed-in user. Redirects to setup or login otherwise. */
export function RequireAuth() {
  const { t } = useTranslation();
  const auth = useAuth();
  const location = useLocation();
  switch (auth.state.kind) {
    case 'loading':
      return <p role="status">{t('common.loading')}</p>;
    case 'setup':
      return <Navigate to="/setup" replace />;
    case 'anonymous':
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    case 'error':
      return <p role="alert">{t('errors.NETWORK')}</p>;
    case 'authenticated':
      return <Outlet />;
  }
}

/** Login and setup pages: send signed-in users home and keep setup one-time. */
export function AnonymousOnly({ page }: { page: 'login' | 'setup' }) {
  const { t } = useTranslation();
  const auth = useAuth();
  switch (auth.state.kind) {
    case 'loading':
      return <p role="status">{t('common.loading')}</p>;
    case 'authenticated':
      return <Navigate to="/" replace />;
    case 'setup':
      return page === 'setup' ? <Outlet /> : <Navigate to="/setup" replace />;
    case 'anonymous':
      return page === 'login' ? <Outlet /> : <Navigate to="/login" replace />;
    case 'error':
      return <p role="alert">{t('errors.NETWORK')}</p>;
  }
}
