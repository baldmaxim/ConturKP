import { useRef, useState, type ChangeEvent, type FC, type ReactNode } from 'react';
import { describeError, hasCode } from '../../api/errors';
import { listRecognitionRuns } from '../../api/recognitionEndpoints';
import type { IRecognitionRun } from '../../api/types';
import { uploadRecognitionExport } from '../../api/upload';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { RECOGNITION_STATUS, recognitionFailureLabel } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './RecognitionPanel.module.css';
import { RecognitionRunView } from './RecognitionRunView';

interface IRecognitionPanelProps {
  revisionId: string;
  canWrite: boolean;
}

const statusBadge = (run: IRecognitionRun): ReactNode => {
  const meta = RECOGNITION_STATUS[run.status];
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={meta.label} />;
};

/** «Распознано 76 из 77 страниц» — неполнота называется числом, а не оттенком. */
const pagesLine = (run: IRecognitionRun): string => {
  if (run.pagesTotal === null) {
    return 'Страницы не разобраны';
  }
  return `Распознано ${run.pagesRecognized} из ${run.pagesTotal}`;
};

/**
 * Распознавание редакции: загрузка экспортного архива RDWeb, статус прогона и его полнота,
 * история прогонов. Автоматическая постановка задач в RDWeb недоступна (X-05), поэтому
 * архив приносит человек — это сказано в интерфейсе прямо.
 */
export const RecognitionPanel: FC<IRecognitionPanelProps> = ({ revisionId, canWrite }) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();
  const runsRes = useApiResource((signal) => listRecognitionRuns(revisionId, signal), revisionId);

  const runs = runsRes.data?.items ?? [];
  const latest = runs[0] ?? null;
  const inFlight = runs.some((r) => r.status === 'queued' || r.status === 'running');
  usePolling(inFlight, () => runsRes.reload(), 2000);

  const onPick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      const accepted = await uploadRecognitionExport(
        revisionId,
        file,
        idempotency.keyFor({ revisionId, name: file.name, size: file.size }),
        setProgress,
      ).promise;
      idempotency.reset();
      toast.push({
        kind: accepted.reused ? 'info' : 'success',
        text: accepted.reused ? 'Этот архив уже импортирован — показан прежний прогон.' : 'Архив принят, идёт разбор.',
      });
      runsRes.reload();
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
        idempotency.reset();
      }
      toast.push({ kind: 'error', text: `Архив не принят: ${describeError(error)}` });
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const uploadControl = canWrite ? (
    <>
      <input ref={inputRef} type="file" accept=".zip,application/zip" className={styles.file} onChange={(e) => void onPick(e)} />
      <Button icon="upload" loading={uploading} onClick={() => inputRef.current?.click()}>
        {uploading ? `Отправка · ${Math.round(progress * 100)} %` : latest ? 'Загрузить новый экспорт' : 'Загрузить экспорт RDWeb'}
      </Button>
    </>
  ) : null;

  const renderLatest = (): ReactNode => {
    if (!latest) {
      return (
        <p className={list.muted}>
          Распознавание не выполнялось. Экспорт RDWeb (ZIP: PDF, <code>_results.md</code>, <code>_blocks.json</code>) загружается вручную.
        </p>
      );
    }
    return (
      <>
        <div className={styles.head}>
          <span className={styles.pagesLine}>{pagesLine(latest)}</span>
          {statusBadge(latest)}
        </div>
        {latest.status === 'partial' ? (
          <Notice tone="warning">
            Распознаны не все страницы. Нераспознанные листы перечислены ниже — по ним доказательств нет, и полной проверки этап не получает.
          </Notice>
        ) : null}
        {latest.status === 'failed' ? <Notice tone="danger">{recognitionFailureLabel(latest.failureCode)}</Notice> : null}
        <dl className={list.meta}>
          <dt>Движок</dt>
          <dd>{`Экспорт RDWeb${latest.engineSchemaVersion ? `, схема ${latest.engineSchemaVersion}` : ''}`}</dd>
          <dt>Архив</dt>
          <dd className={list.mono}>{latest.sourceArtifactName ?? '—'}</dd>
          <dt>Загружен</dt>
          <dd className={list.num}>{formatDateTime(latest.createdAt)} МСК</dd>
        </dl>
        {latest.status === 'complete' || latest.status === 'partial' ? (
          <Button
            icon={openRunId === latest.id ? 'chevron-down' : 'chevron-right'}
            onClick={() => setOpenRunId(openRunId === latest.id ? null : latest.id)}
          >
            {openRunId === latest.id ? 'Скрыть страницы и фрагменты' : 'Показать страницы и фрагменты'}
          </Button>
        ) : null}
        {openRunId === latest.id ? <RecognitionRunView runId={latest.id} /> : null}
        {runs.length > 1 ? (
          <details className={styles.history}>
            <summary className={styles.summary}>
              <Icon name="chevron-down" size={16} className={styles.chevron} />
              <span>{`Прежние прогоны: ${runs.length - 1}`}</span>
            </summary>
            <ul className={styles.runs}>
              {runs.slice(1).map((run) => (
                <li key={run.id} className={styles.run}>
                  <div className={styles.runHead}>
                    <span className={list.num}>{formatDateTime(run.createdAt)} МСК</span>
                    {statusBadge(run)}
                  </div>
                  <span className={list.muted}>{pagesLine(run)}</span>
                  {run.status === 'complete' || run.status === 'partial' ? (
                    <Button
                      variant="ghost"
                      icon={openRunId === run.id ? 'chevron-down' : 'chevron-right'}
                      onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)}
                    >
                      {openRunId === run.id ? 'Скрыть' : 'Открыть'}
                    </Button>
                  ) : null}
                  {openRunId === run.id ? <RecognitionRunView runId={run.id} /> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </>
    );
  };

  return (
    <section className={styles.panel} aria-label="Распознавание редакции">
      <div className={styles.title}>
        <Icon name="scan-search" size={20} />
        <span>Распознавание</span>
        {uploadControl}
      </div>
      {runsRes.error ? <Notice tone="danger">{`Прогоны не загружены: ${describeError(runsRes.error)}`}</Notice> : renderLatest()}
    </section>
  );
};
