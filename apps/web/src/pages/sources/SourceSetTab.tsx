import { useState, type FC, type ReactNode } from 'react';
import { describeError, hasCode, stateConflictCurrent } from '../../api/errors';
import { freezeSourceSet } from '../../api/recognitionEndpoints';
import { createSourceSetDraft, listDocuments, listSourceSets } from '../../api/sourceEndpoints';
import type { IFreezeBlockingItem, ISourceSetLatestItem, ISourceSetRevision } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { INCLUSION_LABELS } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import { SourceSetEditor } from './SourceSetEditor';

interface ISourceSetTabProps {
  stageId: string;
  canWrite: boolean;
}

const revisionBadge = (revision: ISourceSetRevision): ReactNode =>
  revision.status === 'draft' ? (
    <Badge tone="info" icon="pencil" label="Черновик" />
  ) : (
    <Badge tone="neutral" icon="check" label="Заморожен" />
  );

const inclusionBadge = (item: ISourceSetLatestItem): ReactNode =>
  item.inclusion === 'included' ? (
    <Badge tone="success" icon="check" label={INCLUSION_LABELS.included} />
  ) : (
    <Badge tone="neutral" icon="user-check" label={INCLUSION_LABELS.excluded_not_applicable} />
  );

const BLOCKING_REASONS: Record<IFreezeBlockingItem['reason'], string> = {
  no_recognition: 'распознавание не выполнялось',
  recognition_in_progress: 'распознавание ещё идёт',
  recognition_failed: 'распознавание не принято',
  recognition_cancelled: 'распознавание отменено',
};

// Сервер присылает перечень блокирующих редакций в current.blocking (409 STATE_CONFLICT).
const blockingOf = (error: unknown): IFreezeBlockingItem[] => {
  const current = stateConflictCurrent(error);
  if (!current || typeof current !== 'object' || !('blocking' in current)) {
    return [];
  }
  const blocking = (current as { blocking: unknown }).blocking;
  return Array.isArray(blocking) ? (blocking as IFreezeBlockingItem[]) : [];
};

/** Состав источников этапа: текущая ревизия, черновик, его правка и заморозка. */
export const SourceSetTab: FC<ISourceSetTabProps> = ({ stageId, canWrite }) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [blocking, setBlocking] = useState<IFreezeBlockingItem[]>([]);
  const idempotency = useIdempotencyKey();
  const setsRes = useApiResource((signal) => listSourceSets(stageId, signal), stageId);
  const docsRes = useApiResource((signal) => listDocuments(stageId, signal), stageId);

  const sets = setsRes.data?.items ?? [];
  const set = sets.find((s) => s.purpose === 'working') ?? sets[0] ?? null;
  const latest = set?.revisions[0] ?? null;
  const draft = set?.revisions.find((r) => r.status === 'draft') ?? null;
  const items = set?.latestItems ?? [];

  const createDraft = async (): Promise<void> => {
    setCreating(true);
    try {
      await createSourceSetDraft(stageId, idempotency.keyFor({ stageId, action: 'draft' }));
      idempotency.reset();
      toast.push({ kind: 'success', text: 'Черновик состава создан.' });
      setsRes.reload();
      setEditing(true);
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED') || hasCode(error, 'STATE_CONFLICT')) {
        idempotency.reset();
      }
      toast.push({ kind: 'error', text: `Черновик не создан: ${describeError(error)}` });
      if (hasCode(error, 'STATE_CONFLICT')) {
        setsRes.reload();
      }
    } finally {
      setCreating(false);
    }
  };

  const freeze = async (): Promise<void> => {
    if (!draft) {
      return;
    }
    setFreezing(true);
    try {
      await freezeSourceSet(draft.id, draft.rowVersion, idempotency.keyFor({ revisionId: draft.id, action: 'freeze' }));
      idempotency.reset();
      setBlocking([]);
      setConfirming(false);
      toast.push({ kind: 'success', text: 'Состав заморожен.' });
      setsRes.reload();
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
        idempotency.reset();
      }
      const items = blockingOf(error);
      setBlocking(items);
      setConfirming(false);
      toast.push({ kind: 'error', text: `Состав не заморожен: ${describeError(error)}` });
      if (hasCode(error, 'VERSION_CONFLICT') || hasCode(error, 'STATE_CONFLICT')) {
        setsRes.reload();
      }
    } finally {
      setFreezing(false);
    }
  };

  const createButton =
    canWrite && !draft ? (
      <Button variant="primary" icon="plus" loading={creating} onClick={() => void createDraft()}>
        Создать черновик состава
      </Button>
    ) : null;

  const renderItems = (): ReactNode => {
    if (items.length === 0) {
      return <p className={list.muted}>В ревизии пока нет ни одной редакции.</p>;
    }
    return (
      <>
        <div className={list.tableWrap}>
          <table className={list.table}>
            <thead>
              <tr>
                <th scope="col">Документ</th>
                <th scope="col" className={list.right}>
                  Ред.
                </th>
                <th scope="col">Решение</th>
                <th scope="col">Причина</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.documentRevisionId}>
                  <td>{item.documentTitle}</td>
                  <td className={`${list.num} ${list.right}`}>{item.revisionSeq}</td>
                  <td>{inclusionBadge(item)}</td>
                  <td>{item.reason ?? <span className={list.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((item) => (
            <li key={item.documentRevisionId} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{`${item.documentTitle} · ред. ${item.revisionSeq}`}</span>
                {inclusionBadge(item)}
              </div>
              {item.reason ? <p className={list.muted}>{item.reason}</p> : null}
            </li>
          ))}
        </ul>
      </>
    );
  };

  const renderBody = (): ReactNode => {
    if ((setsRes.loading && !setsRes.data) || (editing && docsRes.loading && !docsRes.data)) {
      return <LoadingState />;
    }
    if (setsRes.error) {
      return <ErrorState error={setsRes.error} onRetry={setsRes.reload} />;
    }
    if (!latest) {
      return (
        <EmptyState
          icon="list-checks"
          title="Состав источников ещё не собирали"
          text={
            canWrite
              ? 'Создайте черновик и отметьте, какие редакции документов входят в работу этапа.'
              : 'Состав собирают инженеры тендера.'
          }
          action={createButton}
        />
      );
    }
    if (editing && draft) {
      if (docsRes.error) {
        return <ErrorState error={docsRes.error} onRetry={docsRes.reload} />;
      }
      return (
        <SourceSetEditor
          key={`${draft.id}:${draft.rowVersion}`}
          revision={draft}
          items={latest.id === draft.id ? items : []}
          documents={docsRes.data?.items ?? []}
          onSaved={() => {
            setEditing(false);
            setsRes.reload();
          }}
          onCancel={() => setEditing(false)}
          onReload={() => {
            setsRes.reload();
            docsRes.reload();
          }}
        />
      );
    }
    return (
      <>
        <dl className={form.details}>
          <dt>Ревизия</dt>
          <dd className={form.num}>
            {`№ ${latest.seq} `}
            {revisionBadge(latest)}
          </dd>
          <dt>Изменена</dt>
          <dd className={form.num}>{formatDateTime(latest.updatedAt)} МСК</dd>
          <dt>Редакций в составе</dt>
          <dd className={form.num}>
            {`включено ${items.filter((i) => i.inclusion === 'included').length} · исключено ${items.filter((i) => i.inclusion !== 'included').length}`}
          </dd>
        </dl>
        {renderItems()}
      </>
    );
  };

  return (
    <section className={form.section} aria-labelledby="source-set-title">
      <div className={form.sectionHead}>
        <h2 id="source-set-title" className={form.sectionTitle}>
          Состав источников
        </h2>
        {!editing && latest && canWrite ? (
          draft ? (
            <>
              <Button icon="pencil" onClick={() => setEditing(true)}>
                Изменить состав
              </Button>
              <Button variant="primary" icon="check" onClick={() => setConfirming(true)}>
                Заморозить состав
              </Button>
            </>
          ) : (
            createButton
          )
        ) : null}
      </div>
      {blocking.length > 0 ? (
        <Notice tone="warning">
          <span>Заморозка требует распознавания включённых редакций. Не готовы:</span>
          <ul>
            {blocking.map((item) => (
              <li key={item.documentRevisionId}>{`${item.documentTitle} · ред. ${item.revisionSeq} — ${BLOCKING_REASONS[item.reason]}`}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {renderBody()}
      {confirming && draft ? (
        <ConfirmDialog
          title="Заморозить состав источников"
          confirmLabel="Заморозить"
          confirmIcon="check"
          busy={freezing}
          onConfirm={() => void freeze()}
          onClose={() => setConfirming(false)}
        >
          <p>
            После заморозки состав ревизии не меняется: новые документы попадут в следующий черновик. Редакции с неполным
            распознаванием войдут в состав как есть — их неполнота останется видимой.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
};
