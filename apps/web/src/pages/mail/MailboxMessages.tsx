import { useEffect, useState, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listMailboxMessages } from '../../api/mailEndpoints';
import type { IMailbox, IMailMessagePage } from '../../api/mailTypes';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import form from '../../styles/form.module.css';
import { MailMessagesList } from './MailMessagesList';
import styles from './Mail.module.css';

const count = (n: number): string => n.toLocaleString('ru-RU');
const positivePage = (value: string | null): number => Math.min(1_000_000, Math.max(1, Number.parseInt(value ?? '1', 10) || 1));

const HistoryNavigation: FC<{ data: IMailMessagePage; onPage: (page: number) => void }> = ({ data, onPage }) => {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const [jump, setJump] = useState(String(data.page));
  useEffect(() => setJump(String(data.page)), [data.page]);
  if (pages === 1) return null;
  return (
    <nav className={styles.pagination} aria-label="Страницы писем">
      <div className={styles.actions}>
        <Button disabled={data.page === 1} onClick={() => onPage(1)}>Первая</Button>
        <Button icon="arrow-left" disabled={data.page === 1} onClick={() => onPage(data.page - 1)}>Назад</Button>
        <span className={styles.pageCount}>Страница {count(data.page)} из {count(pages)}</span>
        <Button icon="chevron-right" disabled={data.page === pages} onClick={() => onPage(data.page + 1)}>Далее</Button>
        <Button disabled={data.page === pages} onClick={() => onPage(pages)}>Последняя</Button>
      </div>
      <form className={styles.pageJump} onSubmit={(event) => { event.preventDefault(); if (jump) onPage(Math.min(pages, positivePage(jump))); }}>
        <TextField label="Номер страницы" type="number" min={1} max={pages} step={1} value={jump} onValueChange={setJump} />
        <Button type="submit" disabled={!jump}>Перейти</Button>
      </form>
    </nav>
  );
};

/** Поиск и страницы относятся к ящику и URL; чужие результаты не показываются при смене запроса. */
export const MailboxMessages: FC<{ mailbox: IMailbox; version?: number }> = ({ mailbox, version = 0 }) => {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().slice(0, 500);
  const page = positivePage(params.get('mailPage'));
  const pageSize = [25, 50, 100, 200].includes(Number(params.get('mailPageSize'))) ? Number(params.get('mailPageSize')) : 50;
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const change = (patch: Record<string, string | null>): void => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return next;
  });
  const res = useApiResource(
    (signal) => listMailboxMessages(mailbox.id, { q, page, pageSize }, signal),
    `messages:${mailbox.id}:${version}:${JSON.stringify([q, page, pageSize])}`,
  );
  const data = res.data;
  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? first + data.items.length - 1 : 0;
  const onPage = (next: number): void => change({ mailPage: next === 1 ? null : String(next) });
  return (
    <div className={form.stack}>
      <form className={styles.searchForm} role="search" aria-label="Поиск по письмам" onSubmit={(event) => {
        event.preventDefault();
        change({ q: draft.trim() || null, mailPage: null });
      }}>
        <TextField label="Поиск по письмам" type="search" value={draft} maxLength={500} onValueChange={setDraft}
          placeholder="Тема, адрес, текст или название вложения" hint="По всей истории выбранного ящика." />
        <div className={styles.actions}>
          <Button variant="primary" type="submit" icon="search">Найти</Button>
          {q || draft ? <Button onClick={() => { setDraft(''); change({ q: null, mailPage: null }); }}>Сбросить</Button> : null}
        </div>
      </form>
      <div className={styles.historyToolbar}>
        <span aria-live="polite">{data ? data.total > 0
          ? `${q ? 'Найдено' : 'Всего'}: ${count(data.total)} · показаны ${count(first)}–${count(last)}`
          : q ? 'По запросу писем не найдено' : 'Писем: 0' : 'Загружаем письма…'}</span>
        <div className={styles.actions}>
          <SelectField label="Писем на странице" value={String(pageSize)} options={[25, 50, 100, 200].map((size) => ({ value: String(size), label: String(size) }))}
            onValueChange={(size) => change({ mailPageSize: size, mailPage: null })} />
          <Button icon="refresh-cw" onClick={res.reload} loading={res.loading}>Обновить письма</Button>
        </div>
      </div>
      {res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : !data ? <LoadingState /> : <>
        <HistoryNavigation data={data} onPage={onPage} />
        <MailMessagesList items={data.items} emptyTitle={q ? 'Ничего не найдено' : 'Писем пока нет'}
          emptyText={q ? 'Измените запрос или сбросьте поиск, чтобы вернуться ко всей истории.'
            : mailbox.system === 'mailhub' ? 'В этом ящике ещё нет загруженных писем MailHub.'
              : mailbox.capabilities.includes('mail.import') ? 'Откройте ящик и загрузите файлы на вкладке «Импорт EML».'
                : 'Здесь появятся письма после загрузки в этот ящик.'} />
        {data.items.length > 10 ? <HistoryNavigation data={data} onPage={onPage} /> : null}
      </>}
    </div>
  );
};
