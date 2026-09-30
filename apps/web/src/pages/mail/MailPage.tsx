import { useState, type FC, type ReactNode } from 'react';
import { listMailboxes } from '../../api/mailEndpoints';
import type { IMailbox } from '../../api/mailTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { useApiResource } from '../../hooks/useApiResource';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { ALL_MAIL_CAPABILITIES, integrationText, MAIL_CAPABILITY_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import { CreateMailboxDialog } from './CreateMailboxDialog';
import styles from './Mail.module.css';

const accessOf = (m: IMailbox): ReactNode =>
  m.capabilities.length === 0 ? (
    <Badge tone="neutral" icon="lock" dashed label="Только служебные сведения" />
  ) : (
    <span>{ALL_MAIL_CAPABILITIES.filter((c) => m.capabilities.includes(c)).map((c) => MAIL_CAPABILITY_LABELS[c]).join(' · ')}</span>
  );

/**
 * Почтовые ящики (этап 07, D-025): контекст доступа к письмам. Пользователь видит ящики со своей выдачей,
 * администратор ящиков — все, но только служебные сведения. Автоматическое чтение MailHub заблокировано
 * внешней зависимостью (X-03): письма попадают в ящик ручным импортом EML.
 */
export const MailPage: FC = () => {
  const navigate = useAppNavigate();
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useApiResource((signal) => listMailboxes(signal), 'mailboxes');
  const admin = data?.isMailboxAdmin ?? false;

  const createButton = admin ? (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      Зарегистрировать ящик
    </Button>
  ) : null;

  const renderBody = (): ReactNode => {
    if (loading && !data) return <LoadingState />;
    if (error) return <ErrorState error={error} onRetry={reload} />;
    const items = data?.items ?? [];
    return (
      <>
        {(data?.integrations ?? []).map((i) => (
          <Notice key={`${i.system}:${i.component}`} tone={i.status === 'BLOCKED_EXTERNAL' ? 'warning' : 'info'} icon={i.system === 'mailhub' ? 'mail' : 'mic'}>
            {integrationText(i)}
          </Notice>
        ))}
        {items.length === 0 ? (
          <EmptyState
            icon="mail"
            title="Почтовых ящиков пока нет"
            text={admin ? 'Зарегистрируйте ящик и выдайте доступ к нему.' : 'Здесь появятся ящики, доступ к которым вам выдали.'}
            action={createButton}
          />
        ) : (
          <ul className={styles.cards}>
            {items.map((m) => (
              <li key={m.id} className={list.card}>
                <div className={list.cardHead}>
                  <AppLink className={list.rowLink} to={`/mailboxes/${m.id}`}>
                    {m.displayName}
                  </AppLink>
                  <StatusBadge status={m.status} />
                </div>
                <dl className={list.meta}>
                  <dt>Адрес</dt>
                  <dd className={styles.address}>{m.externalAccountId}</dd>
                  <dt>Источник</dt>
                  <dd>{m.system === 'mailhub' ? 'MailHub (пока ручной импорт)' : 'Ручной импорт EML'}</dd>
                  <dt>Писем</dt>
                  <dd className={list.num}>{m.messages}</dd>
                  <dt>Мой доступ</dt>
                  <dd>{accessOf(m)}</dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <>
      <PageHeader title="Почта" actions={data && data.items.length > 0 ? createButton : null} />
      <div className={form.stack}>{renderBody()}</div>
      {creating ? (
        <CreateMailboxDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            navigate(`/mailboxes/${m.id}?tab=access`);
          }}
        />
      ) : null}
    </>
  );
};
