import { useState, type FC } from 'react';
import { archiveContractLink, createContractLink, listContractLinks, updateContractLink } from '../../api/contractEndpoints';
import type { IContract, IContractLink } from '../../api/contractTypes';
import { listStages, listTenders } from '../../api/endpoints';
import { describeError, hasCode } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Contracts.module.css';

interface IContractLinksPanelProps {
  contract: IContract;
}

type TDialog = { kind: 'create' } | { kind: 'edit'; link: IContractLink } | { kind: 'archive'; link: IContractLink } | null;

const NO_STAGE = '';

interface ILinkDialogProps {
  contract: IContract;
  link: IContractLink | null;
  onClose: () => void;
  onDone: () => void;
}

// Тендер выбирается из тех, где пользователь ведёт источники: подтверждение связи требует source.write.
const LinkDialog: FC<ILinkDialogProps> = ({ contract, link, onClose, onDone }) => {
  const toast = useToast();
  const idempotency = useIdempotencyKey();
  const tenders = useApiResource((signal) => listTenders(signal), 'link-tenders');
  const [tenderId, setTenderId] = useState(link?.tenderId ?? '');
  const [stageId, setStageId] = useState(link?.stageId ?? NO_STAGE);
  const [note, setNote] = useState(link?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const stages = useApiResource((signal) => (tenderId ? listStages(tenderId, signal) : Promise.resolve(null)), tenderId);
  const tenderOptions = (tenders.data?.items ?? []).filter((t) => t.capabilities.includes('source.write')).map((t) => ({ value: t.id, label: `${t.code} · ${t.title}` }));
  const stageOptions = [{ value: NO_STAGE, label: 'Без этапа' }, ...(stages.data?.items ?? []).map((s) => ({ value: s.id, label: `№ ${s.seq}. ${s.title}` }))];

  const submit = async (): Promise<void> => {
    if (!tenderId) {
      setError('Выберите тендер.');
      return;
    }
    setSaving(true);
    setError(null);
    const body = { stageId: stageId || null, note: note.trim() || null };
    try {
      if (link) await updateContractLink(link, body);
      else await createContractLink(contract.id, { tenderId, ...body }, idempotency.keyFor({ tenderId, ...body }));
      idempotency.reset();
      toast.push({ kind: 'success', text: link ? 'Связь изменена.' : 'Связь с тендером подтверждена.' });
      onDone();
    } catch (e) {
      if (hasCode(e, 'IDEMPOTENCY_KEY_REUSED')) idempotency.reset();
      setError(describeError(e));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={link ? 'Изменить связь с тендером' : 'Связать договор с тендером'}
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="link" loading={saving}>
            {link ? 'Сохранить' : 'Подтвердить связь'}
          </Button>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {link ? (
        <p>{`${link.tender.code} · ${link.tender.title}`}</p>
      ) : (
        <SelectField
          label="Тендер"
          value={tenderId}
          options={tenderOptions}
          placeholder={tenders.loading ? 'Загрузка…' : 'Выберите тендер'}
          onValueChange={(v) => {
            setTenderId(v);
            setStageId(NO_STAGE);
          }}
          hint="Только тендеры, где вы ведёте источники."
          required
        />
      )}
      <SelectField label="Этап (необязательно)" value={stageId} options={stageOptions} onValueChange={setStageId} disabled={!tenderId} />
      <TextField label="Примечание" value={note} onValueChange={setNote} maxLength={500} autoComplete="off" />
      <Notice tone="info">
        Связь не расширяет поиск: документы договора лишь предлагаются кандидатами в состав этапов тендера и ищутся после явного
        включения.
      </Notice>
    </Dialog>
  );
};

/** Связи договора с тендерами (D-022 OD-1): многие ко многим, подтверждает человек, архив без удаления. */
export const ContractLinksPanel: FC<IContractLinksPanelProps> = ({ contract }) => {
  const toast = useToast();
  const linksRes = useApiResource((signal) => listContractLinks(contract.id, signal), contract.id);
  const [dialog, setDialog] = useState<TDialog>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const canLink = contract.capabilities.includes('contract.link');
  const links = linksRes.data?.items ?? [];

  const done = (): void => {
    setDialog(null);
    linksRes.reload();
  };

  const archive = async (link: IContractLink): Promise<void> => {
    if (reason.trim().length < 3) return;
    setBusy(true);
    try {
      await archiveContractLink(link, reason.trim());
      toast.push({ kind: 'success', text: 'Связь перенесена в архив.' });
      setReason('');
      done();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  if (linksRes.loading && !linksRes.data) return <LoadingState />;
  if (linksRes.error) return <ErrorState error={linksRes.error} onRetry={linksRes.reload} />;

  return (
    <div className={form.stack}>
      <div className={form.sectionHead}>
        <p className={list.muted}>Показаны тендеры, карточка которых вам видна.</p>
        {canLink && contract.status === 'active' ? (
          <Button variant="primary" icon="link" onClick={() => setDialog({ kind: 'create' })}>
            Связать с тендером
          </Button>
        ) : null}
      </div>
      {!canLink ? <Notice tone="info">Связь подтверждает пользователь с правом «Связь с тендерами» — его выдаёт администратор договоров.</Notice> : null}
      {links.length === 0 ? (
        <EmptyState icon="link" title="Связей нет" text="Договор пока не связан ни с одним видимым вам тендером." />
      ) : (
        <ul className={styles.cards}>
          {links.map((l) => (
            <li key={l.id} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{`${l.tender.code} · ${l.tender.title}`}</span>
                {l.status === 'active' ? <Badge tone="success" icon="link" label="Действует" /> : <Badge tone="neutral" icon="archive" dashed label="В архиве" />}
              </div>
              <dl className={list.meta}>
                <dt>Этап</dt>
                <dd>{l.stageTitle ?? <span className={list.muted}>не указан</span>}</dd>
                <dt>Примечание</dt>
                <dd>{l.note ?? <span className={list.muted}>—</span>}</dd>
                <dt>Подтвердил</dt>
                <dd>{`${l.confirmedBy.displayName}, ${formatDateTime(l.confirmedAt)} МСК`}</dd>
                {l.archiveReason ? (
                  <>
                    <dt>Причина архива</dt>
                    <dd>{l.archiveReason}</dd>
                  </>
                ) : null}
              </dl>
              {canLink && l.status === 'active' ? (
                <div className={styles.actions}>
                  <Button icon="pencil" onClick={() => setDialog({ kind: 'edit', link: l })}>
                    Изменить
                  </Button>
                  <Button icon="archive" onClick={() => setDialog({ kind: 'archive', link: l })}>
                    В архив
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <LinkDialog contract={contract} link={dialog.kind === 'edit' ? dialog.link : null} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog?.kind === 'archive' ? (
        <Dialog
          title="Перенести связь в архив"
          onClose={() => setDialog(null)}
          busy={busy}
          onSubmit={() => void archive(dialog.link)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>
                Отмена
              </Button>
              <Button variant="primary" type="submit" icon="archive" loading={busy} disabled={reason.trim().length < 3}>
                В архив
              </Button>
            </>
          }
        >
          <p>Исторические снимки этапов останутся прежними; в рабочий состав документы договора больше не предлагаются.</p>
          <TextField label="Причина" value={reason} onValueChange={setReason} required maxLength={500} autoComplete="off" />
        </Dialog>
      ) : null}
    </div>
  );
};
