import type { FC } from 'react';
import { AppLink } from '../components/AppLink';
import { EmptyState } from '../components/EmptyState';

export const NotFoundPage: FC = () => (
  <EmptyState
    icon="shield-x"
    title="Страница не найдена"
    text="Такого адреса в портале нет или у вас нет к нему доступа."
    action={<AppLink to="/">К списку тендеров</AppLink>}
  />
);
