import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router';

import { MainSkeleton } from '../components/AppSkeleton.tsx';
import { useAuth } from './use-auth.ts';

/** Routes that need a signed-in user. Redirects to setup or login otherwise. */
export function RequireAuth() {
  const { t } = useTranslation();
  const auth = useAuth();
  const location = useLocation();
  switch (auth.state.kind) {
    case 'loading':
      // The shell answers this case first, so this is a second line rather
      // than the one anybody sees. It is the page area because that is where
      // a guard renders: the chrome around it is already on screen.
      return <MainSkeleton />;
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
      // The shell answers this case first, so this is a second line rather
      // than the one anybody sees. It is the page area because that is where
      // a guard renders: the chrome around it is already on screen.
      return <MainSkeleton />;
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
