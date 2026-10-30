import type { FC } from 'react';
import { cx } from '../../../utils/cx';
import type { TOfficePose } from './officeModel';
import styles from './Sprite.module.css';

const POSE_CLASS: Record<TOfficePose, string | undefined> = {
  edit: styles.poseEdit,
  read: styles.poseRead,
  run: styles.poseRun,
  web: styles.poseWeb,
  agent: styles.poseAgent,
  think: styles.poseThink,
  work: styles.poseWork,
  wait: styles.poseWait,
  idle: styles.poseIdle,
};

interface IPoseProps {
  pose: TOfficePose;
}

/** Экран монитора: что на нём — зависит от позы. Нарисован в клетках 11×9 внутри вложенного `svg` (он сам обрезает по краю). */
const Screen: FC<IPoseProps> = ({ pose }) => {
  if (pose === 'edit' || pose === 'work') {
    return (
      <g className={styles.lines}>
        <rect x="1" y="1" width="7" height="1" />
        <rect x="2" y="3" width="8" height="1" />
        <rect x="1" y="5" width="5" height="1" />
        <rect x="2" y="7" width="7" height="1" />
      </g>
    );
  }
  if (pose === 'read') {
    return (
      <g className={styles.scroll}>
        <rect x="1" y="0" width="8" height="1" />
        <rect x="1" y="2" width="5" height="1" />
        <rect x="1" y="4" width="7" height="1" />
        <rect x="1" y="6" width="4" height="1" />
        <rect x="1" y="8" width="8" height="1" />
        <rect x="1" y="10" width="5" height="1" />
        <rect x="1" y="12" width="7" height="1" />
        <rect x="1" y="14" width="4" height="1" />
      </g>
    );
  }
  if (pose === 'run') {
    return (
      <g>
        <rect x="1" y="1" width="1" height="1" />
        <rect x="2" y="2" width="1" height="1" />
        <rect x="1" y="3" width="1" height="1" />
        <rect className={styles.cursor} x="4" y="3" width="3" height="1" />
        <rect className={styles.dim} x="1" y="5" width="6" height="1" />
        <rect className={styles.dim} x="1" y="7" width="4" height="1" />
      </g>
    );
  }
  if (pose === 'web') {
    return (
      <g className={styles.globe}>
        <rect x="4" y="1" width="3" height="1" />
        <rect x="2" y="2" width="7" height="1" />
        <rect x="2" y="3" width="1" height="3" />
        <rect x="5" y="3" width="1" height="3" />
        <rect x="8" y="3" width="1" height="3" />
        <rect x="2" y="4" width="7" height="1" />
        <rect x="2" y="6" width="7" height="1" />
        <rect x="4" y="7" width="3" height="1" />
      </g>
    );
  }
  if (pose === 'idle') return <rect className={styles.dim} x="3" y="4" width="5" height="1" />;
  return (
    <g className={styles.dim}>
      <rect x="1" y="1" width="7" height="1" />
      <rect x="2" y="3" width="6" height="1" />
      <rect x="1" y="5" width="5" height="1" />
    </g>
  );
};

/** Облачко над головой: мысль, поручение, «!» — только у поз, где оно есть. */
const Bubble: FC<IPoseProps> = ({ pose }) => {
  if (pose !== 'think' && pose !== 'agent' && pose !== 'wait') return null;
  return (
    <g className={styles.bubble}>
      <rect className={styles.bubbleBg} x="3" y="-7" width="10" height="6" />
      <rect className={styles.bubbleBg} x="7" y="-1" width="2" height="1" />
      <rect className={styles.bubbleBg} x="6" y="0" width="1" height="1" />
      {pose === 'think' ? (
        <g className={styles.bubbleInk}>
          <rect className={styles.dot} x="5" y="-5" width="1" height="1" />
          <rect className={cx(styles.dot, styles.dot2)} x="8" y="-5" width="1" height="1" />
          <rect className={cx(styles.dot, styles.dot3)} x="11" y="-5" width="1" height="1" />
        </g>
      ) : null}
      {pose === 'agent' ? (
        <g className={styles.bubbleInk}>
          <rect x="8" y="-6" width="1" height="1" />
          <rect x="9" y="-5" width="1" height="1" />
          <rect x="5" y="-4" width="6" height="1" />
          <rect x="9" y="-3" width="1" height="1" />
          <rect x="8" y="-2" width="1" height="1" />
        </g>
      ) : null}
      {pose === 'wait' ? (
        <g className={styles.bang}>
          <rect x="8" y="-6" width="1" height="3" />
          <rect x="8" y="-2" width="1" height="1" />
        </g>
      ) : null}
    </g>
  );
};

/** «z z» над клюющим носом: две буквы всплывают по очереди. */
const Snore: FC = () => (
  <g className={styles.snore}>
    <g className={styles.z}>
      <rect x="6" y="-2" width="3" height="1" />
      <rect x="7" y="-1" width="1" height="1" />
      <rect x="6" y="0" width="3" height="1" />
    </g>
    <g className={cx(styles.z, styles.z2)}>
      <rect x="10" y="-4" width="3" height="1" />
      <rect x="11" y="-3" width="1" height="1" />
      <rect x="10" y="-2" width="3" height="1" />
    </g>
  </g>
);

/**
 * Человечек за столом, нарисованный клетками (viewBox в «пикселях», без сглаживания). Цвета — из токенов `--office-*`;
 * рубашку задаёт стол (`--office-shirt`). Поза — класс на корне: анимации живут в CSS и гасятся при
 * `prefers-reduced-motion` и на несвежих данных. Рисунок декоративный: смысл читается из подписи стола.
 */
export const OfficeSprite: FC<IPoseProps> = ({ pose }) => (
  <svg className={cx(styles.sprite, POSE_CLASS[pose])} viewBox="0 -7 32 31" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    {/* Стол и монитор */}
    <rect className={styles.deskTop} x="1" y="15" width="30" height="2" />
    <rect className={styles.deskTop} x="3" y="17" width="2" height="7" />
    <rect className={styles.deskTop} x="27" y="17" width="2" height="7" />
    <rect className={styles.monitor} x="17" y="2" width="13" height="11" />
    <rect className={styles.monitor} x="22" y="13" width="3" height="1" />
    <rect className={styles.monitor} x="21" y="14" width="5" height="1" />
    <rect className={styles.screen} x="18" y="3" width="11" height="9" />
    <svg className={styles.screenInk} x="18" y="3" width="11" height="9" viewBox="0 0 11 9">
      <Screen pose={pose} />
    </svg>
    <rect className={styles.keyboard} x="12" y="14" width="5" height="1" />

    {/* Стул */}
    <g className={styles.chair}>
      <rect x="2" y="7" width="2" height="8" />
      <rect x="3" y="14" width="7" height="1" />
      <rect x="5" y="15" width="2" height="3" />
      <rect x="3" y="18" width="6" height="1" />
    </g>

    {/* Человек */}
    <g className={styles.person}>
      <rect className={styles.shirt} x="4" y="7" width="6" height="7" />
      <g className={styles.head}>
        <rect className={styles.skin} x="5" y="3" width="4" height="4" />
        <rect className={styles.hair} x="5" y="3" width="4" height="2" />
        <rect className={styles.hair} x="4" y="3" width="1" height="3" />
        <rect className={styles.hair} x="8" y="5" width="1" height="1" />
      </g>
      <g className={cx(styles.arm, styles.armB)}>
        <rect className={styles.shirt} x="9" y="10" width="3" height="2" />
        <rect className={styles.skin} x="12" y="12" width="2" height="2" />
      </g>
      <g className={styles.arm}>
        <rect className={styles.shirt} x="10" y="9" width="4" height="2" />
        <rect className={styles.skin} x="14" y="11" width="2" height="2" />
      </g>
      <g className={styles.handUp}>
        <rect className={styles.shirt} x="10" y="3" width="2" height="7" />
        <rect className={styles.skin} x="10" y="1" width="2" height="2" />
      </g>
    </g>

    <Bubble pose={pose} />
    {pose === 'idle' ? <Snore /> : null}
  </svg>
);
