// Collects every day from FROM through THROUGH into BATCH_DIR/<date>/, one collect-daily.mjs run per day.
// This was `prepare-week-d.mjs collect`; the public prepare-week-d.mjs keeps `generate` and `package`.
//   WX_ACTIVITY_HOME=... node "$PIPELINE/collect-batch.mjs" FROM THROUGH BATCH_DIR
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [from, through, directory] = process.argv.slice(2);
if (!directory || ![from, through].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date))) {
  throw new Error('Usage: collect-batch.mjs FROM THROUGH BATCH_DIR');
}
const dates = [];
for (let day = Date.parse(`${from}T00:00:00Z`); day <= Date.parse(`${through}T00:00:00Z`); day += 86400000) {
  dates.push(new Date(day).toISOString().slice(0, 10));
}
if (!dates.length || dates.length > 31) throw new Error('Expected at most 31 dates');
const out = path.resolve(directory);
await mkdir(out, { recursive: true, mode: 0o700 });
const script = fileURLToPath(new URL('collect-daily.mjs', import.meta.url));
// Serialize reads against the account daemon; generation can run independently.
for (const date of dates) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, date], {
      env: { ...process.env, DAILY_OUTPUT_DIR: path.join(out, date) }, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`collect-daily.mjs ${date}: exit ${code}`)));
  });
}
