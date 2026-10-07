import type { FC } from 'react';
import { listReleases, releaseArchiveUrl, releaseManifestUrl } from '../../api/releaseEndpoints';
import { Badge } from '../../components/Badge';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { MODE_LABEL, SEND_READINESS } from '../../utils/releaseLabels';
import form from '../../styles/form.module.css';
import styles from './Release.module.css';

/**
 * Выпуски этапа (D-033 В-13-7): неизменяемые записи с манифестом выпуска и точными байтами комплекта; готовность к
 * отправке вычисляется (I01) — удержание после выпуска видно здесь же. Размещение и отправка — этапы 14 и 15.
 * Манифест выпуска и ZIP всех файлов содержат причины решений: у того, кому закрыт предмет решения, их нет (R13-02).
 */
export const ReleasesPanel: FC<{ stageId: string; version: string }> = ({ stageId, version }) => {
  const res = useApiResource((signal) => listReleases(stageId, signal), `releases:${stageId}:${version}`);
  const items = res.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className={form.section} aria-labelledby="release-releases">
      <h3 id="release-releases" className={form.sectionTitle}>
        Выпуски этапа
      </h3>
      <ul className={styles.list}>
        {items.map((r) => {
          if (r.restricted) {
            return (
              <li key={r.id} className={styles.muted}>
                {`Выпуск комплекта № ${r.candidateSeq}: входы закрыты для вас`}
              </li>
            );
          }
          const send = SEND_READINESS[r.sendReadiness.state]!;
          return (
            <li key={r.id} className={styles.release}>
              <span className={styles.label}>{`Выпуск комплекта № ${r.candidateSeq} · ${MODE_LABEL[r.mode] ?? r.mode}`}</span>
              <span className={styles.badges}>
                <Badge label="Выпущено" icon="package-check" tone="success" />
                <Badge label={r.sendReadiness.testRelease ? 'Тестовый — не отправляется' : send.label} icon={r.sendReadiness.testRelease ? 'info' : send.icon} tone={r.sendReadiness.testRelease ? 'warning' : send.tone} />
                {r.sendReadiness.testRelease && r.sendReadiness.state !== 'ready' ? <Badge label={send.label} icon={send.icon} tone={send.tone} /> : null}
              </span>
              <span className={styles.muted}>{`${r.releasedBy.name} · ${formatDateTime(r.releasedAt)} · манифест ${r.manifestSha256.slice(0, 12)}…`}</span>
              <span className={styles.actions}>
                <a className={styles.download} href={releaseArchiveUrl(r.id)} download>
                  ZIP для заказчика
                </a>
                {r.manifestReadable ? (
                  <>
                    <a className={styles.download} href={releaseArchiveUrl(r.id, 'all')} download>
                      ZIP всех файлов
                    </a>
                    <a className={styles.download} href={releaseManifestUrl(r.id)} download={`release-${r.candidateSeq}.json`}>
                      Манифест выпуска
                    </a>
                  </>
                ) : null}
              </span>
              {r.manifestReadable ? null : <span className={styles.muted}>Манифест выпуска закрыт: в нём причины решений по основаниям, недоступным вам.</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
