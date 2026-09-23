// 衰减探针单测（node:test）——对应 ROADMAP §2 的 v0.1.4。
// 探针要调 LLM，所以测试全部走「注入假模型」：断言的是**分类与账面**，不依赖任何真实端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldProbe,
  pickLogWindow,
  parseFacts,
  parseAnswers,
  keyFragments,
  judgeText,
  attribute,
  runRetentionProbe,
  recordProbe,
  retentionCost,
  PROBE_EVERY,
  PROBE_FACTS,
} from '../src/retention.js';
import { computeCost } from '../src/pricing.js';

const BRIEF = `## 进展
已定存储与同步方案。
## 决策
1. 存储用 SQLite，不引云端依赖
2. 同步方案选 WebDAV
## 约束
回复一律用中文
## 用户画像
1. 中文沟通，偏好先给结论
## 开放问题
无
## 副作用
无`;

const BRIEF_WITHOUT_FACTS = `## 进展
上一棒没记具体方案。
## 决策
1. 无
## 约束
1. 无
## 用户画像
1. 中文沟通
## 开放问题
无
## 副作用
无`;

// 三条事实：两条能在简报里找到，一条只在 log 里
const FACTS = [
  { question: '存储用什么？', answer: 'SQLite' },
  { question: '同步用什么？', answer: 'WebDAV' },
  { question: '用户消息里反复出现的那句话是什么？', answer: '随便说点什么' },
];
const ANSWERS = ['SQLite', '用邮件同步的', '不知道'];
const FACTS_JSON = JSON.stringify({ facts: FACTS });
const ANSWERS_JSON = JSON.stringify({ answers: ANSWERS });

// 假模型：按调用顺序吐出预设内容，形状与 relay.callLLM 一致（含 call 账）
function fakeLLM(outputs) {
  const seen = [];
  const ask = async (cfg, messages, purpose) => {
    const content = outputs[Math.min(seen.length, outputs.length - 1)];
    seen.push({ messages, purpose, content });
    return { content, call: { purpose, latencyMs: 5, input: 300, output: 120, cached: 0, estimated: false } };
  };
  ask.seen = seen;
  return ask;
}

function sessionFixture() {
  const log = [];
  for (let i = 1; i <= 10; i++) {
    log.push({ ts: i, role: 'user', agentId: i, text: '随便说点什么' });
    log.push({ ts: i, role: 'assistant', agentId: i, text: '明白了。' });
  }
  const batons = Array.from({ length: 10 }, (_, i) => ({
    agentId: i + 1,
    ts: 1000 + i,
    handoff: BRIEF,
    handoffReason: 'reply',
    userMessage: '随便说点什么',
    telemetry: { inputTokens: 800, outputTokens: 100, cachedTokens: 0, estimated: false },
  }));
  return { sid: 'PROBE1', agentCount: 10, handoff: BRIEF, log, batons, artifacts: [] };
}

test('v0.1.4 ①：归因三类各有夹具 —— kept / modelMissed / briefMissed', () => {
  const a = attribute({ facts: FACTS, answers: ANSWERS, brief: BRIEF });
  assert.deepEqual(a.counts, { kept: 1, modelMissed: 1, briefMissed: 1 });
  assert.deepEqual(a.details.map((d) => d.verdict), ['kept', 'modelMissed', 'briefMissed']);
  assert.deepEqual(a.details.map((d) => d.inBrief), [true, true, false]);
  assert.equal(a.rate, 1 / 3, 'rate = kept / 事实数');
});

test('v0.1.4 ②：同一份作答，简报里有没有这条事实 —— 决定它算「模型没用」还是「简报没写」', () => {
  const facts = [{ question: '存储用什么？', answer: 'SQLite' }];
  const answers = ['这我说不上来']; // 作答两边完全一样，只有简报不同
  assert.equal(attribute({ facts, answers, brief: BRIEF }).details[0].verdict, 'modelMissed');
  assert.equal(attribute({ facts, answers, brief: BRIEF_WITHOUT_FACTS }).details[0].verdict, 'briefMissed');
  assert.equal(attribute({ facts, answers, brief: BRIEF }).counts.modelMissed, 1);
  assert.equal(attribute({ facts, answers, brief: BRIEF_WITHOUT_FACTS }).counts.briefMissed, 1);
});

test('v0.1.4 ③：判分是机械的 —— 「很像」但没有关键片段即判错，不调用模型判分', () => {
  const truth = '答案是 233168';
  const soundsRight = '把所有 3 和 5 的倍数加起来，得到一个六位数'; // 听着对，就是没给数字
  assert.equal(judgeText(soundsRight, truth).hit, false);
  assert.deepEqual(judgeText(soundsRight, truth).missingHard, ['233168']);
  assert.equal(judgeText('答案就是 233168', truth).hit, true);
  // 中文走软片段（任一命中）：换个说法也算答对
  assert.equal(judgeText('考试在下周二', '下周二').hit, true);
  assert.equal(judgeText('应该是周三吧', '下周二').hit, false);
  // 单字符数字不做硬片段（否则「第 1 条」会命中任何编号）
  assert.deepEqual(keyFragments('第 1 条').hard, []);
});

test('v0.1.4 ④：触发时机 —— 跑满 10 棒触发一次，第 11 棒不触发', () => {
  assert.equal(shouldProbe(0), false, '还没跑过不触发');
  assert.equal(shouldProbe(9), false);
  assert.equal(shouldProbe(PROBE_EVERY), true);
  assert.equal(shouldProbe(PROBE_EVERY + 1), false, '第 11 棒不触发');
  assert.equal(shouldProbe(PROBE_EVERY * 2), true);
  assert.equal(shouldProbe(10, { every: 5 }), true, '间隔可注入');
});

test('v0.1.4 ⑤：探针跑完，agentCount / log / handoff / batons 与棒级成本逐字节不变', async () => {
  const session = sessionFixture();
  const before = JSON.stringify({ a: session.agentCount, log: session.log, handoff: session.handoff, batons: session.batons });
  const costBefore = JSON.stringify(computeCost({ batons: session.batons, log: session.log, model: 'deepseek-chat' }));

  const ask = fakeLLM([FACTS_JSON, ANSWERS_JSON]);
  const rec = await runRetentionProbe({ session, cfg: { model: 'deepseek-chat' }, opts: { askLLM: ask, lookup: () => [], now: 1 } });
  recordProbe(session, rec);

  const after = JSON.stringify({ a: session.agentCount, log: session.log, handoff: session.handoff, batons: session.batons });
  assert.equal(after, before, '探针不许改动会话的既有状态');
  assert.equal(
    JSON.stringify(computeCost({ batons: session.batons, log: session.log, model: 'deepseek-chat' })),
    costBefore,
    '棒级账本一分钱都不许被探针改动'
  );
  assert.equal(session.retention.length, 1);
  assert.equal(rec.batonCount, 10);
  assert.equal(rec.asked, 3);
});

test('v0.1.4 ⑥：探针花费单独记账（口径可手算），不出现在棒级账本里', async () => {
  const session = sessionFixture();
  const ask = fakeLLM([FACTS_JSON, ANSWERS_JSON]);
  const rec = await runRetentionProbe({ session, cfg: { model: 'deepseek-chat' }, opts: { askLLM: ask, lookup: () => [], now: 1 } });

  assert.equal(rec.cost.calls, 2, '每 10 棒两次调用：抽样 + 作答');
  assert.equal(rec.cost.input, 600, '两次 × 300 输入');
  assert.equal(rec.cost.output, 240);
  // deepseek-chat: in 0.27 / out 1.10 每百万 token → 600/1e6*0.27 + 240/1e6*1.10
  assert.ok(Math.abs(rec.cost.usd - 0.000426) < 1e-9, `探针自己的花费：${rec.cost.usd}`);

  recordProbe(session, rec);
  const rc = retentionCost(session);
  assert.deepEqual([rc.probes, rc.calls, rc.inputTokens, rc.outputTokens], [1, 2, 600, 240]);
  assert.ok(rc.usd > 0);
  assert.equal(computeCost({ batons: session.batons, log: session.log, model: 'deepseek-chat' }).relay.cost > 0, true);
});

test('v0.1.4：两次调用的输入面 —— 抽样只吃 log 窗口，作答只吃简报', async () => {
  const session = sessionFixture();
  const ask = fakeLLM([FACTS_JSON, ANSWERS_JSON]);
  await runRetentionProbe({ session, cfg: {}, opts: { askLLM: ask, lookup: () => [], now: 1 } });

  const sample = JSON.stringify(ask.seen[0].messages);
  const answered = JSON.stringify(ask.seen[1].messages);
  assert.equal(ask.seen[0].purpose, 'probe');
  assert.ok(sample.includes('随便说点什么'), '抽样看得到 log');
  assert.ok(!sample.includes('SQLite'), '抽样看不到简报（否则问不出「简报丢没丢」）');
  assert.ok(answered.includes('SQLite'), '作答看得到简报');
  assert.ok(!answered.includes('随便说点什么'), '作答看不到 log（否则测的就不是简报的保留）');
});

test('v0.1.4：抽样失败如实记一条 null 率的记录 —— 不抛错、不假装、不白花第二次调用', async () => {
  const session = sessionFixture();
  const ask = fakeLLM(['模型今天不想出题']);
  const rec = await runRetentionProbe({ session, cfg: {}, opts: { askLLM: ask, now: 1 } });
  assert.equal(rec.rate, null);
  assert.equal(rec.asked, 0);
  assert.match(rec.note, /抽样失败/);
  assert.equal(rec.cost.calls, 1, '没抽到事实就不再发作答调用');
  assert.equal(ask.seen.length, 1);
});

test('v0.1.4：只有「简报没写」才回查 log —— 第三列不偷偷扩大检索开销', async () => {
  let calls = 0;
  const ask = fakeLLM([FACTS_JSON, ANSWERS_JSON]);
  const rec = await runRetentionProbe({
    session: sessionFixture(),
    cfg: {},
    opts: { askLLM: ask, now: 1, lookup: () => { calls += 1; return []; } },
  });
  assert.equal(rec.counts.briefMissed, 1, '夹具里有一条简报没写的');
  assert.equal(calls, rec.counts.briefMissed, '回查次数 = briefMissed 条数');
  assert.equal(rec.salvage.searchMissed, 1);
  assert.equal(rec.salvage.rescuable, 0);
  assert.equal(rec.rate, rec.counts.kept / 3);
});

test('v0.1.4：简报没写但 log 检索得到 → 记「可救」，第三列不进百分比', async () => {
  const ask = fakeLLM([FACTS_JSON, ANSWERS_JSON]);
  const rec = await runRetentionProbe({
    session: sessionFixture(),
    cfg: {},
    opts: { askLLM: ask, now: 1, lookup: (q) => (q.includes('随便') ? ['【第1棒·用户】随便说点什么'] : []) },
  });
  assert.equal(rec.salvage.rescuable, 1);
  assert.equal(rec.salvage.searchMissed, 0);
  assert.equal(rec.rate, rec.counts.kept / 3, '「可救」不改写保留率，它只是观察列');
});

test('v0.1.4：解析与窗口边界 —— 坏 JSON 不抛、事实最多 5 条、窗口有上限', () => {
  assert.deepEqual(parseFacts('{坏'), []);
  assert.deepEqual(parseAnswers('null'), []);
  assert.deepEqual(parseAnswers(JSON.stringify({ answers: [1, null, ' x '] })), ['1', '', 'x']);
  assert.deepEqual(parseFacts(JSON.stringify({ facts: [{ question: 'q', answer: '' }] })), [], '缺答案的事实丢弃');
  const many = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
  assert.equal(parseFacts(JSON.stringify({ facts: many })).length, PROBE_FACTS);
  const log = Array.from({ length: 50 }, (_, i) => ({ agentId: i + 1, role: 'user', text: `第${i}条消息` }));
  assert.equal(pickLogWindow(log, { maxEntries: 3 }).split('\n').length, 3);
  assert.ok(pickLogWindow(log).split('\n').length <= 40, '默认窗口有上限');
  assert.equal(pickLogWindow([]), '');
  assert.equal(pickLogWindow([{ agentId: 1, role: 'user', text: '   ' }]), '', '空白行不进窗口');
});
