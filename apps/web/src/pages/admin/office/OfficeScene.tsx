import { useEffect, useRef, useState, type FC } from 'react';
import { Notice } from '../../../components/Notice';
import type { IOfficeModel, TOfficeRole } from './officeModel';
import type { IOfficeSceneController, IOfficeSceneProps } from './officeSceneRenderer';
import styles from './Office.module.css';

/** Движок и Three.js попадают в отдельный chunk и загружаются только на странице офиса. */
export const OfficeScene: FC<{ office: IOfficeModel; selectedRole: TOfficeRole; frozen: boolean; onSelect: (role: TOfficeRole) => void }> = (props) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<IOfficeSceneController | null>(null);
  const latest = useRef<IOfficeSceneProps>(props);
  latest.current = props;
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    void import('./officeSceneRenderer').then(({ mountOfficeScene }) => {
      if (disposed || !canvas.current) return;
      try {
        controller.current = mountOfficeScene(canvas.current, latest.current, () => {
          controller.current?.dispose();controller.current = null;
          if (!disposed) setUnavailable(true);
        });
      } catch {
        setUnavailable(true);
      }
    }).catch(() => { if (!disposed) setUnavailable(true); });
    return () => { disposed = true; controller.current?.dispose(); controller.current = null; };
  }, []);

  useEffect(() => { controller.current?.update(props); }, [props.office, props.selectedRole, props.frozen, props.onSelect]);

  return unavailable
    ? <Notice tone="info">Объёмный вид недоступен в этом браузере. Выберите сотрудника ниже или откройте «Список»: все задания доступны.</Notice>
    : <canvas ref={canvas} className={styles.scene} role="img" aria-label="Объёмный офис: рабочие места по ролям и комната отдыха. Выберите сотрудника мышью или кнопками под сценой." />;
};
