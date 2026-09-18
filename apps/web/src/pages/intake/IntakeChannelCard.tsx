import type { FC, ReactNode } from 'react';
import type { IIntakeChannel } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { formatDateTime } from '../../utils/datetime';
import { channelErrorLabel, channelOriginLabel, formatSeconds, plural } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './IntakeChannelCard.module.css';

interface IIntakeChannelCardProps {
  channel: IIntakeChannel;
  canScan: boolean;
  canEdit: boolean;
  canDisable: boolean;
  scanning: boolean;
  onScan: () => void;
  onEdit: () => void;
  onDisable: () => void;
}

const freshnessBadge = (channel: IIntakeChannel): ReactNode => {
  if (!channel.active) {
    return <Badge tone="muted" icon="power-off" label="Отключён" />;
  }
  return channel.current ? (
    <Badge tone="success" icon="check" label="Актуален" />
  ) : (
    <Badge tone="warning" icon="clock-alert" dashed label="Не актуален" />
  );
};

/** Карточка наблюдаемой папки: свежесть, последний скан, ошибка, недокопированные файлы. */
export const IntakeChannelCard: FC<IIntakeChannelCardProps> = ({
  channel,
  canScan,
  canEdit,
  canDisable,
  scanning,
  onScan,
  onEdit,
  onDisable,
}) => (
  <li className={list.card}>
    <div className={list.cardHead}>
      <span className={styles.locator}>
        <Icon name="folder" size={16} className={styles.folder} />
        <span>{channel.locator}</span>
      </span>
      {freshnessBadge(channel)}
    </div>

    {channel.active && !channel.current ? (
      <p className={styles.stale}>
        Нет успешного скана в пределах окна свежести ({formatSeconds(channel.freshnessSeconds)}). Неактуальный канал будет блокировать
        выпуск.
      </p>
    ) : null}

    {channel.lastErrorCode ? (
      <div className={styles.error} role="status">
        <Icon name="server-off" size={16} className={styles.errorIcon} />
        <span>
          {channelErrorLabel(channel.lastErrorCode)}
          {channel.lastErrorAt ? ` · с ${formatDateTime(channel.lastErrorAt)} МСК` : ''}
        </span>
      </div>
    ) : null}

    <dl className={list.meta}>
      <dt>Источник</dt>
      <dd>{channelOriginLabel(channel.origin)}</dd>
      <dt>Последний успешный скан</dt>
      <dd className={list.num}>
        {channel.lastSuccessfulScanAt ? (
          `${formatDateTime(channel.lastSuccessfulScanAt)} МСК`
        ) : (
          <span className={styles.absent}>
            <Icon name="file-question-mark" size={16} />
            Нет данных: успешных сканов ещё не было
          </span>
        )}
      </dd>
      {channel.lastScanStartedAt ? (
        <>
          <dt>Последний запуск</dt>
          <dd className={list.num}>{formatDateTime(channel.lastScanStartedAt)} МСК</dd>
        </>
      ) : null}
      <dt>Скан и свежесть</dt>
      <dd>{`каждые ${formatSeconds(channel.scanIntervalSeconds)} · окно ${formatSeconds(channel.freshnessSeconds)}`}</dd>
      {channel.pendingUnstable > 0 ? (
        <>
          <dt>Копируются</dt>
          <dd className={styles.warn}>{`${channel.pendingUnstable} ${plural(channel.pendingUnstable, ['файл ещё копируется', 'файла ещё копируются', 'файлов ещё копируются'])}`}</dd>
        </>
      ) : null}
      {!channel.active && channel.disabledReason ? (
        <>
          <dt>Причина отключения</dt>
          <dd>{channel.disabledReason}</dd>
        </>
      ) : null}
    </dl>

    {canScan || canEdit || canDisable ? (
      <div className={list.rowActions}>
        {canScan && channel.active ? (
          <Button icon="scan-search" loading={scanning} onClick={onScan}>
            Сканировать сейчас
          </Button>
        ) : null}
        {canEdit ? (
          <Button variant="ghost" icon="pencil" onClick={onEdit}>
            Изменить
          </Button>
        ) : null}
        {canDisable && channel.active ? (
          <Button variant="danger" icon="power-off" onClick={onDisable}>
            Отключить…
          </Button>
        ) : null}
      </div>
    ) : null}
  </li>
);
