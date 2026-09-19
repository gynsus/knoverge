import { Route, Routes } from 'react-router';

import { AnonymousOnly, RequireAuth } from './auth/guards.tsx';
import { AppShell } from './components/AppShell.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route element={<AnonymousOnly page="setup" />}>
          <Route path="/setup" element={<SetupPage />} />
        </Route>
        <Route element={<AnonymousOnly page="login" />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route path="/" element={<HomePage />} />
        </Route>
      </Route>
    </Routes>
  );
}
