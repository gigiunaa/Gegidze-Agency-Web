import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { MeetingsPage } from './pages/Meetings';
import { MeetingDetailPage } from './pages/MeetingDetail';
import { RecordingPage } from './pages/Recording';
import { SettingsPage } from './pages/Settings';
import { AdminPage } from './pages/Admin';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RoleRoute({ children, roles }: { children: React.ReactNode; roles: string[] }) {
  const user = useAuthStore((s) => s.user);
  if (!user || !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export function App() {
  const loadFromStorage = useAuthStore((s) => s.loadFromStorage);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
      <Route path="/*" element={
        <ProtectedRoute>
          <Layout>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/meetings" element={<MeetingsPage />} />
              <Route path="/meetings/:id" element={<MeetingDetailPage />} />
              <Route path="/recording" element={<RecordingPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/admin" element={
                <RoleRoute roles={['admin']}>
                  <AdminPage />
                </RoleRoute>
              } />
            </Routes>
          </Layout>
        </ProtectedRoute>
      } />
    </Routes>
  );
}
