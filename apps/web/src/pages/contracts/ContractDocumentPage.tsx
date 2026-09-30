import { useRef, useState, type ChangeEvent, type FC } from 'react';
import { useParams } from 'react-router-dom';
import { newUuid } from '../../api/client';
import { getContract, getContractDocument, renameContractDocument, setContractDocumentRoute } from '../../api/contractEndpoints';
import type { IContractDocumentDetail } from '../../api/contractTypes';
import { describeError, stateConflictCurrent } from '../../api/errors';
import type { IRevision } from '../../api/types';
import { uploadContractRevision } from '../../api/upload';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { CONTRACT_ROLE_LABELS } from '../../utils/contractLabels';
import { isPdf, ROUTE_LABELS, ROUTES } from '../../utils/localRecognitionLabels';
import form from '../../styles/form.module.css';
import { RevisionList } from '../sources/RevisionList';

const toRevisions = (doc: IContractDocumentDetail): IRevision[] =>
  doc.revisionList.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    revisionSeq: r.seq,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    mediaType: r.mediaType,
    supersedesRevisionId: r.supersedesRevisionId,
    receivedAt: r.receivedAt,
    occurrences: [],
  }));

/**
 * Документ договора: редакции (новые сверху), выдача оригинала и распознавание по экспорту RDWeb.
 * Новая версия файла — новая редакция; прежняя не меняется и остаётся в исторических снимках (T06A-1).
 */
export const ContractDocumentPage: FC = () => {
  const { documentId = '' } = useParams();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const docRes = useApiResource((signal) => getContractDocument(documentId, signal), documentId);
  const doc = docRes.data;
  const contractId = doc?.contractId ?? '';
  const contractRes = useApiResource((signal) => (contractId ? getContract(contractId, signal) : Promise.resolve(null)), contractId);
  const [title, setTitle] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeSaving, setRouteSaving] = useState(false);

  if (docRes.loading && !doc) return <LoadingState />;
  if (docRes.error && !doc) return <ErrorState error={docRes.error} onRetry={docRes.reload} notFoundTitle="Документ не найден или нет доступа" />;
  if (!doc) return null;

  const contract = contractRes.data;
  const canManage = (contract?.capabilities.includes('contract.manage') ?? false) && contract?.status === 'active';

  const onPick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const result = await uploadContractRevision(doc.id, file, newUuid(), setProgress).promise;
      toast.push({ kind: 'success', text: result.status === 'duplicate' ? `Этот файл уже загружен: ред. ${result.revisionSeq}.` : `Добавлена редакция ${result.revisionSeq}.` });
      docRes.reload();
    } catch (e) {
      const current = stateConflictCurrent(e);
      const other = current && typeof current === 'object' && 'reason' in current && (current as { reason: unknown }).reason === 'content_in_other_document';
      setError(other ? 'Такой файл уже есть в договоре другим документом.' : describeError(e));
    } finally {
      setProgress(null);
    }
  };

  const saveTitle = async (): Promise<void> => {
    if (title === null || !title.trim() || title.trim() === doc.title) {
      setTitle(null);
      return;
    }
    setSaving(true);
    try {
      await renameContractDocument(doc, title.trim());
      setTitle(null);
      docRes.reload();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setSaving(false);
    }
  };

  const saveRoute = async (value: string): Promise<void> => {
    const route = ROUTES.find((r) => r === value);
    if (!route || route === doc.recognitionRoute) return;
    setRouteSaving(true);
    try {
      await setContractDocumentRoute(doc, route);
      toast.push({ kind: 'success', text: `Маршрут распознавания: ${ROUTE_LABELS[route]}.` });
      docRes.reload();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setRouteSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: `/contracts/${doc.contractId}?tab=documents`, label: contract ? `${contract.number} · ${contract.title}` : 'К договору' }}
        title={doc.title}
        subtitle={<Badge tone={doc.role === 'contract' ? 'info' : 'neutral'} icon="file-signature" label={CONTRACT_ROLE_LABELS[doc.role]} />}
      />
      <div className={form.stack}>
        {contractRes.error ? <ErrorState error={contractRes.error} onRetry={contractRes.reload} /> : null}
        {canManage ? (
          <section className={form.section} aria-label="Ведение документа">
            {title === null ? (
              <div className={form.actions}>
                <Button icon="pencil" onClick={() => setTitle(doc.title)}>
                  Переименовать
                </Button>
                <input ref={inputRef} type="file" hidden onChange={(e) => void onPick(e)} />
                <Button variant="primary" icon="upload" loading={progress !== null} onClick={() => inputRef.current?.click()}>
                  {progress !== null ? `Отправка ${Math.round(progress * 100)} %` : 'Загрузить новую редакцию'}
                </Button>
              </div>
            ) : (
              <form
                className={form.stack}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveTitle();
                }}
              >
                <TextField label="Название документа" value={title} onValueChange={setTitle} maxLength={500} required />
                <div className={form.actions}>
                  <Button variant="ghost" onClick={() => setTitle(null)} disabled={saving}>
                    Отмена
                  </Button>
                  <Button variant="primary" type="submit" loading={saving}>
                    Сохранить
                  </Button>
                </div>
              </form>
            )}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {isPdf(doc.latestRevision.mediaType) ? (
              <SelectField
                label="Маршрут распознавания PDF"
                value={doc.recognitionRoute}
                options={ROUTES.map((value) => ({ value, label: ROUTE_LABELS[value] }))}
                onValueChange={(v) => void saveRoute(v)}
                disabled={routeSaving}
                hint="«Авто» — локально только командой; «Разрешено локальное» — автоматически; «Только RDWeb» — локально никогда."
              />
            ) : null}
          </section>
        ) : null}
        <section className={form.stack} aria-labelledby="contract-doc-revisions">
          <h2 id="contract-doc-revisions" className={form.sectionTitle}>
            Редакции
          </h2>
          <RevisionList revisions={toRevisions(doc)} latestRevisionId={doc.latestRevision.id} canWrite={canManage} showOccurrences={false} />
        </section>
      </div>
    </>
  );
};
