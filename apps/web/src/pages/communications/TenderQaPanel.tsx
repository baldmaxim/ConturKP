import { useState, type FC } from 'react';
import { getQaThread, listQaThreads } from '../../api/mailEndpoints';
import type { IQaItem } from '../../api/mailTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { QA_STATUS_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from '../mail/Mail.module.css';
import { ManifestUpload } from './ManifestUpload';

const statusBadge = (s: 'open' | 'answered' | 'withdrawn') =>
  s === 'answered' ? (
    <Badge tone="success" icon="check" label={QA_STATUS_LABELS[s]} />
  ) : s === 'open' ? (
    <Badge tone="warning" icon="hourglass" dashed label={QA_STATUS_LABELS[s]} />
  ) : (
    <Badge tone="muted" icon="x" label={QA_STATUS_LABELS[s]} />
  );

const ItemCard: FC<{ item: IQaItem }> = ({ item }) => {
  const [open, setOpen] = useState(false);
  const c = item.current;
  return (
    <li className={list.card}>
      <div className={list.cardHead}>
        <span className={list.cardTitle}>{`Вопрос ${item.itemNo}`}</span>
        {statusBadge(c.status)}
      </div>
      <p className={styles.block}>{c.question}</p>
      {c.answer ? <p className={styles.quoted}>{c.answer}</p> : null}
      <p className={list.muted}>{`Ревизия ${c.seq}${c.answeredAt ? ` · ответ ${formatDateTime(c.answeredAt)} МСК` : ''}`}</p>
      {item.history.length > 1 ? (
        <>
          <Button variant="ghost" icon={open ? 'chevron-down' : 'chevron-right'} onClick={() => setOpen(!open)} aria-expanded={open}>
            {`История ревизий (${item.history.length})`}
          </Button>
          {open ? (
            <ol className={styles.body}>
              {item.history.map((h) => (
                <li key={h.id}>
                  <p className={list.muted}>{`Ревизия ${h.seq} · ${QA_STATUS_LABELS[h.status]} · импорт ${formatDateTime(h.createdAt)} МСК`}</p>
                  <p className={styles.block}>{h.answer ?? 'без ответа'}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </li>
  );
};

const ThreadView: FC<{ threadId: string }> = ({ threadId }) => {
  const res = useApiResource((signal) => getQaThread(threadId, signal), threadId);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <ul className={styles.cards}>
      {res.data.questions.map((q) => (
        <ItemCard key={q.itemId} item={q} />
      ))}
    </ul>
  );
};

/**
 * Вопросы–ответы тендера (OD-07-6): тред → вопрос с устойчивым номером → неизменяемые ревизии. Изменённый
 * ответ — новая ревизия; возврат к прежнему ответу тоже новая ревизия, история не схлопывается.
 */
export const TenderQaPanel: FC<{ tenderId: string; canImport: boolean }> = ({ tenderId, canImport }) => {
  const [version, setVersion] = useState(0);
  const res = useApiResource((signal) => listQaThreads(tenderId, signal), `qa:${tenderId}:${version}`);
  const [openThread, setOpenThread] = useState<string | null>(null);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const threads = res.data?.items ?? [];
  return (
    <div className={form.stack}>
      {canImport ? <ManifestUpload tenderId={tenderId} kind="qa" onImported={() => setVersion((v) => v + 1)} /> : null}
      {threads.length === 0 ? (
        <EmptyState icon="message-square" title="Вопросов–ответов пока нет" text="Импортируйте файл формы вопросов и ответов заказчика." />
      ) : (
        threads.map((t) => (
          <section key={t.id} className={form.section} aria-label={`Тред ${t.externalRef}`}>
            <div className={form.sectionHead}>
              <h2 className={form.sectionTitle}>{t.title ?? t.externalRef}</h2>
              <Button variant="ghost" icon={openThread === t.id ? 'chevron-down' : 'chevron-right'} onClick={() => setOpenThread(openThread === t.id ? null : t.id)} aria-expanded={openThread === t.id}>
                {`Вопросов: ${t.items}, без ответа: ${t.openItems}`}
              </Button>
            </div>
            {openThread === t.id ? <ThreadView threadId={t.id} /> : null}
          </section>
        ))
      )}
    </div>
  );
};
