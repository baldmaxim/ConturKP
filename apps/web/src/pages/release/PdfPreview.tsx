import { useEffect, useRef, useState, type FC } from 'react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import styles from './Release.module.css';

interface IPdfPreviewProps {
  url: string;
  title: string;
}

const MAX_WIDTH = 1200;

/**
 * Превью файла комплекта (D-032 В-12-2, В-12-10): PDF, полученный конвертацией именно того файла, который будет
 * согласован, — постранично на canvas через pdf.js (без фрейма и без исполнения содержимого, A38). Права проверяет
 * сервер при получении PDF; отметки тестового режима и демо-формы видны на страницах.
 */
export const PdfPreview: FC<IPdfPreviewProps> = ({ url, title }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ url: string; doc: import('pdfjs-dist').PDFDocumentProxy } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPage(1);
    const load = async (): Promise<void> => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      const d = await pdfjs.getDocument({ url, withCredentials: true, disableRange: true, disableStream: true, disableAutoFetch: true }).promise;
      if (cancelled) {
        void d.destroy();
        return;
      }
      setPages(d.numPages);
      setDoc({ url, doc: d });
    };
    load().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'PDF не открылся');
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => () => void doc?.doc.destroy(), [doc]);

  useEffect(() => {
    if (!doc || doc.url !== url) return undefined;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const draw = async (): Promise<void> => {
      const p = await doc.doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: Math.min(MAX_WIDTH / base.width, 2) });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const render = p.render({ canvas, viewport });
      task = render;
      await render.promise;
    };
    draw().catch((e: unknown) => {
      if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) setError(e instanceof Error ? e.message : 'Страница не отрисовалась');
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, url]);

  if (error) return <Notice tone="danger">{`Превью не открылось: ${error}`}</Notice>;
  return (
    <figure className={styles.preview} aria-label={`Превью: ${title}`}>
      <div className={styles.previewBar}>
        <Button variant="ghost" icon="arrow-left" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Предыдущая страница">
          Назад
        </Button>
        <span className={styles.muted} aria-live="polite">
          {pages ? `Страница ${page} из ${pages}` : 'Загрузка…'}
        </span>
        <Button variant="ghost" icon="chevron-right" disabled={!pages || page >= pages} onClick={() => setPage(page + 1)} aria-label="Следующая страница">
          Дальше
        </Button>
      </div>
      <div className={styles.previewCanvas}>
        <canvas ref={canvasRef} />
      </div>
      <figcaption className={styles.muted}>{title}</figcaption>
    </figure>
  );
};
