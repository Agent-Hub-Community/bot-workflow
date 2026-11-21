import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageDaily } from '../package-daily.mjs';
import { checkBotMessage } from '../../lib/bot-message.mjs';

test('packageDaily packages Antigravity drafts, auto-mounts media attachments, and builds bot-input.json', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthub-pkg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const date = '2026-11-20';
  const batch = path.join(dir, 'batch');
  const dayDir = path.join(batch, date);
  const mediaDir = path.join(dayDir, 'media', 'group-1');
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, 'm0002.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const emptyGroup = (id, label) => ({
    date, cutoff: '2026-11-20T16:00:00.000Z', group: { id, label },
    coverage: { count: 0, completeDay: true }, messages: [],
  });
  for (const [id, label] of [['group-2', '二群'], ['group-3', '三群'], ['group-4', '四群'], ['group-5', '五群']]) {
    await writeFile(path.join(dayDir, `${id}.input.json`), JSON.stringify(emptyGroup(id, label)));
    await writeFile(path.join(dayDir, `${id}.raw.json`), '[]');
  }

  const raw1 = [
    { local_id: 1, timestamp: 1795140000, time: '2026-11-20 10:00:00', type: '文本', sender: 'Alice', content: '测试新框架效果不错' },
    { local_id: 2, timestamp: 1795140060, time: '2026-11-20 10:01:00', type: '图片', sender: 'Alice', content: '[图片]' },
    { local_id: 3, timestamp: 1795140120, time: '2026-11-20 10:02:00', type: '文件', sender: 'Bob', content: '[文件] report.pdf (2.1 MB, 未下载)' },
  ];
  const input1 = {
    date, cutoff: '2026-11-20T16:00:00.000Z', group: { id: 'group-1', label: '一群' },
    coverage: { count: 3, completeDay: true },
    messages: [
      { id: 'm0001', time: '2026-11-20 10:00:00', type: '文本', speaker: 'p1', content: '测试新框架效果不错' },
      { id: 'm0002', time: '2026-11-20 10:01:00', type: '图片', speaker: 'p1', content: '[图片]', image: { quality: 'original', file: 'media/group-1/m0002.jpg' } },
      { id: 'm0003', time: '2026-11-20 10:02:00', type: '文件', speaker: 'p2', content: '[文件] report.pdf (2.1 MB, 未下载)' },
    ],
  };
  await writeFile(path.join(dayDir, 'group-1.raw.json'), JSON.stringify(raw1));
  await writeFile(path.join(dayDir, 'group-1.input.json'), JSON.stringify(input1));
  await writeFile(path.join(mediaDir, 'm0003.pdf'), Buffer.from('%PDF-1.4 demo'));
  await writeFile(path.join(dayDir, 'group-1.media.json'), JSON.stringify([
    { id: 'm0002', kind: 'image', quality: 'original', format: 'jpg', md5: 'imgmd5', file: 'media/group-1/m0002.jpg' },
    { id: 'm0003', kind: 'file', name: 'report.pdf', format: 'pdf', bytes: 13, md5: 'pdfmd5', file: 'media/group-1/m0003.pdf' },
  ]));
  await writeFile(path.join(dayDir, 'group-1.draft.json'), JSON.stringify({
    heading: '新框架实测与报告附件',
    theme: '群友晒出实测截图并附上 PDF 报告',
    stories: [{
      category: 'Agent 工程',
      title: '新框架实测表现',
      text: '有群友测试了新框架并晒出对比截图，并发延迟比旧方案降了一半，另一位群友顺手附上了完整测试报告供大家复现验证。',
      emphasis: ['测试了新框架并晒出对比截图', '不存在的片段会被自动丢弃'],
      aiComment: '截图配 PDF，这波汇报比周报还正规。',
      evidence_ids: ['m0001', 'm0002', 'm0003'],
      resources: [{ kind: 'code', label: '框架仓库', url: 'https://github.com/example/framework?tab=readme' }],
    }],
    image_alts: { m0002: '新框架基准对比截图' },
  }));

  const { issues, botInput, warnings } = await packageDaily({ date, batch, log: () => {} });
  assert.equal(warnings.length, 1);
  const g1 = issues[0].pages.find(p => p.id === 'group-1');
  assert.equal(g1.stories.length, 1);
  assert.deepEqual(g1.stories[0].emphasis, ['测试了新框架并晒出对比截图']);
  assert.equal(g1.stories[0].resources[0].url, 'https://github.com/example/framework?tab=readme');
  assert.equal(g1.stories[0].discussion.length, 3);
  assert.deepEqual(g1.stories[0].discussion[1].attachments, [
    { kind: 'image', src: 'attachments/media/imgmd5.jpg', alt: '新框架基准对比截图' },
  ]);
  assert.deepEqual(g1.stories[0].discussion[2].attachments, [
    { kind: 'file', href: 'attachments/files/pdfmd5.pdf', name: 'report.pdf', bytes: 13 },
  ]);
  assert.ok(existsSync(path.join(batch, 'attachments/media/imgmd5.jpg')));
  assert.ok(existsSync(path.join(batch, 'attachments/files/pdfmd5.pdf')));

  const botMsg = `${botInput.firstLine}\n${botInput.overviewUrl}\n\n【一群】新框架实测晒出对比截图，群友还顺手甩出完整 PDF 测试报告。`;
  const checked = checkBotMessage(botMsg, botInput);
  assert.equal(checked.ok, true);
});
