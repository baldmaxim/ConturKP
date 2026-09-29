import { useRef, useState, type ChangeEvent, type FC } from 'react';
import { listContractDocuments } from '../../api/contractEndpoints';
import type { IContract, IContractDocument, TContractRole } from '../../api/contractTypes';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { newUuid } from '../../api/client';
import { uploadContractDocument } from '../../api/upload';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { CONTRACT_ROLE_LABELS } from '../../utils/contractLabels';
import { formatDateTime } from '../../utils/datetime';
import { formatBytes, RECOGNITION_STATUS } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Contracts.module.css';

interface IContractDocumentsPanelProps {
  contract: IContract;
}

const REASONS: Record<string, string> = {
  main_document_exists: 'У договора уже есть основной документ: новую версию загрузите редакцией основного документа.',
  main_document_missing: 'Допсоглашение и приложение ссылаются на основной документ — сначала загрузите его.',
  content_in_other_document: 'Такой файл уже есть в договоре другим документом.',
};

const reasonOf = (error: unknown): string | null => {
  const current = stateConflictCurrent(error);
  const reason = current && typeof current === 'object' && 'reason' in current ? String((current as { reason: unknown }).reason) : null;
  return reason ? (REASONS[reason] ?? null) : null;
};

const runBadge = (doc: IContractDocument) => {
  const status = doc.latestRevision.runStatus as keyof typeof RECOGNITION_STATUS | null;
  if (!status) return <Badge tone="neutral" icon="file-question-mark" dashed label="Не распознан" />;
  const meta = RECOGNITION_STATUS[status];
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={meta.label} />;
};

/**
 * Документы договора (T06A-2): основной договор, допсоглашения и приложения — самостоятельные документы
 * со ссылкой на основной. Файл хранится всегда; распознаётся только PDF по экспорту RDWeb (D-022 OD-4).
 */
export const ContractDocumentsPanel: FC<IContractDocumentsPanelProps> = ({ contract }) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const docsRes = useApiResource((signal) => listContractDocuments(contract.id, signal), contract.id);
  const [role, setRole] = useState<TContractRole>('contract');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canUpload = contract.capabilities.includes('contract.manage') && contract.status === 'active';
  const docs = docsRes.data?.items ?? [];
  const main = docs.find((d) => d.role === 'contract') ?? null;
  const roleOptions = (main ? (['addendum', 'appendix'] as const) : (['contract'] as const)).map((r) => ({ value: r, label: CONTRACT_ROLE_LABELS[r] }));
  const effectiveRole: TContractRole = main ? (role === 'contract' ? 'addendum' : role) : 'contract';

  const onPick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const result = await uploadContractDocument(contract.id, file, effectiveRole, main?.id ?? null, newUuid(), setProgress).promise;
      toast.push({
        kind: 'success',
        text: result.status === 'duplicate' ? `Этот файл уже есть в договоре: «${result.document.title}», ред. ${result.revisionSeq}.` : `Загружено: «${result.document.title}».`,
      });
      docsRes.reload();
    } catch (e) {
      setError(reasonOf(e) ?? describeError(e));
    } finally {
      setProgress(null);
    }
  };

  if (docsRes.loading && !docsRes.data) return <LoadingState />;
  if (docsRes.error) return <ErrorState error={docsRes.error} onRetry={docsRes.reload} />;

  return (
    <div className={form.stack}>
      {canUpload ? (
        <section className={form.section} aria-labelledby="contract-upload">
          <div className={form.sectionHead}>
            <h2 id="contract-upload" className={form.sectionTitle}>
              Загрузка документа
            </h2>
          </div>
          <SelectField
            label="Роль документа"
            value={effectiveRole}
            options={roleOptions}
            onValueChange={(v) => setRole(v as TContractRole)}
            hint={main ? `Допсоглашение и приложение ссылаются на основной документ «${main.title}».` : 'Первым загружается основной договор.'}
          />
          <input ref={inputRef} type="file" hidden onChange={(e) => void onPick(e)} />
          <div className={form.actions}>
            <Button variant="primary" icon="upload" loading={progress !== null} onClick={() => inputRef.current?.click()}>
              {progress !== null ? `Отправка ${Math.round(progress * 100)} %` : 'Выбрать файл'}
            </Button>
          </div>
          <p className={list.muted}>Повтор того же файла не создаёт новую редакцию. Сканы и .docx хранятся, но в поиск попадает только распознанный PDF.</p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </section>
      ) : contract.status === 'archived' ? (
        <Notice tone="info" icon="archive">
          Договор в архиве: документы видны, новые не загружаются.
        </Notice>
      ) : null}
      {docs.length === 0 ? (
        <EmptyState icon="files" title="Документов пока нет" text="У договора ещё нет загруженных документов." />
      ) : (
        <ul className={styles.cards}>
          {docs.map((doc) => (
            <li key={doc.id} className={list.card}>
              <div className={list.cardHead}>
                <AppLink className={list.rowLink} to={`/contract-documents/${doc.id}`}>
                  {doc.title}
                </AppLink>
                <Badge tone={doc.role === 'contract' ? 'info' : 'neutral'} icon="file-signature" label={CONTRACT_ROLE_LABELS[doc.role]} />
              </div>
              <dl className={list.meta}>
                <dt>Редакция</dt>
                <dd className={list.num}>{`${doc.latestRevision.seq} из ${doc.revisions}`}</dd>
                <dt>Получена</dt>
                <dd className={list.num}>{formatDateTime(doc.latestRevision.receivedAt)} МСК</dd>
                <dt>Размер</dt>
                <dd className={list.num}>{formatBytes(doc.latestRevision.sizeBytes)}</dd>
                <dt>Распознавание</dt>
                <dd>{runBadge(doc)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
