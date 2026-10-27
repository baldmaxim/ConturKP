import type { FC } from 'react';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../hooks/useAuth';
import { OfficePanel } from './admin/office/OfficePanel';

export const OfficePage: FC = () => {
  const { can } = useAuth();
  if (!can('office.read')) return <EmptyState icon="shield-x" title="Нет доступа" text="Доступ к офису настраивается в разрешениях вашей роли." />;
  return <><PageHeader title="Офис" subtitle="Фоновые задания и состояние команды" /><OfficePanel /></>;
};
