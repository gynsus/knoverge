import { Route, Routes } from 'react-router';

import { AnonymousOnly, RequireAuth } from './auth/guards.tsx';
import { AppShell } from './components/AppShell.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { PolicyPage } from './pages/PolicyPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import { TaxonomyPage } from './pages/TaxonomyPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';

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
          <Route path="/taxonomy" element={<TaxonomyPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
