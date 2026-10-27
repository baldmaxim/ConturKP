import { useState, type FC, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { SelectField } from '../../components/SelectField';
import { StatusBadge } from '../../components/StatusBadge';
import { Tabs, tabId, tabPanelId, type ITab } from '../../components/Tabs';
import { useApiResource } from '../../hooks/useApiResource';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { ALL_MAIL_CAPABILITIES, mailhubIntegrationText, MAIL_CAPABILITY_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import { CreateMailboxDialog } from './CreateMailboxDialog';
import { MailboxMessages } from './MailboxMessages';
import styles from './Mail.module.css';

const accessOf = (m: IMailbox): ReactNode =>
  m.capabilities.length === 0 ? (
    <Badge tone="neutral" icon="lock" dashed label="Только служебные сведения" />
  ) : (
    <span>{ALL_MAIL_CAPABILITIES.filter((c) => m.capabilities.includes(c)).map((c) => MAIL_CAPABILITY_LABELS[c]).join(' · ')}</span>
  );

const tabs: ITab[] = [
  { id: 'mail-messages', label: 'Письма', icon: 'mail' },
  { id: 'mailboxes', label: 'Ящики и доступ', icon: 'key-round' },
];

/** Письма доступны сразу; сведения и управление ящиками — на отдельной вкладке (D-025). */
export const MailPage: FC = () => {
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useApiResource((signal) => listMailboxes(signal), 'mailboxes');
  const admin = data?.isMailboxAdmin ?? false;
  const active = searchParams.get('tab') === 'mailboxes' ? 'mailboxes' : 'mail-messages';
  const readable = (data?.items ?? []).filter((m) => m.capabilities.includes('mail.read'));
  const mailbox = readable.find((m) => m.id === searchParams.get('mailbox'))
    ?? readable.find((m) => m.status === 'active' && m.system === 'mailhub')
    ?? readable.find((m) => m.status === 'active')
    ?? readable[0];
  const selectTab = (tab: string): void => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (tab === 'mailboxes') next.set('tab', tab);
      else next.delete('tab');
      return next;
    });
  };

  const createButton = admin ? (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      Зарегистрировать ящик
    </Button>
  ) : null;

  const renderBody = (): ReactNode => {
    if (loading && !data) return <LoadingState />;
    if (error) return <ErrorState error={error} onRetry={reload} />;
    const items = data?.items ?? [];
    const mailhub = (data?.integrations ?? []).filter((i) => i.system === 'mailhub');
    const statusText = mailhubIntegrationText(mailhub);
    return (
      <>
        {statusText ? (
          <Notice tone={mailhub.some((i) => i.status === 'BLOCKED_EXTERNAL' || i.status === 'NOT_IMPLEMENTED') ? 'warning' : 'info'} icon="mail">
            {statusText}
          </Notice>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            icon="mail"
            title="Почтовых ящиков пока нет"
            text={admin ? 'Зарегистрируйте ящик и выдайте доступ к нему.' : 'Здесь появятся ящики, доступ к которым вам выдали.'}
            action={createButton}
          />
        ) : <>
          <Tabs tabs={tabs} active={active} onChange={selectTab} label="Разделы почты" />
          <div role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)} className={form.stack}>
          {active === 'mail-messages' ? mailbox ? (
            <>
              <SelectField
                label="Почтовый ящик"
                value={mailbox.id}
                options={readable.map((m) => ({ value: m.id, label: `${m.displayName} · писем: ${m.messages.toLocaleString('ru-RU')}${m.status === 'archived' ? ' · архив' : ''}` }))}
                onValueChange={(id) => setSearchParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('mailbox', id);
                  next.delete('mailPage');
                  return next;
                })}
              />
              <AppLink to={`/mailboxes/${mailbox.id}`}>Открыть ящик</AppLink>
              <MailboxMessages mailbox={mailbox} />
            </>
          ) : (
            <EmptyState
              icon="lock"
              title="Нет доступа к чтению писем"
              text="Для просмотра писем нужна выдача «Чтение писем» на ящик. Администрирование ящиков само по себе не открывает переписку."
              action={<Button onClick={() => selectTab('mailboxes')}>Ящики и доступ</Button>}
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
                  {m.system === 'manual' ? <><dt>Адрес</dt><dd className={styles.address}>{m.externalAccountId}</dd></> : null}
                  <dt>Источник</dt>
                  <dd>{m.system === 'mailhub' ? 'MailHub' : 'Ручной импорт EML'}</dd>
                  <dt>Писем</dt>
                  <dd className={list.num}>{m.messages}</dd>
                  <dt>Мой доступ</dt>
                  <dd>{accessOf(m)}</dd>
                </dl>
              </li>
            ))}
          </ul>
          )}
          </div>
        </>}
      </>
    );
  };

  return (
    <>
      <PageHeader title="Почта" subtitle="Переписка по тендерам: чтение писем, просмотр вложений и связь с тендерами." actions={data && data.items.length > 0 && active === 'mailboxes' ? createButton : null} />
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
