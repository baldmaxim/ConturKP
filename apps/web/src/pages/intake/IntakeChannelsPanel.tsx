import { useState, type FC, type ReactNode } from 'react';
import { describeError } from '../../api/errors';
import { listIntakeChannels, scanIntakeChannel } from '../../api/sourceEndpoints';
import type { IIntakeChannel } from '../../api/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import form from '../../styles/form.module.css';
import { DisableChannelDialog } from './DisableChannelDialog';
import { IntakeChannelCard } from './IntakeChannelCard';
import { IntakeChannelDialog } from './IntakeChannelDialog';
import styles from './IntakeChannelsPanel.module.css';

interface IIntakeChannelsPanelProps {
  tenderId: string;
  /** Глобальная admin.intake: создание и любая настройка каналов. */
  canAdmin: boolean;
  /** source.write в тендере: «Сканировать сейчас». */
  canScan: boolean;
  /** hold.resolve в тендере: отключение канала с причиной. */
  canDisable: boolean;
}

type TDialog = { kind: 'create' } | { kind: 'edit'; channel: IIntakeChannel } | { kind: 'disable'; channel: IIntakeChannel } | null;

/** Каналы поступления тендера — наблюдаемые папки. */
export const IntakeChannelsPanel: FC<IIntakeChannelsPanelProps> = ({ tenderId, canAdmin, canScan, canDisable }) => {
  const toast = useToast();
  const [dialog, setDialog] = useState<TDialog>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const { data, error, loading, reload, setData } = useApiResource((signal) => listIntakeChannels(tenderId, signal), tenderId);

  const replace = (channel: IIntakeChannel): void =>
    setData((current) => {
      if (!current) {
        return current;
      }
      const exists = current.items.some((c) => c.id === channel.id);
      return { items: exists ? current.items.map((c) => (c.id === channel.id ? channel : c)) : [...current.items, channel] };
    });

  const scan = async (channel: IIntakeChannel): Promise<void> => {
    setScanningId(channel.id);
    try {
      const result = await scanIntakeChannel(channel.id);
      toast.push({
        kind: 'success',
        text: result.created ? 'Сканирование поставлено в очередь.' : 'Сканирование этой папки уже в очереди.',
      });
      reload();
    } catch (err) {
      toast.push({ kind: 'error', text: `Сканирование не запущено: ${describeError(err)}` });
    } finally {
      setScanningId(null);
    }
  };

  const onStale = (message: string): void => {
    setDialog(null);
    toast.push({ kind: 'info', text: message });
    reload();
  };

  const addButton = canAdmin ? (
    <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'create' })}>
      Добавить папку
    </Button>
  ) : null;

  const renderBody = (): ReactNode => {
    if (loading && !data) {
      return <LoadingState />;
    }
    if (error && !data) {
      return <ErrorState error={error} onRetry={reload} />;
    }
    const items = data?.items ?? [];
    if (items.length === 0) {
      return (
        <EmptyState
          icon="inbox"
          title="Наблюдаемых папок нет"
          text={
            canAdmin
              ? 'Добавьте папку на сервере: новые файлы из неё будут поступать в тендер автоматически.'
              : 'Наблюдаемые папки подключает администратор портала. Файлы можно загрузить вручную на странице этапа.'
          }
          action={addButton}
        />
      );
    }
    return (
      <>
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        <ul className={styles.grid}>
          {items.map((channel) => (
            <IntakeChannelCard
              key={channel.id}
              channel={channel}
              canScan={canScan}
              canEdit={canAdmin}
              canDisable={canDisable && !canAdmin}
              scanning={scanningId === channel.id}
              onScan={() => void scan(channel)}
              onEdit={() => setDialog({ kind: 'edit', channel })}
              onDisable={() => setDialog({ kind: 'disable', channel })}
            />
          ))}
        </ul>
      </>
    );
  };

  return (
    <section className={form.stack} aria-label="Каналы поступления">
      <div className={form.sectionHead}>
        <p className={styles.lead}>Наблюдаемые папки: сервер периодически сканирует их и принимает новые файлы в тендер.</p>
        <div className={styles.actions}>
          <Button variant="ghost" icon="refresh-cw" onClick={reload} loading={loading && Boolean(data)}>
            Обновить
          </Button>
          {data && data.items.length > 0 ? addButton : null}
        </div>
      </div>
      {renderBody()}

      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <IntakeChannelDialog
          tenderId={tenderId}
          channel={dialog.kind === 'edit' ? dialog.channel : null}
          onClose={() => setDialog(null)}
          onSaved={(channel) => {
            setDialog(null);
            replace(channel);
            toast.push({ kind: 'success', text: dialog.kind === 'edit' ? 'Настройки папки сохранены.' : 'Папка добавлена.' });
          }}
          onReload={() => onStale('Данные канала перечитаны.')}
        />
      ) : null}
      {dialog?.kind === 'disable' ? (
        <DisableChannelDialog
          channel={dialog.channel}
          onClose={() => setDialog(null)}
          onDisabled={(channel) => {
            setDialog(null);
            replace(channel);
            toast.push({ kind: 'success', text: 'Папка отключена.' });
          }}
          onStale={onStale}
        />
      ) : null}
    </section>
  );
};
