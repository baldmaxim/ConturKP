import { useEffect, useRef, useState, type FC } from 'react';
import { useParams } from 'react-router-dom';
import { getEvidence } from '../../api/recognitionEndpoints';
import type { IEvidenceDetail } from '../../api/types';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { useApiResource } from '../../hooks/useApiResource';
import { bboxSpaceMatchesViewport, bboxToRect, polygonToPoints, type IRect } from '../../utils/bbox';
import { FRAGMENT_ORIGIN, fragmentKindLabel, recognitionWarningLabel } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './EvidenceViewer.module.css';

const MAX_WIDTH = 1400;

interface IRender {
  rect: IRect | null;
  polygon: { x: number; y: number }[];
  spaceMatches: boolean | null;
}

/**
 * Доказательство: участок локального оригинала PDF с выделением. Страница рисуется в браузере
 * через pdf.js — сервер отдаёт координаты и сам файл, а внешний crop_url из экспорта не
 * загружается никогда (A38). Если координат нет, страница всё равно открывается: отсутствие
 * рамки честнее рамки наугад (A17, I18).
 */
export const EvidenceViewer: FC = () => {
  const { fragmentId = '' } = useParams();
  const res = useApiResource((signal) => getEvidence(fragmentId, signal), fragmentId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [render, setRender] = useState<IRender | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const fragment: IEvidenceDetail | null = res.data;

  useEffect(() => {
    if (!fragment?.contentUrl || fragment.pageIndex === null) {
      return undefined;
    }
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const draw = async (): Promise<void> => {
      setRenderError(null);
      const pdfjs = await import('pdfjs-dist');
      // Воркер берётся из сборки того же источника: CDN не используется, worker-src 'self'.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      // pdf.js 5 не использует eval, поэтому script-src 'self' не ослабляется.
      const loading = pdfjs.getDocument({
        url: fragment.contentUrl!,
        withCredentials: true,
        disableRange: true,
        disableStream: true,
        disableAutoFetch: true,
      });
      const doc = await loading.promise;
      if (cancelled) {
        void doc.destroy();
        return;
      }
      const page = await doc.getPage(fragment.pageIndex! + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_WIDTH / base.width, 2);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) {
        void doc.destroy();
        return;
      }
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('canvas недоступен');
      }
      const renderTask = page.render({ canvas, canvasContext: context, viewport });
      task = renderTask;
      await renderTask.promise;
      if (cancelled) {
        void doc.destroy();
        return;
      }
      const space = fragment.bboxSpace ?? 'page_rotated';
      const rotation = fragment.rotation ?? 0;
      setRender({
        rect: fragment.bboxNorm ? bboxToRect(fragment.bboxNorm, space, rotation, viewport) : null,
        polygon: fragment.polygonNorm ? polygonToPoints(fragment.polygonNorm, space, rotation, viewport) : [],
        spaceMatches: bboxSpaceMatchesViewport({ widthPx: fragment.pageWidthPx, heightPx: fragment.pageHeightPx }, viewport),
      });
      void doc.destroy();
    };
    draw().catch((error: unknown) => {
      if (!cancelled) {
        setRenderError(error instanceof Error ? error.message : 'страница не отрисована');
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [fragment?.contentUrl, fragment?.pageIndex, fragment?.bboxSpace, fragment?.rotation]);

  if (res.loading && !fragment) {
    return <LoadingState />;
  }
  if (res.error || !fragment) {
    return <ErrorState error={res.error} onRetry={res.reload} notFoundTitle="Доказательство не найдено или нет доступа" />;
  }

  const origin = FRAGMENT_ORIGIN[fragment.origin];
  const pageNo = fragment.pageIndex === null ? null : fragment.pageIndex + 1;

  return (
    <>
      <PageHeader
        title="Доказательство"
        subtitle={`${fragmentKindLabel(fragment.fragmentKind)}${pageNo ? ` · страница ${pageNo}` : ''}`}
        back={fragment.documentId ? { to: `/documents/${fragment.documentId}`, label: 'К документу' } : undefined}
      />
      <section className={form.section} aria-label="Текст фрагмента">
        <div className={styles.head}>
          <Badge tone={origin.tone} icon={origin.icon} dashed={origin.dashed} label={origin.label} />
          {fragment.derivedModelRef ? <span className={list.muted}>{`Источник описания: ${fragment.derivedModelRef}`}</span> : null}
        </div>
        <p className={styles.text}>{fragment.text}</p>
        <dl className={list.meta}>
          <dt>Страница файла</dt>
          <dd className={list.num}>{fragment.pageLabel ?? (pageNo ? String(pageNo) : '—')}</dd>
          <dt>Лист по штампу</dt>
          <dd className={list.num}>{fragment.sheetLabel ?? '—'}</dd>
          <dt>Блок экспорта</dt>
          <dd className={list.mono}>{fragment.externalBlockId ?? '—'}</dd>
          <dt>Поворот страницы</dt>
          <dd className={list.num}>{`${fragment.rotation ?? 0}°`}</dd>
        </dl>
        {fragment.warnings.length > 0 ? (
          <Notice tone="warning">{fragment.warnings.map(recognitionWarningLabel).join('; ')}</Notice>
        ) : null}
        {fragment.externalCropUrl ? (
          <p className={styles.crop}>{`Ссылка экспорта (портал её не загружает): ${fragment.externalCropUrl}`}</p>
        ) : null}
      </section>

      <section className={form.section} aria-label="Участок оригинала">
        {fragment.runStatus === 'partial' ? (
          <Notice tone="warning">Распознавание документа неполное: часть страниц без фрагментов.</Notice>
        ) : null}
        {fragment.pageStatus === 'missing' ? (
          <Notice tone="warning">Страница не распознана — фрагментов по ней нет, открывайте оригинал целиком.</Notice>
        ) : null}
        {!fragment.bboxNorm ? (
          <Notice tone="info">У фрагмента нет координат — показана вся страница оригинала без выделения.</Notice>
        ) : null}
        {render?.spaceMatches === false ? (
          <Notice tone="warning">
            Размеры страницы в экспорте не совпали с размерами страницы PDF: выделение может быть смещено. Сверяйтесь с текстом.
          </Notice>
        ) : null}
        {renderError ? <Notice tone="danger">{`Страница не отрисована: ${renderError}`}</Notice> : null}
        {fragment.contentUrl ? (
          <div className={styles.stage}>
            <canvas ref={canvasRef} className={styles.canvas} aria-label={`Страница ${pageNo ?? ''} оригинала`} />
            {render?.rect ? (
              <div
                className={styles.highlight}
                style={{ left: render.rect.left, top: render.rect.top, width: render.rect.width, height: render.rect.height }}
              />
            ) : null}
            {render && render.polygon.length >= 3 ? (
              <svg className={styles.polygon} viewBox={`0 0 ${canvasRef.current?.width ?? 0} ${canvasRef.current?.height ?? 0}`}>
                <polygon points={render.polygon.map((p) => `${p.x},${p.y}`).join(' ')} />
              </svg>
            ) : null}
          </div>
        ) : null}
        {fragment.contentUrl ? (
          <a className={styles.open} href={fragment.contentUrl} target="_blank" rel="noopener">
            Открыть оригинал целиком
          </a>
        ) : null}
      </section>
    </>
  );
};
