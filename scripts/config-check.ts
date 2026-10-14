// npm run config:check — какие ключи заданы и корректна ли конфигурация. Значения не выводятся.
import { ConfigError, configReport, inspectTls, loadConfig } from '../packages/config/src/index.ts';

const lines = configReport();
const width = Math.max(...lines.map((l) => l.name.length));
for (const l of lines) {
  const flags = [l.required ? 'обязательно' : '', l.secret ? 'секрет' : ''].filter(Boolean).join(', ');
  console.log(`${l.name.padEnd(width)}  ${l.state.padEnd(9)}  ${l.purpose}${flags ? ` [${flags}]` : ''}`);
}
try {
  const c = loadConfig();
  console.log(`\nконфигурация корректна: режим ${c.env}, ${c.tls ? 'HTTPS' : 'HTTP только loopback'}, разрешённых origin: ${c.allowedOrigins.length}`);
  // Этап 17 (U-02): сертификат и ключ — без вывода их содержимого.
  if (c.tls) {
    const t = inspectTls(c.tls, c.allowedOrigins);
    console.log(`TLS: имена сертификата — ${t.subjectAltNames.join(', ') || 'нет'}; действует до ${t.validTo ?? '—'} (осталось ${t.daysLeft ?? '—'} дн.)`);
    for (const w of t.warnings) console.log(`предупреждение TLS: ${w}`);
    if (t.problems.length > 0) {
      console.log('TLS некорректен:');
      for (const p of t.problems) console.log(`- ${p}`);
      process.exitCode = 2;
    }
  }
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.log('\nконфигурация некорректна:');
  for (const p of err.problems) console.log(`- ${p}`);
  process.exit(2);
}
