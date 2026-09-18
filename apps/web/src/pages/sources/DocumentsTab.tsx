import type { FC, ReactNode } from 'react';
import { listDocuments } from '../../api/sourceEndpoints';
import type { IDocument } from '../../api/types';
import { AppLink } from '../../components/AppLink';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { docTypeLabel } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';

interface IDocumentsTabProps {
  stageId: string;
}

const docLink = (doc: IDocument, stageId: string): string => `/documents/${doc.id}?stage=${stageId}`;

const receivedText = (doc: IDocument): ReactNode =>
  doc.latestReceivedAt ? `${formatDateTime(doc.latestReceivedAt)} МСК` : <span className={list.muted}>нет данных</span>;

/** Документы тендера этапа: название, тип, число редакций, последнее поступление. */
export const DocumentsTab: FC<IDocumentsTabProps> = ({ stageId }) => {
  const { data, error, loading, reload } = useApiResource((signal) => listDocuments(stageId, signal), stageId);

  if (loading && !data) {
    return <LoadingState />;
  }
  if (error) {
    return <ErrorState error={error} onRetry={reload} />;
  }
  const items = [...(data?.items ?? [])].sort((a, b) => (b.latestReceivedAt ?? '').localeCompare(a.latestReceivedAt ?? ''));
  if (items.length === 0) {
    return (
      <EmptyState
        icon="files"
        title="Документов ещё нет"
        text="Документ появляется, когда файл из загрузки или наблюдаемой папки зарегистрирован как редакция."
      />
    );
  }

  return (
    <section className={form.stack} aria-label="Документы этапа">
      <div className={list.tableWrap}>
        <table className={list.table}>
          <thead>
            <tr>
              <th scope="col">Название</th>
              <th scope="col">Тип</th>
              <th scope="col">Шифр</th>
              <th scope="col" className={list.right}>
                Редакций
              </th>
              <th scope="col">Последнее поступление, МСК</th>
            </tr>
          </thead>
          <tbody>
            {items.map((doc) => (
              <tr key={doc.id}>
                <td>
                  <AppLink className={list.rowLink} to={docLink(doc, stageId)}>
                    {doc.title}
                  </AppLink>
                </td>
                <td>{docTypeLabel(doc.docType)}</td>
                <td className={list.mono}>{doc.docCode ?? <span className={list.muted}>не указан</span>}</td>
                <td className={`${list.num} ${list.right}`}>{doc.revisions}</td>
                <td className={list.num}>{doc.latestReceivedAt ? formatDateTime(doc.latestReceivedAt) : <span className={list.muted}>нет данных</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={list.cards}>
        {items.map((doc) => (
          <li key={doc.id} className={list.card}>
            <AppLink className={list.rowLink} to={docLink(doc, stageId)}>
              {doc.title}
            </AppLink>
            <dl className={list.meta}>
              <dt>Тип</dt>
              <dd>{docTypeLabel(doc.docType)}</dd>
              {doc.docCode ? (
                <>
                  <dt>Шифр</dt>
                  <dd className={list.mono}>{doc.docCode}</dd>
                </>
              ) : null}
              <dt>Редакций</dt>
              <dd className={list.num}>{doc.revisions}</dd>
              <dt>Поступление</dt>
              <dd className={list.num}>{receivedText(doc)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
};
