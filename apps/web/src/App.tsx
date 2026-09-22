import { Navigate, Route, Routes } from 'react-router';

import { AnonymousOnly, RequireAuth } from './auth/guards.tsx';
import { AppShell } from './components/AppShell.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { KnowledgePage } from './pages/KnowledgePage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NewWorkspacePage } from './pages/NewWorkspacePage.tsx';
import { PolicyPage } from './pages/PolicyPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import { TaxonomyPage } from './pages/TaxonomyPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import { WorkspacesPage } from './pages/WorkspacesPage.tsx';

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
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/taxonomy" element={<TaxonomyPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/new" element={<NewWorkspacePage />} />
          <Route path="/workspaces/settings" element={<WorkspacePage />} />
          {/* The section was singular until it listed more than one thing.
              Somebody's open tab or bookmark should not become a blank page
              over a rename. */}
          <Route path="/workspace" element={<Navigate to="/workspaces" replace />} />
          <Route path="/workspace/new" element={<Navigate to="/workspaces/new" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
