import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const DAY = 86400000;
function dateValue(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00Z`);
  assert.ok(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value, 'Invalid date');
  return ms;
}
const format = ms => new Date(ms).toISOString().slice(0, 10);

export function weeklyWindow({now = new Date().toISOString(), from, through} = {}) {
  assert.match(now, /T.*(?:Z|[+-]\d{2}:\d{2})$/, 'now requires explicit timezone');
  const instant = Date.parse(now);
  assert.ok(Number.isFinite(instant), 'Invalid now');
  assert.equal(Boolean(from), Boolean(through), 'Supply both from and through');
  const today = format(instant + 8 * 3600000);
  if (!from) {
    const day = dateValue(today);
    const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
    from = format(monday - 7 * DAY);
    through = format(monday - DAY);
  }
  const start = dateValue(from), last = dateValue(through);
  assert.ok(last >= start, 'Reversed range');
  const cutoff = last + DAY - 8 * 3600000;
  assert.ok(cutoff <= instant, 'Range not complete; use an explicitly labeled partial report');
  return {
    kind: 'weekly', timezone: 'Asia/Shanghai', from, through,
    windowStart: new Date(start - 8 * 3600000).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    days: (last - start) / DAY + 1,
    calendarWeek: last - start === 6 * DAY && new Date(start).getUTCDay() === 1,
    mode: 'preview',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {values} = parseArgs({options:{
      now:{type:'string'}, from:{type:'string'}, through:{type:'string'},
    }});
    console.log(JSON.stringify(weeklyWindow(values), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
