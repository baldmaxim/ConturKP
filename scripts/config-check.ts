// npm run config:check — какие ключи заданы и корректна ли конфигурация. Значения не выводятся.
import { ConfigError, configReport, loadConfig } from '../packages/config/src/index.ts';

const lines = configReport();
const width = Math.max(...lines.map((l) => l.name.length));
for (const l of lines) {
  const flags = [l.required ? 'обязательно' : '', l.secret ? 'секрет' : ''].filter(Boolean).join(', ');
  console.log(`${l.name.padEnd(width)}  ${l.state.padEnd(9)}  ${l.purpose}${flags ? ` [${flags}]` : ''}`);
}
try {
  const c = loadConfig();
  console.log(`\nконфигурация корректна: режим ${c.env}, ${c.tls ? 'HTTPS' : 'HTTP только loopback'}, разрешённых origin: ${c.allowedOrigins.length}`);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.log('\nконфигурация некорректна:');
  for (const p of err.problems) console.log(`- ${p}`);
  process.exit(2);
}
