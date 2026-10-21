import type { FC } from 'react';
import { cx } from '../../../utils/cx';
import type { TIdleActivity } from './officeModel';
import styles from './Sprite.module.css';

/** Голова на месте (x 10–14, y 0–4) или опущенная — для телефона и дивана. */
const Head: FC = () => (
  <g className={styles.head}>
    <rect className={styles.skin} x="10" y="0" width="4" height="4" />
    <rect className={styles.hair} x="10" y="0" width="4" height="2" />
    <rect className={styles.hair} x="9" y="0" width="1" height="3" />
  </g>
);

const Legs: FC = () => (
  <g>
    <rect className={cx(styles.pants, styles.legA)} x="9" y="11" width="2" height="7" />
    <rect className={cx(styles.pants, styles.legB)} x="13" y="11" width="2" height="7" />
  </g>
);

const Torso: FC = () => <rect className={styles.shirt} x="9" y="4" width="6" height="7" />;

const ArmDown: FC<{ x: number }> = ({ x }) => (
  <g>
    <rect className={styles.shirt} x={x} y="5" width="2" height="5" />
    <rect className={styles.skin} x={x} y="10" width="2" height="1" />
  </g>
);

const Pose: FC<{ activity: TIdleActivity }> = ({ activity }) => {
  if (activity === 'coffee') {
    return (
      <g>
        <Legs />
        <Torso />
        <Head />
        <ArmDown x={7} />
        <g className={styles.sip}>
          <rect className={styles.shirt} x="15" y="5" width="2" height="3" />
          <rect className={styles.skin} x="17" y="6" width="2" height="2" />
          <rect className={styles.cup} x="18" y="3" width="3" height="3" />
          <rect className={styles.cup} x="21" y="4" width="1" height="1" />
          <g className={cx(styles.snore, styles.steam)}>
            <rect x="19" y="0" width="1" height="2" />
            <rect x="21" y="-1" width="1" height="2" />
          </g>
        </g>
      </g>
    );
  }
  if (activity === 'stretch') {
    return (
      <g>
        <Legs />
        <Torso />
        <Head />
        <g className={styles.stretch}>
          <rect className={styles.shirt} x="7" y="2" width="2" height="4" />
          <rect className={styles.skin} x="7" y="0" width="2" height="2" />
          <rect className={styles.shirt} x="15" y="2" width="2" height="4" />
          <rect className={styles.skin} x="15" y="0" width="2" height="2" />
        </g>
      </g>
    );
  }
  if (activity === 'walk') {
    return (
      <g className={styles.walker}>
        <Legs />
        <Torso />
        <Head />
        <ArmDown x={7} />
        <ArmDown x={15} />
      </g>
    );
  }
  if (activity === 'phone') {
    return (
      <g>
        <Legs />
        <Torso />
        <g className={styles.bow}>
          <Head />
        </g>
        <ArmDown x={7} />
        <rect className={styles.shirt} x="15" y="6" width="2" height="2" />
        <rect className={styles.skin} x="16" y="8" width="2" height="2" />
        <rect className={styles.phone} x="16" y="5" width="2" height="4" />
        <rect className={styles.phoneGlow} x="17" y="6" width="1" height="2" />
      </g>
    );
  }
  return (
    <g>
      <rect className={styles.sofa} x="2" y="6" width="20" height="8" />
      <rect className={styles.sofa} x="2" y="12" width="20" height="5" />
      <rect className={styles.sofa} x="1" y="9" width="3" height="8" />
      <rect className={styles.sofa} x="20" y="9" width="3" height="8" />
      <rect className={styles.pants} x="9" y="12" width="8" height="2" />
      <rect className={styles.shirt} x="9" y="7" width="6" height="6" />
      <g className={styles.bow}>
        <rect className={styles.skin} x="10" y="3" width="4" height="4" />
        <rect className={styles.hair} x="10" y="3" width="4" height="2" />
        <rect className={styles.hair} x="9" y="3" width="1" height="3" />
      </g>
      <g className={styles.snore}>
        <g className={styles.z}>
          <rect x="15" y="-1" width="3" height="1" />
          <rect x="16" y="0" width="1" height="1" />
          <rect x="15" y="1" width="3" height="1" />
        </g>
        <g className={cx(styles.z, styles.z2)}>
          <rect x="19" y="-4" width="3" height="1" />
          <rect x="20" y="-3" width="1" height="1" />
          <rect x="19" y="-2" width="3" height="1" />
        </g>
      </g>
    </g>
  );
};

/**
 * Отдыхающий человечек, нарисованный клетками, как и работающий: пьёт кофе, потягивается, прогуливается, читает
 * телефон или спит на диване. Рубашку задаёт карточка (`--office-shirt`). Прогулка не выходит за свой холст: `svg`
 * обрезает по краю, горизонтальной прокрутки не будет. Рисунок декоративный.
 */
export const LoungeSprite: FC<{ activity: TIdleActivity }> = ({ activity }) => (
  <svg
    className={cx(styles.sprite, activity === 'sofa' && styles.loungeSofa)}
    viewBox="0 -5 24 25"
    shapeRendering="crispEdges"
    aria-hidden="true"
    focusable="false"
  >
    <Pose activity={activity} />
  </svg>
);
