// Шаги smoke этапа 17 (проект §3, §6, §7.4, §11): эксплуатационные точки на настоящих server + worker. /ready
// сообщает ход очереди и уровень места без чисел; статусы интеграций доступны вошедшему пользователю без адресов и
// ключей; состояние установки — только администратору: схема последней миграции, процессы, очередь, хранилище, копия.
// Вызывается из scripts/smoke.mjs.
export const smokeOperations = async ({ base, api, api2, record, secretMarker }) => {
  const ready = await (await fetch(`${base}/api/v1/ready`)).json();
  record(
    'этап 17: /ready — ход очереди и хранилище без чисел',
    ready.checks?.queue?.ok === true && typeof ready.checks?.storage?.detail === 'string' && !/\d+\s*(МБ|ГБ|MB|GB)/u.test(JSON.stringify(ready)),
    `${ready.checks?.queue?.detail} / ${ready.checks?.storage?.detail}`,
  );
  const st = await api('/integrations/status');
  const items = st.status === 200 ? (await st.json()).items : [];
  record(
    'этап 17: статусы интеграций — уровни проверки без адресов и ключей',
    st.status === 200 && items.some((i) => i.system === 'model' && i.component === 'ModelGateway') && !JSON.stringify(items).includes(secretMarker) && !/https?:\/\//u.test(JSON.stringify(items)),
    `строк ${items.length}`,
  );
  const ops = await api('/admin/operations');
  const body = ops.status === 200 ? await ops.json() : null;
  record(
    'этап 17: состояние установки администратору — схема, процессы, очередь, хранилище',
    ops.status === 200 && body.schema.ok === true && body.schema.version >= 43 && body.processes.some((p) => p.kind === 'worker') && typeof body.storage.blobs.count === 'number',
    body ? `схема ${body.schema.version}, процессов ${body.processes.length}, файлов ${body.storage.blobs.count}` : `HTTP ${ops.status}`,
  );
  const denied = await api2('/admin/operations');
  record('этап 17: инженеру состояние установки закрыто (403)', denied.status === 403, `HTTP ${denied.status}`);
};
