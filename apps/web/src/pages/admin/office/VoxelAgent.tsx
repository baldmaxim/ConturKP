import type { CSSProperties, FC } from 'react';
import { cx } from '../../../utils/cx';
import type { TOfficeStatus } from './officeStatus';
import type { TOfficePose } from './officeModel';
import styles from './VoxelAgent.module.css';

interface IPart { name: string; x: number; y: number; z: number; w: number; h: number; d: number; color: string }
const PARTS: IPart[] = [
  { name: 'leftLeg', x: 14, y: 31, z: 0, w: 5, h: 10, d: 6, color: '--office-pants' },
  { name: 'rightLeg', x: 21, y: 31, z: 0, w: 5, h: 10, d: 6, color: '--office-pants' },
  { name: 'leftShoe', x: 14, y: 40, z: 1, w: 5, h: 3, d: 8, color: '--office-monitor' },
  { name: 'rightShoe', x: 21, y: 40, z: 1, w: 5, h: 3, d: 8, color: '--office-monitor' },
  { name: 'body', x: 17.5, y: 23, z: 0, w: 12, h: 13, d: 7, color: '--voxel-shirt' },
  { name: 'leftArm', x: 8.5, y: 24, z: 0, w: 5, h: 11, d: 6, color: '--voxel-shirt' },
  { name: 'leftHand', x: 8.5, y: 31, z: 0, w: 5, h: 4, d: 6, color: '--office-skin' },
  { name: 'rightArm', x: 26.5, y: 24, z: 0, w: 5, h: 11, d: 6, color: '--voxel-shirt' },
  { name: 'rightHand', x: 26.5, y: 31, z: 0, w: 5, h: 4, d: 6, color: '--office-skin' },
  { name: 'head', x: 17.5, y: 10, z: 0, w: 14, h: 14, d: 12, color: '--office-skin' },
  { name: 'hair', x: 17.5, y: 4, z: -0.5, w: 15, h: 5, d: 13, color: '--office-hair' },
  { name: 'paper', x: 18, y: 25, z: 7, w: 12, h: 9, d: 1, color: '--office-cup' },
];

/** Небольшая настоящая CSS 3D-модель: не требует WebGL, картинок, загрузки движка или постоянного цикла отрисовки. */
export const VoxelAgent: FC<{ status?: TOfficeStatus; pose?: TOfficePose; frozen?: boolean; className?: string }> = ({ status = 'idle', pose = 'work', frozen = false, className }) => (
  <span className={cx(styles.stage, frozen && styles.frozen, className)} data-status={status} data-pose={pose} aria-hidden="true">
    <span className={styles.shadow} />
    <span className={styles.model}>
      {PARTS.map((part) => (
        <span key={part.name} className={cx(styles.cube, styles[part.name])} style={{ '--x': `${part.x}px`, '--y': `${part.y}px`, '--z': `${part.z}px`, '--w': `${part.w}px`, '--h': `${part.h}px`, '--d': `${part.d}px`, '--voxel-color': `var(${part.color})` } as CSSProperties}>
          <span className={styles.front}>{part.name === 'head' ? <><span className={styles.eyes} /><span className={styles.mouth} /></> : null}</span>
          <span className={styles.back} /><span className={styles.left} /><span className={styles.right} /><span className={styles.top} /><span className={styles.bottom} />
        </span>
      ))}
    </span>
    {status === 'error' || status === 'down' ? <span className={styles.alert}>!</span> : null}
    {pose === 'think' && status === 'working' ? <span className={styles.thought}>…</span> : null}
  </span>
);
