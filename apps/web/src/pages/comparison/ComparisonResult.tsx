import type { FC } from 'react';
import { getReleaseComparison } from '../../api/sendEndpoints';
import type { IComparisonSide, IComparisonView, TCompareSection } from '../../api/sendTypes';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { MODE_LABEL } from '../../utils/releaseLabels';
import { CHANGE, COMPARE_SECTION, MEASURE, SECTION_ORDER } from '../../utils/sendLabels';
import { ComparisonItems } from './ComparisonItems';
import styles from './Comparison.module.css';

export const sideTitle = (s: IComparisonSide): string => `Этап ${s.stage.seq} «${s.stage.title}» · комплект № ${s.candidateSeq} · ${MODE_LABEL[s.mode] ?? s.mode}`;

const total = (changes: Record<string, number>): number => Object.values(changes).reduce((a, b) => a + b, 0);

const Calculation: FC<{ c: NonNullable<IComparisonView['calculation']> }> = ({ c }) => {
  if (c.state === 'same_revision') return <p className={styles.muted}>Ревизия расчёта у выпусков одна: расчёт и коммерческие показатели не менялись.</p>;
  if (c.state === 'failed') return <Notice tone="danger">{`Сравнение расчёта не построено: ${c.reason ?? 'причина не указана'}. Остальные разделы построены.`}</Notice>;
  return (
    <>
      {c.outdated ? <Notice tone="warning">После сравнения появились новые решения по парам позиций расчёта: запустите сравнение выпусков заново.</Notice> : null}
      {c.totals ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Показатель</th>
                <th scope="col">Было</th>
                <th scope="col">Стало</th>
                <th scope="col">Разница</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(c.totals).map(([measure, t]) => (
                <tr key={measure}>
                  <td>{MEASURE[measure] ?? measure}</td>
                  <td>{t.left}</td>
                  <td>{t.right}</td>
                  <td>{t.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {c.reasons ? <p className={styles.muted}>{`Причины изменений позиций: подтверждено ${c.reasons.confirmed}, гипотез ${c.reasons.hypothesis}, не установлено ${c.reasons.unknown}.`}</p> : null}
      {c.remainder && c.remainder.length > 0 ? <p className={styles.muted}>{`Необъяснённый остаток: ${c.remainder.map((r) => `${MEASURE[r.measure] ?? r.measure} — ${r.amount}`).join('; ')}.`}</p> : null}
      <p className={styles.muted}>Разложение по позициям, вклады и причины — во вкладке «Экономика» этапа правого выпуска, сравнение ревизий расчёта.</p>
    </>
  );
};

/**
 * Результат сравнения двух выпусков: расчёт, разделы с выводами, отдельно — «получено между выпусками». Сравнение
 * построено по закреплённым записям выпусков: текущая папка, рабочий набор источников и поисковый индекс не читаются.
 */
export const ComparisonResult: FC<{ comparisonId: string }> = ({ comparisonId }) => {
  const res = useApiResource((signal) => getReleaseComparison(comparisonId, signal), `release-comparison:${comparisonId}`);
  const c = res.data;
  if (res.error && !c) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!c) return <LoadingState />;
  if (c.status !== 'ready' || !c.sections) return <Notice tone="danger">{`Сравнение не построено: ${c.failureReason ?? 'причина не указана'}.`}</Notice>;
  // Перечитывание тем же ключом сохраняет данные на экране: раскрытые разделы не сворачиваются после записи причины.
  const reload = res.reload;
  const section = (id: TCompareSection) => {
    const s = c.sections![id];
    const n = total(s.changes);
    return (
      <details key={id} className={styles.section}>
        <summary>
          <span>{COMPARE_SECTION[id]}</span>
          <span className={styles.badges}>
            {s.unavailable ? (
              <Badge label="Нет данных у стороны" icon="file-question-mark" tone="warning" dashed />
            ) : (
              <Badge label={n > 0 ? `Изменений: ${n}` : 'Без изменений'} icon={n > 0 ? 'pencil' : 'check'} tone={n > 0 ? 'warning' : 'muted'} />
            )}
          </span>
        </summary>
        <div className={styles.sectionBody}>
          {s.unavailable ? (
            <p className={styles.muted}>У выпуска нет закреплённого прогона проверок: раздел не построен. Это «нет данных», а не «изменений нет».</p>
          ) : (
            <>
              <p className={styles.muted}>
                {id === 'received'
                  ? Object.entries(s.changes).map(([k, v]) => `${(CHANGE[k]?.label ?? k).toLowerCase()} — ${v}`).join('; ') || 'за интервал ничего не получено'
                  : `Было ${s.left}, стало ${s.right}, без изменений ${s.unchanged}${n > 0 ? `; ${Object.entries(s.changes).map(([k, v]) => `${(CHANGE[k]?.label ?? k).toLowerCase()} — ${v}`).join('; ')}` : ''}.`}
              </p>
              {n > 0 ? <ComparisonItems comparisonId={c.id} section={id} canSetReason={c.can.setReason} onReasonChanged={reload} /> : null}
            </>
          )}
        </div>
      </details>
    );
  };
  return (
    <div className={styles.stack}>
      <div className={styles.sides}>
        <div className={styles.side} data-side="left">
          <span className={styles.sideLabel}>Было</span>
          <span>{sideTitle(c.left)}</span>
          <span className={styles.muted}>{`выпущен ${formatDateTime(c.left.releasedAt)}`}</span>
        </div>
        <div className={styles.side} data-side="right">
          <span className={styles.sideLabel}>Стало</span>
          <span>{sideTitle(c.right)}</span>
          <span className={styles.muted}>{`выпущен ${formatDateTime(c.right.releasedAt)}`}</span>
        </div>
      </div>
      <p className={styles.muted}>Сравнение построено по закреплённым записям выпусков: текущие папки, рабочий набор источников и поисковый индекс не читаются.</p>
      <p className={styles.mono}>{`Метод ${c.methodVersion} · хэш результата ${c.resultSha256?.slice(0, 16) ?? '—'}… · ${c.requestedBy.name}, ${formatDateTime(c.createdAt)}`}</p>
      {c.reasons ? <p className={styles.muted}>{`Причины выводов: подтверждено ${c.reasons.confirmed}, гипотез ${c.reasons.hypothesis}, не установлено ${c.reasons.unknown}.`}</p> : null}
      {c.unrecognizedRight > 0 ? <Notice tone="warning">{`В правом выпуске документов без распознавания: ${c.unrecognizedRight}. Их содержание в сравнение не вошло.`}</Notice> : null}
      <details className={styles.section} open>
        <summary>
          <span>Расчёт и коммерческая разница</span>
        </summary>
        <div className={styles.sectionBody}>{c.calculation ? <Calculation c={c.calculation} /> : null}</div>
      </details>
      {SECTION_ORDER.filter((id) => id !== 'received').map(section)}
      <h3 className={styles.title}>Получено между выпусками</h3>
      <p className={styles.muted}>
        {c.interval?.empty ? 'Интервал пуст: входы правого комплекта закреплены не позже левого.' : `Интервал — от закрепления входов левого комплекта до правого: ${formatDateTime(c.interval?.from)} — ${formatDateTime(c.interval?.to)}. Файл вне области выпуска его источником не становится.`}
      </p>
      {section('received')}
    </div>
  );
};
