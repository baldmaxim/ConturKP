import { useRef, useState, type ChangeEvent, type FC, type ReactNode } from 'react';
import { describeError, hasCode } from '../../api/errors';
import { listRecognitionRuns, requestLocalRecognition } from '../../api/recognitionEndpoints';
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
import { engineLabel, isLocalEngine, isLocalFormat, isPdf, localFailureLabel, RECOGNITION_OUTCOME } from '../../utils/localRecognitionLabels';
import { RECOGNITION_STATUS } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './RecognitionPanel.module.css';
import { RecognitionRunView } from './RecognitionRunView';

interface IRecognitionPanelProps {
  revisionId: string;
  canWrite: boolean;
  /** Тип файла редакции: экспорт RDWeb — только для PDF, локально — PDF, DOCX, XLSX, CSV (OD-4). */
  mediaType?: string;
}

// Локальный прогон — словарём владельца (OD-6: полностью, требует проверки, не распознано);
// у прогона RDWeb подписи этапа 04 прежние.
const statusBadge = (run: IRecognitionRun): ReactNode => {
  const meta = isLocalEngine(run.engine) ? RECOGNITION_OUTCOME[run.outcome] : RECOGNITION_STATUS[run.status];
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={meta.label} />;
};

/** «Распознано 76 из 77 страниц» — неполнота называется числом, а не оттенком. */
const pagesLine = (run: IRecognitionRun): string => {
  if (run.pagesTotal === null) {
    return 'Единицы не разобраны';
  }
  return `Распознано ${run.pagesRecognized} из ${run.pagesTotal}`;
};

const TRIGGER_LABELS: Record<IRecognitionRun['trigger'], string> = {
  auto: 'поставлено автоматически',
  command: 'поставлено командой',
  import: 'загружен экспорт',
};

const engineLine = (run: IRecognitionRun): string => {
  if (!isLocalEngine(run.engine)) {
    return `${engineLabel(run.engine)}${run.engineSchemaVersion ? `, схема ${run.engineSchemaVersion}` : ''}`;
  }
  const r = run.recognizer;
  const processing = r?.processing === 'native_text+ocr' ? 'текстовый слой и OCR' : r?.processing === 'native_text' ? 'текстовый слой' : 'разбор структуры';
  return `${engineLabel(run.engine)} · ${processing}${r?.languages.length ? ` (${r.languages.join(', ')})` : ''} · версия ${r?.recognizerVersion ?? '—'}`;
};

/**
 * Распознавание редакции. Прогон, который выбирается в снимок и поиск, — предпочтительный (AD-05a-3):
 * экспорт RDWeb выше локального. RDWeb приносит человек архивом экспорта (API нет, X-05); локальное
 * распознавание DOCX, XLSX, CSV ставится автоматически, PDF — командой или по политике «локально» (OD-1).
 */
export const RecognitionPanel: FC<IRecognitionPanelProps> = ({ revisionId, canWrite, mediaType }) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();
  const localKey = useIdempotencyKey();
  const runsRes = useApiResource((signal) => listRecognitionRuns(revisionId, signal), revisionId);

  const runs = runsRes.data?.items ?? [];
  const primary = runs.find((r) => r.preferred) ?? runs[0] ?? null;
  const others = runs.filter((r) => r !== primary);
  const inFlight = runs.some((r) => r.status === 'queued' || r.status === 'running');
  usePolling(inFlight, () => runsRes.reload(), 2000);
  const pdf = mediaType === undefined || isPdf(mediaType);
  const localAllowed = mediaType === undefined || isLocalFormat(mediaType);

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

  const onLocal = async (): Promise<void> => {
    setRequesting(true);
    try {
      const accepted = await requestLocalRecognition(revisionId, localKey.keyFor({ revisionId }));
      localKey.reset();
      toast.push({
        kind: accepted.reused ? 'info' : 'success',
        text: accepted.reused ? 'Такое распознавание уже есть — показан прежний прогон.' : 'Локальное распознавание поставлено в очередь.',
      });
      runsRes.reload();
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
        localKey.reset();
      }
      toast.push({ kind: 'error', text: `Не поставлено: ${describeError(error)}` });
    } finally {
      setRequesting(false);
    }
  };

  const controls = canWrite ? (
    <>
      {pdf ? (
        <>
          <input ref={inputRef} type="file" accept=".zip,application/zip" className={styles.file} onChange={(e) => void onPick(e)} />
          <Button icon="upload" loading={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? `Отправка · ${Math.round(progress * 100)} %` : runs.length > 0 ? 'Загрузить новый экспорт' : 'Загрузить экспорт RDWeb'}
          </Button>
        </>
      ) : null}
      {localAllowed ? (
        <Button variant="ghost" icon="scan-search" loading={requesting} disabled={inFlight} onClick={() => void onLocal()}>
          {pdf ? 'Распознать локально' : 'Распознать заново'}
        </Button>
      ) : null}
    </>
  ) : null;

  const runNotices = (run: IRecognitionRun): ReactNode => (
    <>
      {run.outcome === 'needs_review' ? (
        <Notice tone="warning">
          {isLocalEngine(run.engine)
            ? 'Результат требует проверки: часть единиц не прошла шлюз качества или не прочитана. Полной проверки этап с ним не получает.'
            : 'Распознаны не все страницы. Нераспознанные листы перечислены ниже — по ним доказательств нет, и полной проверки этап не получает.'}
        </Notice>
      ) : null}
      {run.status === 'failed' ? <Notice tone="danger">{localFailureLabel(run.failureCode, run.engine)}</Notice> : null}
      {isLocalEngine(run.engine) && !run.preferred && runs.some((r) => r.preferred && !isLocalEngine(r.engine)) ? (
        <Notice tone="info">Есть распознавание RDWeb — в снимок и поиск идёт оно, локальное не используется.</Notice>
      ) : null}
    </>
  );

  const renderPrimary = (): ReactNode => {
    if (!primary) {
      return (
        <p className={list.muted}>
          {pdf
            ? 'Распознавание не выполнялось. Экспорт RDWeb (ZIP: PDF, _results.md, _blocks.json) загружается вручную; локально PDF распознаётся командой или по политике документа «локально».'
            : localAllowed
              ? 'Распознавание ещё не выполнено: DOCX, XLSX и CSV ставятся автоматически.'
              : 'Этот формат не входит в перечень распознавания: PDF, DOCX, XLSX, CSV.'}
        </p>
      );
    }
    return (
      <>
        <div className={styles.head}>
          <span className={styles.pagesLine}>{pagesLine(primary)}</span>
          {statusBadge(primary)}
          {primary.preferred ? <Badge tone="neutral" icon="check" label="Используется в снимке и поиске" /> : null}
        </div>
        {runNotices(primary)}
        <dl className={list.meta}>
          <dt>Движок</dt>
          <dd>{engineLine(primary)}</dd>
          {isLocalEngine(primary.engine) ? (
            <>
              <dt>Постановка</dt>
              <dd>{TRIGGER_LABELS[primary.trigger]}</dd>
            </>
          ) : (
            <>
              <dt>Архив</dt>
              <dd className={list.mono}>{primary.sourceArtifactName ?? '—'}</dd>
            </>
          )}
          <dt>Создан</dt>
          <dd className={list.num}>{formatDateTime(primary.createdAt)} МСК</dd>
        </dl>
        {primary.status === 'complete' || primary.status === 'partial' ? (
          <Button
            icon={openRunId === primary.id ? 'chevron-down' : 'chevron-right'}
            onClick={() => setOpenRunId(openRunId === primary.id ? null : primary.id)}
          >
            {`${openRunId === primary.id ? 'Скрыть' : 'Показать'} ${isLocalEngine(primary.engine) ? 'единицы' : 'страницы'} и фрагменты`}
          </Button>
        ) : null}
        {openRunId === primary.id ? <RecognitionRunView runId={primary.id} /> : null}
        {others.length > 0 ? (
          <details className={styles.history}>
            <summary className={styles.summary}>
              <Icon name="chevron-down" size={16} className={styles.chevron} />
              <span>{`Другие прогоны: ${others.length}`}</span>
            </summary>
            <ul className={styles.runs}>
              {others.map((run) => (
                <li key={run.id} className={styles.run}>
                  <div className={styles.runHead}>
                    <span className={list.num}>{formatDateTime(run.createdAt)} МСК</span>
                    {statusBadge(run)}
                  </div>
                  <span className={list.muted}>{`${engineLabel(run.engine)} · ${pagesLine(run)}`}</span>
                  {run.status === 'failed' ? <span className={list.muted}>{localFailureLabel(run.failureCode, run.engine)}</span> : null}
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
        {controls}
      </div>
      {runsRes.error ? <Notice tone="danger">{`Прогоны не загружены: ${describeError(runsRes.error)}`}</Notice> : renderPrimary()}
    </section>
  );
};
