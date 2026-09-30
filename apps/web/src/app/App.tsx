import { useEffect, type FC } from 'react';
import { Route, Routes } from 'react-router-dom';
import { watchSystemTheme } from '../hooks/themeStore';
import { AdminPage } from '../pages/AdminPage';
import { ContractDocumentPage } from '../pages/contracts/ContractDocumentPage';
import { ContractPage } from '../pages/contracts/ContractPage';
import { ContractsPage } from '../pages/contracts/ContractsPage';
import { DocumentPage } from '../pages/DocumentPage';
import { EvidenceViewer } from '../pages/evidence/EvidenceViewer';
import { ImportBatchPage } from '../pages/ImportBatchPage';
import { LoginPage } from '../pages/LoginPage';
import { MailboxPage } from '../pages/mail/MailboxPage';
import { MailMessagePage } from '../pages/mail/MailMessagePage';
import { MailPage } from '../pages/mail/MailPage';
import { NegotiationSessionPage } from '../pages/communications/NegotiationSessionPage';
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
            <Route path="contracts" element={<ContractsPage />} />
            <Route path="contracts/:contractId" element={<ContractPage />} />
            <Route path="contract-documents/:documentId" element={<ContractDocumentPage />} />
            <Route path="mail" element={<MailPage />} />
            <Route path="mailboxes/:mailboxId" element={<MailboxPage />} />
            <Route path="mail-messages/:messageId" element={<MailMessagePage />} />
            <Route path="negotiation-sessions/:sessionId" element={<NegotiationSessionPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
};
