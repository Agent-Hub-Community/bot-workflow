import {test} from 'node:test';
import assert from 'node:assert/strict';
import {weeklyWindow} from './weekly-window.mjs';

test('Beijing Monday boundary, independent of machine timezone', () => {
  const before = weeklyWindow({now:'2026-09-27T15:59:59Z'});
  const after = weeklyWindow({now:'2026-09-27T16:00:00Z'});
  assert.equal(before.from,'2026-09-14');
  assert.equal(after.from,'2026-09-21');
  assert.equal(after.through,'2026-09-27');
  assert.equal(after.windowStart,'2026-09-20T16:00:00.000Z');
  assert.equal(after.cutoff,'2026-09-27T16:00:00.000Z');
  assert.equal(after.calendarWeek,true);
  assert.equal(after.days,7);
});

test('default crosses month and year; equivalent instants agree', () => {
  const a = weeklyWindow({now:'2027-01-04T00:00:00+08:00'});
  const b = weeklyWindow({now:'2027-01-03T16:00:00Z'});
  assert.deepEqual(a,b);
  assert.equal(a.from,'2026-12-28');
  assert.equal(a.through,'2027-01-03');
});

test('explicit leap-day interval is not labeled calendar week', () => {
  const range = weeklyWindow({now:'2024-03-05T00:00:00Z',from:'2024-02-28',through:'2024-03-01'});
  assert.equal(range.days,3);
  assert.equal(range.calendarWeek,false);
  assert.equal(range.cutoff,'2024-03-01T16:00:00.000Z');
});

test('rejects bad dates, incomplete bounds and future cutoff', () => {
  const now='2026-09-29T01:00:00Z';
  for (const input of [
    {from:'2026-02-30',through:'2026-03-01'},
    {from:'2026-09-21'},
    {from:'2026-09-28',through:'2026-09-21'},
    {from:'2026-09-28',through:'2026-10-04'},
    {now:'2026-09-29T01:00:00'},
  ]) assert.throws(()=>weeklyWindow({now,...input}));
});
