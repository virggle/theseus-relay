// 检索质量三件套单测（node:test）——对应 ROADMAP §4 的 F1 与 PROTOCOL §5 的三条口径。
// 每条验收都有具体夹具和具体数字；断言全部确定性（同分排序有显式 tie-break，不赌 sort 稳定性、不赌时间）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLog, STOP_TOKENS, STOP_DF_RATIO } from '../src/relay.js';

// 夹具构造：[role, text][] → session，棒号取数组下标 + 1
function session(rounds) {
  return {
    sid: 'TF1',
    log: rounds.map(([role, text], i) => ({ ts: 0, role, agentId: i + 1, text })),
  };
}
// 结果行去掉抬头后的正文（抬头【第N棒·用户】等仍会随结果返回，见 ① 的反面断言）
const bodyOf = (hit) => hit.replace(/^【[^】]*】/, '');

test('F1-①：抬头不参与打分 —— 只靠「用户」二字命中的无关行不得进入结果', () => {
  const s = session([
    ['user', '今天先说说别的安排。'], // 第 1 棒：正文与查询无关，只在抬头【第1棒·用户】里有"用户"
    ['assistant', '好的，你定。'],
    ['user', '这份文档是给用户看的说明。'], // 第 3 棒：正文含"用户"但不含"偏好"，靠停用词表挡掉
    ['user', '用户偏好：回答尽量短，先给结论。'], // 第 4 棒：真命中，必须回来（正面控制）
  ]);
  const hits = searchLog(s, '用户偏好');
  assert.equal(hits.length, 1, `只有第 4 棒是真命中，实得 ${hits.length} 条：${JSON.stringify(hits)}`);
  assert.equal(bodyOf(hits[0]), '用户偏好：回答尽量短，先给结论。');
  // 抬头仍随结果返回：后棒需要知道这句话是哪一棒说的
  assert.ok(hits[0].startsWith('【第4棒·用户】'), `命中行丢了抬头：${hits[0]}`);
});

test('F1-②：静态词表压掉功能词 —— 24 行 log、查询带「可以」，命中 3 条（过滤前 topK 会被打满 8 条）', () => {
  const rounds = [];
  for (let i = 1; i <= 18; i++) rounds.push(['user', `可以再想想第${i}件事`]); // 高频噪声行
  rounds.push(['user', '预算表可以再宽一点']);
  rounds.push(['assistant', '预算表已经改好了']);
  rounds.push(['user', '把预算表发我一下']);
  rounds.push(['user', '天气不错']);
  rounds.push(['assistant', '嗯']);
  rounds.push(['user', '先这样']);
  const s = session(rounds);

  assert.notEqual(STOP_TOKENS.size, 0, '词表必须导出且非空');
  assert.ok(STOP_TOKENS.has('可以') && STOP_TOKENS.has('用户'), '功能词与抬头词在表内');
  assert.ok(!STOP_TOKENS.has('预算') && !STOP_TOKENS.has('考试'), '内容词一个都不许进表');
  assert.ok(STOP_DF_RATIO > 0 && STOP_DF_RATIO < 1, 'DF 阈值必须导出为具名常量');

  const hits = searchLog(s, '预算表可以改');
  assert.equal(s.log.length, 24, '夹具规模固定：24 行');
  assert.equal(hits.length, 3, `「可以」占了 19 行，过滤后应只剩 3 条真命中，实得 ${hits.length}`);
  for (const h of hits) assert.ok(bodyOf(h).includes('预算表'), `无关行混进结果：${h}`);
});

test('F1-② DF 闸：静态词表之外，会话内高频词同样被压掉（24 行里 19 行含「明天」）', () => {
  const rounds = [];
  for (let i = 1; i <= 18; i++) rounds.push(['assistant', `明天再想想第${i}件事`]);
  rounds.push(['user', '明天的航班是几点']);
  rounds.push(['assistant', '航班已经改签了']);
  rounds.push(['user', '把航班号发我']);
  rounds.push(['user', '天气不错']);
  rounds.push(['assistant', '嗯']);
  rounds.push(['user', '先这样']);
  const s = session(rounds);

  assert.ok(!STOP_TOKENS.has('明天'), '「明天」不在静态表里 —— 本用例只考动态闸');
  const hits = searchLog(s, '明天的航班');
  assert.equal(hits.length, 3, `实得 ${hits.length} 条`);
  for (const h of hits) assert.ok(bodyOf(h).includes('航班'), `只靠「明天」命中的行混进来了：${h}`);
});

test('F1-③ 真命中不被误杀：第 2 棒顺口提的「下周二考试」，第 9 棒查「考试」必须命中那一行', () => {
  const s = session([
    ['user', '今天聊聊项目排期。'],
    ['user', '顺口提一句，下周二考试，那天我可能不在。'], // ← 唯一含"考试"的一行
    ['assistant', '记下了。'],
    ['user', '继续看排期。'],
    ['assistant', '排期这块先按季度切。'],
    ['user', '参考一下上个季度的做法。'], // 含"考"但不含"考试"：2-gram 不该命中它
    ['assistant', '上个季度用的是双周节奏。'],
    ['user', '那就照旧。'],
    ['user', '我下周二有什么安排？'],
  ]);
  const hits = searchLog(s, '考试');
  assert.equal(hits.length, 1, `实得 ${hits.length} 条：${JSON.stringify(hits)}`);
  assert.equal(bodyOf(hits[0]), '顺口提一句，下周二考试，那天我可能不在。');
  assert.ok(hits[0].startsWith('【第2棒·用户】'));
});

test('F1-③ 回退保护：过滤把命中清空时逐级放宽，不把查询的唯一线索删掉', () => {
  // 2 行 log 里「会议纪要」的文档频率是 1.0，静态表也覆盖不到它 —— 两级闸必然把它全清掉；
  // 此时必须放宽到「不过滤」，而不是返回空（返回空 = 又一次"检索没给"，正是 F1 要消灭的失败模式）。
  const s = session([
    ['user', '会议纪要怎么整理'],
    ['assistant', '会议纪要按结论在前整理'],
  ]);
  const hits = searchLog(s, '会议纪要');
  assert.equal(hits.length, 2, `实得 ${hits.length} 条`);
  for (const h of hits) assert.ok(bodyOf(h).includes('会议纪要'));
});

test('F1-④：同一句正文出现在第 3、7 棒 —— 结果里只出现一条，且留下最早那次', () => {
  const s = session([
    ['user', '今天聊聊整理的事。'],
    ['assistant', '好，你说。'],
    ['user', '书架按主题分区吧。'], // 第 3 棒：首次
    ['user', '另外书桌要不要一起换。'],
    ['assistant', '预算多少。'],
    ['user', '先不管预算。'],
    ['assistant', '书架按主题分区吧。'], // 第 7 棒：一字不差的复述
  ]);
  const hits = searchLog(s, '书架按主题分区');
  assert.equal(hits.length, 1, `实得 ${hits.length} 条：${JSON.stringify(hits)}`);
  assert.ok(hits[0].startsWith('【第3棒·用户】'), `保留的应是第 3 棒那条：${hits[0]}`);
});

test('F1-④ 去重按归一化正文（空白折叠），但不同正文各留一条', () => {
  const s = session([
    ['user', '  书架按主题分区吧。\n'], // 首尾空白：归一化后与下一行同一句
    ['user', '书架按主题分区吧。'],
    ['assistant', '主题分区之外，再按颜色分一层。'], // 真命中，但不是同一句，不许被合并
  ]);
  const hits = searchLog(s, '主题分区');
  assert.equal(hits.length, 2, `实得 ${hits.length} 条：${JSON.stringify(hits)}`);
  assert.ok(hits[0].startsWith('【第1棒·用户】'));
  assert.equal(bodyOf(hits[1]), '主题分区之外，再按颜色分一层。');
});

test('F1-⑤ 确定性：同一 (log, query) 连跑两次逐字节相同，且同分按出现先后稳定排序', () => {
  const rounds = [];
  for (let i = 1; i <= 12; i++) rounds.push([i % 2 ? 'user' : 'assistant', `排期按季度切，第${i}版`]);
  const s = session(rounds);
  const a = searchLog(s, '排期');
  const b = searchLog(s, '排期');
  assert.equal(JSON.stringify(a), JSON.stringify(b), '两次调用必须逐字节相同');
  assert.deepEqual(a, b);
  assert.equal(a.length, 8, '默认 topK = 8');
  // 12 行同分，靠 tie-break（出现先后）定序，而不是靠 sort 的稳定性
  assert.deepEqual(a.map(bodyOf), rounds.slice(0, 8).map(([, text]) => text));
  assert.equal(searchLog(s, '排期', 3).length, 3, 'topK 是参数，不是常量');
});

test('F1-⑥ 空查询：不抛错，返回空数组', () => {
  const s = session([['user', '随便说点什么']]);
  for (const q of ['', '   ', null, undefined]) assert.deepEqual(searchLog(s, q), []);
});

test('F1-⑥ 无命中：不抛错，返回空数组（含空 log 与会话没有 log 字段两种边界）', () => {
  assert.deepEqual(searchLog(session([['user', '排期按季度切']]), '量子纠缠'), []);
  assert.deepEqual(searchLog({ sid: 'E', log: [] }, '排期'), []);
  assert.deepEqual(searchLog({ sid: 'E' }, '排期'), []);
});

test('F1-⑥ 单字符查询：切不出 2-gram 时退化为子串匹配，不抛错', () => {
  const s = session([
    ['user', '下周二考试'],
    ['assistant', '记下了'],
    ['user', '参考一下排期'],
  ]);
  const hits = searchLog(s, '考');
  assert.ok(Array.isArray(hits));
  assert.equal(hits.length, 2, `实得 ${hits.length} 条：${JSON.stringify(hits)}`);
  for (const h of hits) assert.ok(bodyOf(h).includes('考'));
});
