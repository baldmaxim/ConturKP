import { useEffect, type FC } from 'react';
import { Route, Routes } from 'react-router-dom';
import { watchSystemTheme } from '../hooks/themeStore';
import { AdminPage } from '../pages/AdminPage';
import { DocumentPage } from '../pages/DocumentPage';
import { EvidenceViewer } from '../pages/evidence/EvidenceViewer';
import { ImportBatchPage } from '../pages/ImportBatchPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { StagePage } from '../pages/StagePage';
import { TenderPage } from '../pages/TenderPage';
import { TendersPage } from '../pages/TendersPage';
import { AppLayout } from './AppLayout';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './RequireAuth';
import { ToastProvider } from './ToastProvider';
import { UpdateBanner } from './UpdateBanner';

export const App: FC = () => {
  useEffect(() => watchSystemTheme(), []);

  return (
    <ToastProvider>
      <AuthProvider>
        <UpdateBanner />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<TendersPage />} />
            <Route path="tenders/:tenderId" element={<TenderPage />} />
            <Route path="stages/:stageId" element={<StagePage />} />
            <Route path="imports/:importId" element={<ImportBatchPage />} />
            <Route path="documents/:documentId" element={<DocumentPage />} />
            <Route path="evidence/:fragmentId" element={<EvidenceViewer />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
};
