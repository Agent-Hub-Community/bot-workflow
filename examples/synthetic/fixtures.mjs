// All people, events, messages and source snapshots in this module are invented.
export const dates = ['2026-10-20', '2026-10-21'];
export const model = 'synthetic-fixed-response';
export const resourceUrl = 'https://example.org/synthetic-notebook';
export const text = '合成社区测试一本虚构的离线笔记本。队列只在本机保存，测试者关心断电后能否重新读取。讨论约定先验证恢复步骤，再比较导出格式。';
export const comment = '笔记本先学会记住自己，再替测试者记事。';
export const emphasis = ['队列只在本机保存'];

export function dailyInput(date, group) {
  const empty = group.id === 'group-5';
  const first = date === dates[0];
  const messages = empty ? [] : [
    { id: 'm0001', time: `${date} 10:00`, speaker: 'p1', type: '文本',
      content: first ? `这本虚构笔记本把队列保存在本机。 ${resourceUrl}` : '今天测试断电后重新读取本机队列。' },
    { id: 'm0002', time: `${date} 10:01`, speaker: 'p2', type: '文本',
      content: first ? '先验证恢复步骤，再比较导出格式。' :
        `[引用] 我补充一个只读恢复测试。\n↳ Synthetic Alice: 这本虚构笔记本把队列保存在本机。 ${resourceUrl}` },
  ];
  const input = { group: { id: group.id, label: group.label }, date, cutoff: `${date}T15:59:59Z`,
    timezone: 'Asia/Shanghai', coverage: { count: messages.length, completeDay: true }, messages };
  // Alice is p1 on day one and p2 on day two; namespaces must not collapse by pN or display name.
  const raw = messages.map((message, i) => ({ time: message.time, type: message.type, content: message.content,
    sender: (first ? ['Synthetic Alice', 'Synthetic Bob'] : ['Synthetic Bob', 'Synthetic Alice'])[i] }));
  return { input, raw };
}
export function dailyDraft(input) {
  return { heading: '合成社区的离线笔记测试', theme: '先验证恢复，再比较导出', stories: input.messages.length ? [{
    category: '合成测试', title: `${input.group.label}的虚构笔记本`, text, topic_key: 'synthetic-notebook', emphasis,
    evidence_ids: input.messages.map(message => message.id),
    claims: [{ text: '群友讨论本机队列与恢复步骤。', kind: 'discussion_position', evidence_ids: input.messages.map(message => message.id) }],
  }] : [], resources: [], audit: { omitted: [], uncertainties: [] } };
}

export const selection = {
  edition: dates[1], timezone: 'Asia/Shanghai', windowStart: `${dates[1]}T00:00:00+08:00`, cutoff: `${dates[1]}T15:59:59Z`,
  candidates: [{ id: 'synthetic-release', kind: 'project', title: '虚构笔记本发布', timing: '合成日期 10 月 21 日',
    selectionReason: '离线演示的固定虚构事件。',
    attention: [{ platform: 'Synthetic bulletin', url: 'https://example.org/synthetic-bulletin',
      observation: '固定合成关注记录，无真实热度。', fetchedAt: `${dates[1]}T12:00:00Z` }],
    sources: [{ publisher: 'Synthetic notebook team', url: resourceUrl,
      text: '虚构笔记本发布只读恢复测试版，全部内容为离线测试而编写。', fetchedAt: `${dates[1]}T12:00:00Z` }],
  }],
};
export const externalDraft = { date: dates[1], title: '合成外部资讯', intro: '离线演示的虚构发布，没有采集真实新闻。',
  stories: [{ candidateIds: ['synthetic-release'], title: '虚构笔记本增加只读恢复', timing: '合成日期 10 月 21 日',
    text: '虚构笔记本团队给离线演示增加只读恢复测试。测试数据来自固定样例，事件、发布方和关注记录均为合成。',
    emphasis: ['只读恢复测试'], links: [{ kind: 'article', label: '合成项目占位地址', url: resourceUrl }] }], trends: [] };

export function activity(groups) {
  const leaders = { leaders: [1, 2, 3].map(rank => ({ key: `member-00${rank}`, rank })) };
  const ranks = Object.fromEntries(['week', 'month', 'all'].map(period => [period, structuredClone(leaders)]));
  return { generatedAt: `${dates[1]}T16:00:00Z`,
    windows: Object.fromEntries(['week', 'month', 'all'].map(period => [period, { from: dates[0], through: dates[1] }])),
    ranks, groups: groups.map(group => ({ id: group.id, first: dates[0], last: dates[1], available: group.id !== 'group-5',
      ranks: group.id === 'group-5' ? Object.fromEntries(['week', 'month', 'all'].map(period => [period, { leaders: [] }])) : structuredClone(ranks),
      daily: Object.fromEntries(dates.map(date => [date, group.id === 'group-5' ? { leaders: [] } : structuredClone(leaders)])),
    })), avatars: Object.fromEntries([1, 2, 3].map(rank => [`member-00${rank}`, `avatars/member-00${rank}.png`])) };
}
