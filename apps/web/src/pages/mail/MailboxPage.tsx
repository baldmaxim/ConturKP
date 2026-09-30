import { useMemo, useState, type FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { describeError, hasCode } from '../../api/errors';
import { getMailbox, listMailboxes, listMailboxMessages, updateMailbox } from '../../api/mailEndpoints';
import type { IMailbox } from '../../api/mailTypes';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { Tabs, tabId, tabPanelId, type ITab } from '../../components/Tabs';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import form from '../../styles/form.module.css';
import { MailboxAccessPanel } from './MailboxAccessPanel';
import { MailImportPanel } from './MailImportPanel';
import { MailMessagesList } from './MailMessagesList';

const tabsFor = (m: IMailbox, admin: boolean): ITab[] => {
  const tabs: ITab[] = [];
  if (m.capabilities.includes('mail.read')) tabs.push({ id: 'messages', label: 'Письма', icon: 'mail' });
  if (m.capabilities.includes('mail.read') || m.capabilities.includes('mail.import')) tabs.push({ id: 'imports', label: 'Импорт EML', icon: 'upload' });
  if (admin) tabs.push({ id: 'access', label: 'Доступ', icon: 'key-round' });
  if (admin || m.capabilities.includes('mail.manage')) tabs.push({ id: 'settings', label: 'Ящик', icon: 'pencil' });
  return tabs;
};

const MessagesTab: FC<{ mailbox: IMailbox; version: number }> = ({ mailbox, version }) => {
  const res = useApiResource((signal) => listMailboxMessages(mailbox.id, signal), `messages:${mailbox.id}:${version}`);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  return <MailMessagesList items={res.data?.items ?? []} emptyTitle="Писем пока нет" emptyText="Импортируйте файлы EML на вкладке «Импорт EML»." />;
};

const SettingsTab: FC<{ mailbox: IMailbox; onChanged: (m: IMailbox) => void }> = ({ mailbox, onChanged }) => {
  const toast = useToast();
  const [name, setName] = useState(mailbox.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async (patch: { displayName?: string; status?: 'active' | 'archived' }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await updateMailbox(mailbox, patch));
      toast.push({ kind: 'success', text: 'Ящик сохранён.' });
    } catch (e) {
      setError(hasCode(e, 'VERSION_CONFLICT') ? 'Ящик изменён другим пользователем — обновите страницу.' : describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={form.section} aria-label="Ящик">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <TextField label="Название" value={name} onValueChange={setName} autoComplete="off" />
      <div className={form.actions}>
        <Button variant="primary" icon="check" loading={busy} disabled={!name.trim() || name.trim() === mailbox.displayName} onClick={() => void apply({ displayName: name.trim() })}>
          Сохранить название
        </Button>
        <Button icon="archive" loading={busy} onClick={() => void apply({ status: mailbox.status === 'active' ? 'archived' : 'active' })}>
          {mailbox.status === 'active' ? 'В архив' : 'Вернуть из архива'}
        </Button>
      </div>
      <Notice tone="info">Ящик не удаляется: письма, ревизии и снимки остаются. Архивный ящик новых импортов не принимает.</Notice>
    </section>
  );
};

/** Ящик: письма, импорт EML, выдачи и настройки — по возможностям пользователя (D-025). */
export const MailboxPage: FC = () => {
  const { mailboxId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const res = useApiResource((signal) => getMailbox(mailboxId, signal), mailboxId);
  const listRes = useApiResource((signal) => listMailboxes(signal), 'mailboxes-admin-flag');
  const [version, setVersion] = useState(0);
  const admin = listRes.data?.isMailboxAdmin ?? false;
  const mailbox = res.data;
  const tabs = useMemo(() => (mailbox ? tabsFor(mailbox, admin) : []), [mailbox, admin]);
  const active = tabs.find((t) => t.id === searchParams.get('tab'))?.id ?? tabs[0]?.id ?? 'messages';

  if (res.loading && !mailbox) return <LoadingState />;
  if (res.error || !mailbox) return <ErrorState error={res.error} onRetry={res.reload} notFoundTitle="Ящик не найден или нет доступа" />;

  return (
    <>
      <PageHeader back={{ to: '/mail', label: 'Почта' }} title={mailbox.displayName} subtitle={<StatusBadge status={mailbox.status} />} />
      {tabs.length === 0 ? (
        <Notice tone="info">У вас нет прав на письма этого ящика.</Notice>
      ) : (
        <>
          <Tabs tabs={tabs} active={active} onChange={(id) => setSearchParams({ tab: id }, { replace: true })} label="Разделы ящика" />
          <div role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)}>
            {active === 'messages' ? <MessagesTab mailbox={mailbox} version={version} /> : null}
            {active === 'imports' ? <MailImportPanel mailbox={mailbox} onImported={() => setVersion((v) => v + 1)} /> : null}
            {active === 'access' ? <MailboxAccessPanel mailbox={mailbox} onMailboxChanged={res.reload} /> : null}
            {active === 'settings' ? <SettingsTab mailbox={mailbox} onChanged={(m) => res.setData(m)} /> : null}
          </div>
        </>
      )}
    </>
  );
};
