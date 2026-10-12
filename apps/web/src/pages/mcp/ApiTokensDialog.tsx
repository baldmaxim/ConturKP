import { useCallback, useEffect, useState, type FC } from 'react';
import { describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { issueApiToken, listApiTokens, revokeApiToken } from '../../api/mcpEndpoints';
import type { IApiToken, IApiTokenList, IIssuedApiToken, TApiTokenClient } from '../../api/mcpTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { CheckboxGroup } from '../../components/CheckboxGroup';
import { Dialog } from '../../components/Dialog';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import styles from './ApiTokens.module.css';

const CLIENTS: { value: TApiTokenClient; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'other', label: 'Другой клиент' },
];
const LIFETIMES = [
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
];
const STATE: Record<IApiToken['state'], { label: string; tone: 'success' | 'neutral' | 'danger'; icon: 'shield-check' | 'clock-alert' | 'shield-x' }> = {
  active: { label: 'Действует', tone: 'success', icon: 'shield-check' },
  expired: { label: 'Срок истёк', tone: 'neutral', icon: 'clock-alert' },
  revoked: { label: 'Отозван', tone: 'danger', icon: 'shield-x' },
};
const PROPOSE = 'propose';

interface IApiTokensDialogProps {
  onClose: () => void;
}

/**
 * Доступ для чат-клиентов (этап 16): персональные токены MCP портала. Токен даёт клиенту права пользователя на чтение
 * и, если выбрано, право предлагать; значение показывается один раз. Согласование, выпуск и отправка через чат недоступны.
 */
export const ApiTokensDialog: FC<IApiTokensDialogProps> = ({ onClose }) => {
  const toast = useToast();
  const [data, setData] = useState<IApiTokenList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [clientKind, setClientKind] = useState<TApiTokenClient>('codex');
  const [lifetime, setLifetime] = useState('30');
  const [scopes, setScopes] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [issued, setIssued] = useState<IIssuedApiToken | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setData(await listApiTokens(signal));
      setLoadError(null);
    } catch (error) {
      if (!signal?.aborted) setLoadError(describeError(error));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErrors({ name: 'Назовите токен, чтобы потом его узнать.' });
      return;
    }
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      const created = await issueApiToken({ name: trimmed, clientKind, propose: scopes.includes(PROPOSE), lifetimeDays: Number(lifetime) as 7 | 30 | 90 });
      setIssued(created);
      setName('');
      setScopes([]);
      await load();
    } catch (error) {
      if (hasCode(error, 'VALIDATION_FAILED')) setErrors(fieldErrorsOf(error));
      setFormError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      toast.push({ kind: 'success', text: 'Токен скопирован.' });
    } catch {
      toast.push({ kind: 'error', text: 'Не удалось скопировать: выделите токен и скопируйте вручную.' });
    }
  };

  const revoke = async (token: IApiToken): Promise<void> => {
    setRevokingId(token.id);
    try {
      await revokeApiToken(token.id);
      if (issued?.id === token.id) setIssued(null);
      toast.push({ kind: 'success', text: `Токен «${token.name}» отозван.` });
      await load();
    } catch (error) {
      toast.push({ kind: 'error', text: describeError(error) });
    } finally {
      setRevokingId(null);
      setConfirmId(null);
    }
  };

  const limitReached = data !== null && data.active >= data.maxActive;

  return (
    <Dialog title="Доступ для чат-клиентов" onClose={onClose} busy={saving} footer={<Button onClick={onClose}>Закрыть</Button>}>
      <Notice tone="info">
        Токен подключает Codex или Cursor к порталу с вашими правами на чтение. Согласование, выпуск, отправка и решения через чат недоступны: чат может
        только предложить, а принимает человек.
      </Notice>
      {issued ? (
        <Notice tone="success">
          <div className={styles.issued}>
            <span>Токен «{issued.name}» выпущен. Значение показано один раз — сохраните его в переменной окружения клиента.</span>
            <code className={styles.secret} data-testid="issued-token">
              {issued.token}
            </code>
            <div className={styles.actions}>
              <Button onClick={() => void copy()}>Скопировать</Button>
              <Button variant="ghost" onClick={() => setIssued(null)}>
                Я сохранил токен
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}
      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      {data === null && !loadError ? <LoadingState /> : null}
      {data !== null ? (
        <>
          <h3 className={styles.sectionTitle}>
            Токены ({data.active} из {data.maxActive} действующих)
          </h3>
          {data.items.length === 0 ? <p className={styles.meta}>Токенов пока нет.</p> : null}
          <ul className={styles.list}>
            {data.items.map((t) => (
              <li key={t.id} className={styles.token} data-state={t.state}>
                <div className={styles.head}>
                  <span className={styles.name}>{t.name}</span>
                  <Badge label={STATE[t.state].label} icon={STATE[t.state].icon} tone={STATE[t.state].tone} />
                </div>
                <span className={styles.meta}>
                  {CLIENTS.find((c) => c.value === t.clientKind)?.label ?? t.clientKind} · <span className={styles.mono}>{t.prefix}…</span> ·{' '}
                  {t.scopes.includes('propose') ? 'чтение и предложения' : 'только чтение'}
                </span>
                <span className={styles.meta}>
                  Действует до {formatDateTime(t.expiresAt)} · {t.lastUsedAt ? `последний вызов ${formatDateTime(t.lastUsedAt)}` : 'ещё не использовался'}
                </span>
                {t.state === 'active' ? (
                  <div className={styles.actions}>
                    {confirmId === t.id ? (
                      <>
                        <Button variant="danger" loading={revokingId === t.id} onClick={() => void revoke(t)}>
                          Отозвать сейчас
                        </Button>
                        <Button variant="ghost" disabled={revokingId === t.id} onClick={() => setConfirmId(null)}>
                          Отмена
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => setConfirmId(t.id)}>Отозвать</Button>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {data.canIssue ? (
            <form
              className={styles.form}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h3 className={styles.sectionTitle}>Новый токен</h3>
              {formError ? <Notice tone="danger">{formError}</Notice> : null}
              {limitReached ? <Notice tone="warning">Действующих токенов уже {data.maxActive}. Отзовите ненужный, чтобы выпустить новый.</Notice> : null}
              <TextField label="Название" required maxLength={100} value={name} onValueChange={setName} error={errors.name} hint="Например: «Codex на рабочем ноутбуке»." />
              <SelectField label="Клиент" value={clientKind} options={CLIENTS} onValueChange={(v) => setClientKind(v as TApiTokenClient)} />
              <SelectField label="Срок действия" value={lifetime} options={LIFETIMES} onValueChange={setLifetime} error={errors.lifetimeDays} />
              <CheckboxGroup
                legend="Права"
                options={[{ value: PROPOSE, label: 'Разрешить предлагать замечания, вопросы, тексты условий и причины' }]}
                selected={scopes}
                onChange={setScopes}
                hint="Чтение материалов ваших тендеров включено всегда. Предложение ничего не меняет, пока его не примет человек."
              />
              <div className={styles.actions}>
                <Button variant="primary" type="submit" icon="key-round" loading={saving} disabled={limitReached}>
                  Выпустить токен
                </Button>
              </div>
            </form>
          ) : (
            <Notice tone="info">Токен выпускает инженер или руководитель: чат-клиент работает с материалами тендеров.</Notice>
          )}
        </>
      ) : null}
    </Dialog>
  );
};
