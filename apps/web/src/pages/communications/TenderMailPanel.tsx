import type { FC } from 'react';
import { listTenderMail } from '../../api/mailEndpoints';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import form from '../../styles/form.module.css';
import { MailMessagesList } from '../mail/MailMessagesList';

/**
 * Переписка тендера: письма с действующей связью, которые пользователь читает (mail.read на ящик). Письмо
 * без права чтения не показывается и не считается — связь с тендером доступа к письму не даёт (OD-07-3).
 */
export const TenderMailPanel: FC<{ tenderId: string }> = ({ tenderId }) => {
  const res = useApiResource((signal) => listTenderMail(tenderId, signal), `tender-mail:${tenderId}`);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <div className={form.stack}>
      <Notice tone="info">Показаны письма, связанные с тендером, из ящиков, которые вы читаете. Связь подтверждается в карточке письма.</Notice>
      <MailMessagesList
        items={res.data?.items ?? []}
        showMailbox
        emptyTitle="Связанных писем нет"
        emptyText="Откройте письмо в разделе «Почта» и подтвердите его связь с этим тендером."
      />
    </div>
  );
};
