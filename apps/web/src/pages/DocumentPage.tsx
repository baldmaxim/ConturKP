import type { FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getTender } from '../api/endpoints';
import { getDocument } from '../api/sourceEndpoints';
import type { IDocument, IDocumentDetail } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { useApiResource } from '../hooks/useApiResource';
import { docTypeLabel } from '../utils/sourceLabels';
import form from '../styles/form.module.css';
import { DocumentMetaEditor } from './sources/DocumentMetaEditor';
import { RevisionList } from './sources/RevisionList';

/** Карточка документа: метаданные, редакции и происхождения, ссылки на оригиналы. */
export const DocumentPage: FC = () => {
  const { documentId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const docRes = useApiResource((signal) => getDocument(documentId, signal), documentId);
  const doc = docRes.data;
  const tenderId = doc?.tenderId ?? '';
  const tenderRes = useApiResource((signal) => (tenderId ? getTender(tenderId, signal) : Promise.resolve(null)), tenderId);

  if (docRes.loading && !doc) {
    return <LoadingState />;
  }
  if (docRes.error && !doc) {
    return <ErrorState error={docRes.error} onRetry={docRes.reload} notFoundTitle="Документ не найден или нет доступа" />;
  }
  if (!doc) {
    return null;
  }

  const stageId = searchParams.get('stage');
  const back = stageId
    ? { to: `/stages/${stageId}?tab=documents`, label: 'К этапу' }
    : { to: `/tenders/${doc.tenderId}`, label: tenderRes.data ? `${tenderRes.data.code} · ${tenderRes.data.title}` : 'К тендеру' };
  const canWrite = tenderRes.data?.capabilities.includes('source.write') ?? false;

  // PATCH возвращает документ без списка редакций — список сохраняем.
  const onChanged = (next: IDocument): void =>
    docRes.setData((current: IDocumentDetail | null) => ({ ...next, revisionList: current?.revisionList ?? [] }));

  return (
    <>
      <PageHeader back={back} title={doc.title} subtitle={<span>{docTypeLabel(doc.docType)}</span>} />
      <div className={form.stack}>
        {tenderRes.error ? <ErrorState error={tenderRes.error} onRetry={tenderRes.reload} /> : null}
        <DocumentMetaEditor key={doc.id} doc={doc} canWrite={canWrite} onChanged={onChanged} />
        <section className={form.stack} aria-labelledby="doc-revisions">
          <h2 id="doc-revisions" className={form.sectionTitle}>
            Редакции
          </h2>
          <RevisionList revisions={doc.revisionList} latestRevisionId={doc.latestRevisionId} canWrite={canWrite} />
        </section>
      </div>
    </>
  );
};
