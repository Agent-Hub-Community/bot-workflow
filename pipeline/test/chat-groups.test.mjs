import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { load } from '../../lib/newspaper-root.mjs';
import { chatGroups, collectedChatGroups, joinGroups } from '../chat-groups.mjs';
import { chatrooms } from '../groups.example.mjs';

const { groups: publicGroups } = await load('lib/groups.mjs');

const ids = publicGroups.map(group => group.id);

test('the template covers every public group with a distinct placeholder', () => {
  assert.deepEqual(Object.keys(chatrooms).sort(), [...ids].sort());
  const groups = joinGroups(chatrooms);
  assert.deepEqual(groups.map(group => group.id), ids, 'reader order is kept');
  assert.equal(new Set(groups.map(group => group.username)).size, groups.length);
  for (const [i, { username, ...publicFields }] of groups.entries()) assert.deepEqual(publicFields, publicGroups[i]);
});

test('a group without a chatroom username is refused', () => {
  const { 'group-1': _, ...rest } = chatrooms;
  assert.throws(() => joinGroups(rest), /No chatroom username for group-1/);
});

test('the private config gives every public group a distinct chatroom', { skip: !existsSync(new URL('../groups.private.mjs', import.meta.url)) && 'no groups.private.mjs' }, async () => {
  const groups = await chatGroups();
  assert.deepEqual(groups.map(group => group.id), ids);
  assert.equal(new Set(groups.map(group => group.username)).size, groups.length);
  for (const group of groups) assert.match(group.username, /^\d+@chatroom$/);
  assert.deepEqual((await collectedChatGroups('2026-09-29')).map(group => group.id), ['group-1', 'group-2', 'group-3']);
});
