import { useEffect, useState, type FC } from 'react';
import { candidateArchiveUrl, candidateFileUrl, candidateManifestUrl, getCandidate } from '../../api/releaseEndpoints';
import type { ICandidateFile } from '../../api/releaseTypes';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { BLOCKER_LABELS, CANDIDATE_STATUS, CHECK_LABELS, EVENT_LABELS, formatBytes, MODE_LABEL, noteLabel, OUTCOME_LABEL } from '../../utils/releaseLabels';
import form from '../../styles/form.module.css';
import { ApprovalActions } from './ApprovalActions';
import { CandidateHistory } from './CandidateHistory';
import { GatePanel } from './GatePanel';
import { HoldsPanel } from './HoldsPanel';
import { PdfPreview } from './PdfPreview';
import { ReleaseChain } from './ReleaseChain';
import styles from './Release.module.css';

interface ICandidateDetailProps {
  candidateId: string;
  onChanged: () => void;
}

const FileRow: FC<{ f: ICandidateFile; selected: boolean; onSelect: () => void }> = ({ f, selected, onSelect }) => (
  <li className={styles.fileRow}>
    <button type="button" className={styles.fileButton} aria-current={selected ? 'true' : undefined} onClick={onSelect} disabled={!f.previewFileId}>
      <span className={styles.label}>{f.path}</span>
      <span className={styles.muted}>{`${f.role === 'attachment' ? 'вложение «как есть»' : 'по образцу'} · ${formatBytes(f.sizeBytes)} · SHA-256 ${f.sha256.slice(0, 12)}…`}</span>
    </button>
    <a className={styles.download} href={candidateFileUrl(f.id)} download>
      Скачать
    </a>
  </li>
);

/**
 * Комплект-кандидат (D-032): статус, режим, отметки и известные блокеры (без разрешения на выпуск), проверки сборки,
 * файлы для заказчика и внутренние, превью выбранного файла, закреплённые входы, изменения после сборки. Без видимости
 * всех входов — только оболочка (D-032 В-12-7). Этап 13 (D-033): цепочка выпуска, матрица блокеров с принятием риска,
 * удержания по событиям, защищённые действия «Согласовать…» и «Выпустить…» в конце карточки, журнал.
 */
export const CandidateDetail: FC<ICandidateDetailProps> = ({ candidateId, onChanged }) => {
  const res = useApiResource((signal) => getCandidate(candidateId, signal), candidateId);
  const [selected, setSelected] = useState<string | null>(null);
  const c = res.data;
  const assembling = c?.status === 'assembling';
  useEffect(() => {
    if (!assembling) return undefined;
    const t = window.setInterval(() => {
      res.reload();
      onChanged();
    }, 2000);
    return () => window.clearInterval(t);
  }, [assembling, res, onChanged]);
  if (res.loading && !c) return <LoadingState />;
  if (res.error && !c) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!c) return null;
  const status = CANDIDATE_STATUS[c.status]!;
  const files = c.files ?? [];
  const current = files.find((f) => f.id === selected) ?? files.find((f) => f.previewFileId) ?? null;
  const refresh = (): void => {
    res.reload();
    onChanged();
  };
  const tracked = !c.restricted && ['ready_for_approval', 'approved', 'returned', 'released'].includes(c.status);
  const gate = c.status === 'ready_for_approval' ? c.gate?.approve : c.status === 'approved' ? c.gate?.release : null;
  return (
    <section className={form.section} aria-labelledby={`candidate-${c.id}`}>
      <div className={styles.head}>
        <h3 id={`candidate-${c.id}`} className={form.sectionTitle}>
          {`Комплект № ${c.seq}`}
        </h3>
        <div className={styles.badges}>
          <Badge label={status.label} icon={status.icon} tone={status.tone} dashed={status.dashed} />
          <Badge label={MODE_LABEL[c.mode] ?? c.mode} icon={c.mode === 'test' ? 'info' : 'shield-x'} tone={c.mode === 'test' ? 'warning' : 'neutral'} />
          {c.current === false ? <Badge label="Есть события без решения" icon="octagon-pause" tone="warning" dashed /> : null}
        </div>
      </div>
      <p className={styles.muted}>{`Собрал ${c.createdBy.name} · ${formatDateTime(c.createdAt)}${c.converterVersion ? ` · превью: ${c.converterVersion}` : ''}`}</p>
      {c.restricted ? <Notice tone="warning">Среди входов комплекта есть материалы, закрытые для вас: состав и файлы не показываются.</Notice> : null}
      {c.failure ? <Notice tone="danger">{`Сборка не удалась (${CHECK_LABELS[c.failure.code] ?? c.failure.code}): ${c.failure.detail}`}</Notice> : null}
      {gate
        ? null
        : (c.knownProductionBlockers ?? []).map((b) => (
            <Notice key={b} tone="warning">
              {BLOCKER_LABELS[b] ?? b}
            </Notice>
          ))}
      {tracked ? <ReleaseChain c={c} /> : null}
      {gate ? (
        <GatePanel candidateId={c.id} gate={gate} title={c.status === 'approved' ? 'Выпуск' : 'Согласование'} canAcceptRisk={!!c.can?.acceptRisk && c.status === 'ready_for_approval'} onChanged={refresh} />
      ) : null}
      {tracked || c.status === 'assembling' ? <HoldsPanel stageId={c.stageId} candidateId={c.id} version={`${c.etag}:${c.holds?.open ?? 0}:${c.holds?.total ?? 0}`} onChanged={refresh} /> : null}
      {(c.notes ?? []).length ? (
        <ul className={styles.notes} aria-label="Отметки комплекта">
          {c.notes!.map((n) => (
            <li key={n} className={styles.muted}>
              {noteLabel(n)}
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <div className={styles.layout}>
          <div className={styles.column}>
            {(['customer', 'internal'] as const).map((aud) => {
              const group = files.filter((f) => f.audience === aud);
              return (
                <div key={aud} className={styles.column}>
                  <h4 className={styles.subTitle}>{aud === 'customer' ? 'Заказчику' : 'Внутреннее'}</h4>
                  {group.length === 0 ? <p className={styles.muted}>Файлов нет.</p> : null}
                  <ul className={styles.files}>
                    {group.map((f) => (
                      <FileRow key={f.id} f={f} selected={current?.id === f.id} onSelect={() => setSelected(f.id)} />
                    ))}
                  </ul>
                </div>
              );
            })}
            <div className={styles.actions}>
              <a className={styles.download} href={candidateArchiveUrl(c.id)} download>
                ZIP для заказчика
              </a>
              <a className={styles.download} href={candidateArchiveUrl(c.id, 'all')} download>
                ZIP всех файлов
              </a>
              <a className={styles.download} href={candidateManifestUrl(c.id)} download={`manifest-${c.seq}.json`}>
                Манифест
              </a>
            </div>
            {c.contentHash ? <p className={styles.mono}>{`content_hash ${c.contentHash}`}</p> : null}
          </div>
          <div className={styles.column}>{current?.previewFileId ? <PdfPreview key={current.previewFileId} url={candidateFileUrl(current.previewFileId)} title={`Превью «${current.path}» — тот же файл, что согласуется`} /> : null}</div>
        </div>
      ) : null}
      {(c.checks ?? []).length ? (
        <details className={styles.details} open={c.status === 'assembly_failed'}>
          <summary>{`Проверки сборки: ${c.checks!.length}`}</summary>
          <ul className={styles.checks}>
            {c.checks!.map((k) => {
              const o = OUTCOME_LABEL[k.outcome]!;
              return (
                <li key={k.ordinal} className={styles.check}>
                  <Badge label={o.label} icon={o.icon} tone={o.tone} dashed={o.dashed} />
                  <span className={styles.label}>{CHECK_LABELS[k.code] ?? k.code}</span>
                  <span className={styles.muted}>{[k.path, k.detail].filter(Boolean).join(' — ')}</span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {c.inputs ? (
        <details className={styles.details}>
          <summary>Закреплённые входы</summary>
          <ul className={styles.notes}>
            <li>{`Ревизия расчёта № ${c.inputs.calculationRevision.seq} (${c.inputs.calculationRevision.kind === 'provisional' ? 'предварительная' : 'подтверждённая'})`}</li>
            <li>{c.inputs.reviewRun ? `Прогон проверок: ${c.inputs.reviewRun.status}` : 'Завершённого прогона проверок нет'}</li>
            <li>{`Действующих решений этапа: ${c.inputs.decisions}; версий значений полей: ${c.inputs.fieldVersions}`}</li>
            {c.inputs.drafts.map((d) => (
              <li key={d.id}>{`Приложение «${d.title}» — шаблон «${d.templateName}», ревизия № ${d.revisionSeq}${d.isDemo ? ' (демо)' : ''}`}</li>
            ))}
            {c.inputs.attachments.map((a) => (
              <li key={a.revisionId}>{`Вложение «${a.title}», ревизия № ${a.seq}`}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {(c.eventsAfter ?? []).length ? (
        <details className={styles.details} open={c.current === false}>
          <summary>{`События после сборки: ${c.eventsAfterTotal ?? c.eventsAfter!.length}${(c.eventsAfterTotal ?? 0) > c.eventsAfter!.length ? ` (показаны ${c.eventsAfter!.length}, касающиеся комплекта — первыми)` : ''}`}</summary>
          <ul className={styles.notes}>
            {c.eventsAfter!.map((e) => (
              <li key={e.seq} className={e.affects ? undefined : styles.muted}>
                {`${EVENT_LABELS[e.type] ?? e.type}${e.at ? ` · ${formatDateTime(e.at)}` : ''} · ${e.affects ? 'касается комплекта' : 'не касается комплекта'}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {tracked ? <CandidateHistory candidateId={c.id} version={`${c.etag}:${(c.approvals ?? []).length}:${c.holds?.total ?? 0}`} /> : null}
      {tracked ? <ApprovalActions c={c} onChanged={refresh} /> : null}
    </section>
  );
};
