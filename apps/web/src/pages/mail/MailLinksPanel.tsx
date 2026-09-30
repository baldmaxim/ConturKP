import { useState, type FC } from 'react';
import { newUuid } from '../../api/client';
import { listStages, listTenders } from '../../api/endpoints';
import { describeError, hasCode } from '../../api/errors';
import { linkMailMessage, unlinkMailMessage } from '../../api/mailEndpoints';
import type { IMailMessageDetail } from '../../api/mailTypes';
import type { IStage } from '../../api/types';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { LINK_REASON_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Mail.module.css';

interface IMailLinksPanelProps {
  message: IMailMessageDetail;
  onChanged: () => void;
}

const LinkDialog: FC<{ message: IMailMessageDetail; initialTender: string; onClose: () => void; onDone: () => void }> = ({ message, initialTender, onClose, onDone }) => {
  const toast = useToast();
  const tendersRes = useApiResource((signal) => listTenders(signal), 'link-tenders');
  const [tenderId, setTenderId] = useState(initialTender);
  const [stageId, setStageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stagesRes = useApiResource((signal) => (tenderId ? listStages(tenderId, signal) : Promise.resolve({ items: [] as IStage[] })), `link-stages:${tenderId}`);
  const tenders = (tendersRes.data?.items ?? []).filter((t) => t.capabilities.includes('source.write'));

  const submit = async (): Promise<void> => {
    if (!tenderId) {
      setError('Выберите тендер.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await linkMailMessage(message.id, { tenderId, stageId: stageId || null }, newUuid());
      toast.push({ kind: 'success', text: 'Связь с тендером подтверждена.' });
      onDone();
    } catch (e) {
      setError(hasCode(e, 'STATE_CONFLICT') ? 'Письмо уже связано с этим тендером.' : describeError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Связать письмо с тендером"
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="link" loading={busy}>
            Подтвердить связь
          </Button>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <SelectField
        label="Тендер"
        value={tenderId}
        placeholder="Выберите тендер"
        options={tenders.map((t) => ({ value: t.id, label: `${t.code} — ${t.title}` }))}
        onValueChange={(v) => {
          setTenderId(v);
          setStageId('');
        }}
        hint="Только тендеры, где вы ведёте источники."
        required
      />
      <SelectField
        label="Этап"
        value={stageId}
        placeholder="Все этапы тендера"
        options={[{ value: '', label: 'Все этапы тендера' }, ...(stagesRes.data?.items ?? []).map((st) => ({ value: st.id, label: st.title }))]}
        onValueChange={setStageId}
        hint="Письмо войдёт в рабочую область выбранного этапа или всех этапов."
      />
      <Notice tone="info">Связь подтверждает человек: система только предлагает кандидатов. Связь не даёт другим участникам тендера права читать письмо.</Notice>
    </Dialog>
  );
};

/**
 * Связи письма с тендерами (OD-07-7). Кандидаты — по точному коду тендера или номеру TenderHub в теме и
 * тексте, связью они не становятся. Снятие связи письмо, ревизии и исторические снимки не меняет.
 */
export const MailLinksPanel: FC<IMailLinksPanelProps> = ({ message, onChanged }) => {
  const toast = useToast();
  const canLink = message.capabilities.includes('mail.link');
  const [linking, setLinking] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<{ tenderId: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = message.tenderLinks.filter((l) => l.status === 'linked');

  const unlink = async (): Promise<void> => {
    if (!unlinking) return;
    setBusy(true);
    try {
      await unlinkMailMessage(message.id, unlinking.tenderId, newUuid());
      toast.push({ kind: 'success', text: `Связь с тендером ${unlinking.code} снята.` });
      setUnlinking(null);
      onChanged();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={form.section} aria-labelledby="mail-links">
      <div className={form.sectionHead}>
        <h2 id="mail-links" className={form.sectionTitle}>
          Связи с тендерами
        </h2>
        {canLink ? (
          <Button icon="link" onClick={() => setLinking('')}>
            Связать
          </Button>
        ) : null}
      </div>
      {linked.length === 0 ? <p className={list.muted}>Письмо не связано ни с одним видимым вам тендером.</p> : null}
      <ul className={styles.cards}>
        {linked.map((l) => (
          <li key={l.id} className={list.card}>
            <div className={list.cardHead}>
              <AppLink className={list.rowLink} to={`/tenders/${l.tenderId}?tab=mail`}>
                {`${l.tenderCode} — ${l.tenderTitle}`}
              </AppLink>
              <Badge tone="success" icon="link" label={l.stageId ? 'Этап тендера' : 'Весь тендер'} />
            </div>
            <p className={list.muted}>{`Связано ${formatDateTime(l.linkedAt)} МСК`}</p>
            {canLink ? (
              <div className={styles.actions}>
                <Button variant="ghost" icon="x" onClick={() => setUnlinking({ tenderId: l.tenderId, code: l.tenderCode })}>
                  Снять связь
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canLink && message.candidates.length > 0 ? (
        <>
          <h3 className={form.sectionTitle}>Предложения связи</h3>
          <ul className={styles.cards}>
            {message.candidates.map((c) => (
              <li key={c.tenderId} className={list.card}>
                <div className={list.cardHead}>
                  <span className={list.cardTitle}>{`${c.tenderCode} — ${c.tenderTitle}`}</span>
                  <Badge tone="neutral" icon="info" dashed label="Предложение" />
                </div>
                <p className={list.muted}>{`Основание: ${c.reasons.map((r) => LINK_REASON_LABELS[r]).join(', ')}`}</p>
                <div className={styles.actions}>
                  <Button icon="link" onClick={() => setLinking(c.tenderId)}>
                    Подтвердить…
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {linking !== null ? (
        <LinkDialog
          message={message}
          initialTender={linking}
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            onChanged();
          }}
        />
      ) : null}
      {unlinking ? (
        <ConfirmDialog title="Снять связь с тендером?" confirmLabel="Снять связь" confirmIcon="x" busy={busy} onConfirm={() => void unlink()} onClose={() => setUnlinking(null)}>
          {`Письмо перестанет входить в рабочую область тендера ${unlinking.code}. Само письмо, его ревизии и исторические снимки не меняются.`}
        </ConfirmDialog>
      ) : null}
    </section>
  );
};
