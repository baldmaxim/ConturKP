import { useState, type FC, type ReactNode } from 'react';
import { describeError } from '../../api/errors';
import { getRecognitionRun, listFragments } from '../../api/recognitionEndpoints';
import type { IEvidenceFragment, IRecognitionPage } from '../../api/types';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import {
  FRAGMENT_ORIGIN,
  RECOGNITION_PAGE_STATUS,
  fragmentKindLabel,
  plural,
  recognitionWarningLabel,
} from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './RecognitionPanel.module.css';

interface IRecognitionRunViewProps {
  runId: string;
}

/** Размер порции выдачи фрагментов: совпадает с пределом контракта по умолчанию. */
const PAGE_SIZE = 200;

interface IMorePages {
  key: string;
  items: IEvidenceFragment[];
  nextCursor: string | null;
}

const pageBadge = (page: IRecognitionPage): ReactNode => {
  const meta = RECOGNITION_PAGE_STATUS[page.status];
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={meta.label} />;
};

const originBadge = (fragment: IEvidenceFragment): ReactNode => {
  const meta = FRAGMENT_ORIGIN[fragment.origin];
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={meta.label} />;
};

/** Страницы прогона и фрагменты выбранной страницы. Текст и описание модели различимы (I06). */
export const RecognitionRunView: FC<IRecognitionRunViewProps> = ({ runId }) => {
  const [pageIndex, setPageIndex] = useState<number | null>(null);
  const runRes = useApiResource((signal) => getRecognitionRun(runId, signal), runId);
  const fragmentsKey = `${runId}:${pageIndex ?? 'none'}`;
  const fragmentsRes = useApiResource(
    (signal) => (pageIndex === null ? Promise.resolve(null) : listFragments(runId, { pageIndex, limit: PAGE_SIZE }, signal)),
    fragmentsKey,
  );
  // Следующие порции догружаются по курсору, который выдал сервер. Перезапрос первой страницы
  // выдачу не продолжает: часть фрагментов осталась бы недоступной (R04-07).
  const [more, setMore] = useState<IMorePages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const appended = more && more.key === fragmentsKey ? more : null;
  const fragments = [...(fragmentsRes.data?.items ?? []), ...(appended?.items ?? [])];
  const nextCursor = appended ? appended.nextCursor : (fragmentsRes.data?.nextCursor ?? null);

  const loadMore = (): void => {
    if (pageIndex === null || nextCursor === null || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setMoreError(null);
    listFragments(runId, { pageIndex, limit: PAGE_SIZE, cursor: nextCursor })
      .then((next) => {
        setMore({ key: fragmentsKey, items: [...(appended?.items ?? []), ...next.items], nextCursor: next.nextCursor });
      })
      .catch((reason: unknown) => setMoreError(reason))
      .finally(() => setLoadingMore(false));
  };

  if (runRes.loading && !runRes.data) {
    return <LoadingState />;
  }
  if (runRes.error || !runRes.data) {
    return <Notice tone="danger">{`Прогон не загружен: ${describeError(runRes.error)}`}</Notice>;
  }
  const run = runRes.data;
  const warnings = run.quality.warnings ?? [];

  return (
    <div className={styles.runView}>
      {run.missingPages.length > 0 ? (
        <Notice tone="warning">
          {`Не распознаны ${plural(run.missingPages.length, ['страница', 'страницы', 'страниц'])}: ${run.missingPages
            .map((i) => i + 1)
            .join(', ')}. Фрагментов по ним нет — открывайте оригинал.`}
        </Notice>
      ) : null}

      <ul className={styles.pages}>
        {run.pages.map((page) => (
          <li key={page.pageIndex}>
            <button
              type="button"
              className={pageIndex === page.pageIndex ? `${styles.page} ${styles.pageActive}` : styles.page}
              onClick={() => setPageIndex(pageIndex === page.pageIndex ? null : page.pageIndex)}
              disabled={page.status !== 'recognized'}
            >
              <span className={styles.pageNo}>{page.pageLabel ?? String(page.pageIndex + 1)}</span>
              <span className={list.muted}>
                {page.sheetLabel ? `лист ${page.sheetLabel}` : page.rotation ? `поворот ${page.rotation}°` : 'страница файла'}
              </span>
              {pageBadge(page)}
            </button>
          </li>
        ))}
      </ul>

      {pageIndex === null ? (
        <p className={list.muted}>Выберите страницу, чтобы увидеть её фрагменты.</p>
      ) : fragmentsRes.loading && !fragmentsRes.data ? (
        <LoadingState />
      ) : fragmentsRes.error ? (
        <Notice tone="danger">{`Фрагменты не загружены: ${describeError(fragmentsRes.error)}`}</Notice>
      ) : (
        <ul className={styles.fragments}>
          {fragments.map((fragment) => (
            <li key={fragment.id} className={styles.fragment}>
              <div className={styles.fragmentHead}>
                {originBadge(fragment)}
                <span className={list.muted}>{fragmentKindLabel(fragment.fragmentKind)}</span>
                {fragment.partTotal > 1 && (
                  <span className={list.muted}>
                    часть {fragment.partIndex + 1} из {fragment.partTotal}
                  </span>
                )}
              </div>
              <p className={styles.text}>{fragment.text.length > 400 ? `${fragment.text.slice(0, 400)}…` : fragment.text}</p>
              {fragment.warnings.length > 0 ? (
                <ul className={styles.warnings}>
                  {fragment.warnings.map((code) => (
                    <li key={code}>{recognitionWarningLabel(code)}</li>
                  ))}
                </ul>
              ) : null}
              {fragment.externalCropUrl ? (
                // Ссылка экспорта показывается текстом: портал её не загружает и не открывает (A38).
                <p className={styles.crop} title="Внешняя ссылка экспорта — портал её не загружает">
                  {`Ссылка экспорта: ${fragment.externalCropUrl}`}
                </p>
              ) : null}
              <AppLink to={`/evidence/${fragment.id}`} className={styles.evidenceLink}>
                <Icon name="scan-search" size={16} />
                <span>Открыть участок оригинала</span>
              </AppLink>
            </li>
          ))}
          {fragments.length === 0 ? <li className={list.muted}>На странице нет фрагментов.</li> : null}
        </ul>
      )}

      {warnings.length > 0 ? (
        <details className={styles.history}>
          <summary className={styles.summary}>{`Замечания разбора: ${warnings.length}`}</summary>
          <ul className={styles.warnings}>
            {warnings.map((w) => (
              <li key={w.code}>{`${recognitionWarningLabel(w.code)} — ${w.count} (${w.sample})`}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {moreError ? <Notice tone="danger">{`Следующая порция не загружена: ${describeError(moreError)}`}</Notice> : null}
      {nextCursor !== null ? (
        <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Загрузка…' : `Показать ещё (загружено ${fragments.length})`}
        </Button>
      ) : null}
    </div>
  );
};
