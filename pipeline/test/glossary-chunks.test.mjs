import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanForGlossary } from '../collect-glossary-chunks.mjs';

test('chat text for reviewers drops links, media, quotes and mentions', () => {
  assert.equal(cleanForGlossary('[图片]'), '');
  assert.equal(cleanForGlossary('[引用] 同意 oai 的做法 ↳ 某人: 原话'), '同意 oai 的做法');
  assert.equal(cleanForGlossary('@张三 看这个 https://example.com/x [旺柴]'), '@某人 看这个');
});
