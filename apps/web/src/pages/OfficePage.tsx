import type { FC } from 'react';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../hooks/useAuth';
import { OfficePanel } from './admin/office/OfficePanel';

export const OfficePage: FC = () => {
  const { can } = useAuth();
  if (!can('admin.audit')) return <EmptyState icon="shield-x" title="Нет доступа" text="Офис доступен администраторам портала." />;
  return <><PageHeader title="Офис" subtitle="Фоновые задания и состояние команды" /><OfficePanel /></>;
};
