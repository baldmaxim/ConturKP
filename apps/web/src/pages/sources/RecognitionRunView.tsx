import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { isAbortError } from '../../api/client';
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
  // Выбор другой страницы немедленно снимает накопленные порции и их ошибку.
  const selectPage = (next: number | null): void => {
    setPageIndex(next);
    setMore(null);
    setMoreError(null);
  };

  const runRes = useApiResource((signal) => getRecognitionRun(runId, signal), runId);
  const fragmentsKey = `${runId}:${pageIndex ?? 'none'}`;
  const fragmentsRes = useApiResource(
    (signal) => (pageIndex === null ? Promise.resolve(null) : listFragments(runId, { pageIndex, limit: PAGE_SIZE }, signal)),
    fragmentsKey,
  );
  // Следующие порции догружаются по курсору, который выдал сервер. Перезапрос первой страницы
  // выдачу не продолжает: часть фрагментов осталась бы недоступной (R04-07).
  const [more, setMore] = useState<IMorePages | null>(null);
  // Ход и ошибка догрузки принадлежат ключу страницы: поздний ответ прежней страницы не
  // имеет права ни блокировать кнопку новой, ни показывать на ней свою ошибку (R04-15).
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<{ key: string; reason: unknown } | null>(null);
  const keyRef = useRef(fragmentsKey);
  keyRef.current = fragmentsKey;
  const moreAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      // Выбрана другая страница: догрузка прежней отменяется, её результат уже ничей.
      moreAbort.current?.abort();
      moreAbort.current = null;
    },
    [fragmentsKey],
  );
  const loadingMore = loadingMoreKey === fragmentsKey;
  // Всё, что показано и что можно догрузить, принадлежит текущему ключу. База ещё не
  // пришла — нет ни фрагментов, ни курсора: выдача прежней страницы под номером новой
  // и уход её курсора с чужим pageIndex недопустимы (R04-15).
  const base = fragmentsRes.data;
  const appended = base && more && more.key === fragmentsKey ? more : null;
  const fragments = base ? [...base.items, ...(appended?.items ?? [])] : [];
  const nextCursor = base ? (appended ? appended.nextCursor : base.nextCursor) : null;
  const shownMoreError = moreError && moreError.key === fragmentsKey && base ? moreError.reason : null;

  const loadMore = (): void => {
    if (pageIndex === null || base === null || nextCursor === null || loadingMore) {
      return;
    }
    const key = fragmentsKey;
    const shown = appended?.items ?? [];
    const controller = new AbortController();
    moreAbort.current?.abort();
    moreAbort.current = controller;
    setLoadingMoreKey(key);
    setMoreError(null);
    listFragments(runId, { pageIndex, limit: PAGE_SIZE, cursor: nextCursor }, controller.signal)
      .then((next) => {
        if (keyRef.current !== key) {
          return;
        }
        setMore({ key, items: [...shown, ...next.items], nextCursor: next.nextCursor });
      })
      .catch((reason: unknown) => {
        if (keyRef.current !== key || controller.signal.aborted || isAbortError(reason)) {
          return;
        }
        setMoreError({ key, reason });
      })
      .finally(() => {
        setLoadingMoreKey((cur) => (cur === key ? null : cur));
      });
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
    // Ключ показанной страницы виден в DOM: по нему проверяется, что выдача и её отсутствие
    // относятся именно к выбранной странице, в том числе в промежуточных кадрах (R04-15).
    <div className={styles.runView} data-page-key={fragmentsKey}>
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
              onClick={() => selectPage(pageIndex === page.pageIndex ? null : page.pageIndex)}
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

      {shownMoreError ? <Notice tone="danger">{`Следующая порция не загружена: ${describeError(shownMoreError)}`}</Notice> : null}
      {nextCursor !== null ? (
        <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Загрузка…' : `Показать ещё (загружено ${fragments.length})`}
        </Button>
      ) : null}
    </div>
  );
};
