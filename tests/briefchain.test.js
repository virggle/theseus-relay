// 跨会话引导单测（node:test）——对应 ROADMAP §2 的 v0.1.3 与 PROTOCOL §3「跨会话导入」。
// 夹具是一份手写的三棒简报链：第 1 棒立项、第 2 棒定同步方案、第 3 棒定冲突策略。
// 每条断言都是确定性的：导出时间由测试注入，不依赖当前时钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBriefChain,
  serializeBriefChain,
  readBriefChain,
  buildImportedBrief,
  applyImportedBrief,
  BRIEF_CHAIN_FORMAT,
  BRIEF_CHAIN_V,
  IMPORT_MARK,
  IMPORT_SECTIONS,
  IMPORT_BRIEF_BUDGET,
} from '../src/briefchain.js';
import { validateHandoff, parseSections, countItems, BRIEF_BUDGET } from '../src/validate.js';
import { buildToolPrompt } from '../src/task.js';
import { buildSystemPrompt } from '../src/relay.js';

const BRIEF_1 = `## 进展
local-first 笔记应用立项，目标平台已确认。
## 决策
1. 存储用 SQLite，不引云端依赖
2. 不做 markdown 预览，专注纯文本编辑
## 用户画像
1. 中文沟通，偏好先给结论
2. 手里已有 Vue 项目经验
## 开放问题
下一步选同步方案，依据本轮的调研清单。
## 副作用
无`;

const BRIEF_2 = `## 进展
同步方案调研完成，两个候选。
## 决策
1. 存储用 SQLite，不引云端依赖
2. 不做 markdown 预览，专注纯文本编辑
3. 同步方案选 WebDAV，因为自建服务器成本最低
## 用户画像
1. 中文沟通，偏好先给结论
2. 手里已有 Vue 项目经验
## 开放问题
下一步定冲突合并策略，依据 WebDAV 的 ETag。
## 副作用
无`;

const BRIEF_3 = `## 进展
冲突合并策略定为时间戳优先，本轮已进入收尾阶段。
## 决策
1. 存储用 SQLite，不引云端依赖
2. 不做 markdown 预览，专注纯文本编辑
3. 同步方案选 WebDAV，因为自建服务器成本最低
4. 冲突合并用时间戳优先，因为它最简单且可预期
## 用户画像
1. 中文沟通，偏好先给结论
2. 手里已有 Vue 项目经验
3. 不写单元测试，靠手动验证
## 开放问题
下一步把 CLI 包一层，依据本轮收尾结论。
## 副作用
写入了 data/notes.sqlite（不可逆）`;

function sessionFixture() {
  return {
    sid: 'CHAIN1',
    agentCount: 3,
    handoff: BRIEF_3,
    log: [
      { ts: 1, role: 'user', agentId: 1, text: '想做一个本地优先的笔记应用，口令是 zx9' },
      { ts: 1, role: 'assistant', agentId: 1, text: '明白了，先定存储方案。' },
      { ts: 2, role: 'user', agentId: 2, text: '同步走 WebDAV 吧。' },
      { ts: 3, role: 'user', agentId: 3, text: '冲突合并简单点就行。' },
    ],
    batons: [
      { agentId: 1, ts: 1000, handoff: BRIEF_1, handoffReason: 'info-return', telemetry: { model: 'secret-model' }, drivingInput: '脚手架输入' },
      { agentId: 2, ts: 2000, handoff: BRIEF_2, handoffReason: 'ack-aggregate', calls: [{ tool: 'write_file' }] },
      { agentId: 3, ts: 3000, handoff: BRIEF_3, handoffReason: 'reply' },
    ],
    artifacts: [],
    mode: 'relay',
  };
}

// 导出 → 读回 → 构造导入简报：验收用的最短路径
function roundTrip(session = sessionFixture()) {
  const chain = buildBriefChain(session, { exportedAt: '2026-09-21T14:00:00.000Z' });
  const read = readBriefChain(serializeBriefChain(chain));
  assert.ok(read.ok, read.error);
  return { chain, built: buildImportedBrief(read.chain) };
}

test('v0.1.3 ①：导出含显式头部、全部棒与终局简报，字段是白名单（不含 key / 遥测 / 驱动输入）', () => {
  const s = sessionFixture();
  s.batons[0].apiKey = 'sk-must-not-leak'; // 就算会话对象里混进 key，导出也不认它
  const chain = buildBriefChain(s, { exportedAt: '2026-09-21T14:00:00.000Z' });

  assert.equal(chain.format, BRIEF_CHAIN_FORMAT);
  assert.equal(chain.v, BRIEF_CHAIN_V, 'v0.5 schema 版本化的占位字段');
  assert.equal(chain.exportedAt, '2026-09-21T14:00:00.000Z');
  assert.equal(chain.batons.length, 3, '三棒一根不少');
  assert.deepEqual(chain.batons.map((b) => b.agentId), [1, 2, 3]);
  assert.deepEqual(chain.batons.map((b) => b.handoffReason), ['info-return', 'ack-aggregate', 'reply']);
  for (const b of chain.batons) {
    assert.deepEqual(Object.keys(b).sort(), ['agentId', 'handoff', 'handoffReason', 'ts']);
  }
  assert.equal(chain.finalBrief, BRIEF_3, '终局简报就是最后一棒的简报');

  const text = serializeBriefChain(chain);
  assert.ok(text.startsWith('{\n  "format": '), '缩进 2 的人类可读 JSON');
  assert.ok(!text.includes('apiKey') && !text.includes('sk-'), '导出物不含任何 key');
  assert.ok(!text.includes('telemetry') && !text.includes('drivingInput'), '遥测 / 驱动输入不进导出物');
  // 同一会话 + 同一导出时间 → 逐字节相同
  assert.equal(text, serializeBriefChain(buildBriefChain(sessionFixture(), { exportedAt: '2026-09-21T14:00:00.000Z' })));
});

test('v0.1.3 ②：导出 → 导入，新简报逐字包含旧简报「决策」「用户画像」的全部条目', () => {
  const { built } = roundTrip();
  const old = parseSections(BRIEF_3);
  const now = parseSections(built.handoff);
  assert.deepEqual(IMPORT_SECTIONS, ['决策', '用户画像']);
  for (const title of IMPORT_SECTIONS) {
    for (const line of old[title].split('\n').map((l) => l.trim()).filter(Boolean)) {
      assert.ok(built.handoff.includes(line), `「${title}」条目没搬过来：${line}`);
    }
    assert.equal(countItems(now[title]), countItems(old[title]), `「${title}」条目必须一条不少`);
  }
  assert.ok(built.handoff.startsWith(IMPORT_MARK));
});

test('v0.1.3 ③：导入的初始简报过基底校验，五节齐全；其余三节按规矩补齐而不是搬旧内容', () => {
  const { built } = roundTrip();
  const v = validateHandoff(built.handoff);
  assert.deepEqual(v.errors, [], '导入简报必须能过 §4 机械校验（它是下一棒的 prevHandoff）');
  assert.ok(v.ok);
  assert.ok(built.chars <= IMPORT_BRIEF_BUDGET, `导入简报 ${built.chars} 字，超了 ${IMPORT_BRIEF_BUDGET}`);

  const now = parseSections(built.handoff);
  for (const title of ['进展', '决策', '用户画像', '开放问题', '副作用']) {
    assert.ok(now[title].length > 0, `${title} 不许留空（占位符是协议级违规）`);
  }
  // 跨会话只搬两节：旧进展 / 旧开放问题 / 旧副作用一律不许跟着过来
  assert.ok(!built.handoff.includes('本轮已进入收尾阶段'), '旧「进展」不许跨会话搬运');
  assert.ok(!built.handoff.includes('把 CLI 包一层'), '旧「开放问题」不许跨会话搬运');
  assert.ok(!built.handoff.includes('data/notes.sqlite'), '旧「副作用」不许跨会话搬运');
});

test('v0.1.3 ④：导入不搬 log —— 目标会话 log / batons / artifacts 清空、agentCount 归零', () => {
  const { built } = roundTrip();
  const target = {
    sid: 'NEW1',
    agentCount: 7,
    handoff: '## 进展\n旧会话的简报',
    log: [{ ts: 1, role: 'user', agentId: 1, text: '旧会话的秘密是 zx9' }],
    batons: [{ agentId: 1 }],
    artifacts: [{ path: 'data/artifacts/x.txt' }],
    mode: 'relay',
  };
  const cleared = applyImportedBrief(target, built.handoff);
  assert.equal(target.log.length, 0, '上一会话的 log 一行都不进新会话');
  assert.equal(target.batons.length, 0);
  assert.equal(target.artifacts.length, 0);
  assert.equal(target.agentCount, 0, '导入后从 0 重新计数');
  assert.equal(target.agentCount + 1, 1, '下一棒编号是第 1 棒');
  assert.deepEqual(cleared, { log: 1, batons: 1 });
  assert.ok(!JSON.stringify(target.handoff).includes('zx9'), '旧 log 的内容不许出现在新简报里');
});

test('v0.1.3 ⑤：导入后的第一棒 prompt 带着上一会话的决策原文与「条目一条都不许少」', () => {
  const { built } = roundTrip();
  for (const p of [buildToolPrompt(1, built.handoff, ['read_file']), buildSystemPrompt(1, built.handoff)]) {
    assert.ok(p.includes('4. 冲突合并用时间戳优先，因为它最简单且可预期'), '决策原文必须进 prompt');
    assert.ok(p.includes(IMPORT_MARK), '导入标记必须显式出现在 prompt 里');
    assert.ok(p.includes('一条都不许少'), '必须写明压缩时条目一条都不许少');
    assert.ok(p.trimEnd().endsWith(built.handoff.trimEnd()), '简报仍是 prompt 的最后一块（R4 不破）');
  }
  // 普通简报不许被误加这条规则
  assert.ok(!buildToolPrompt(1, BRIEF_2, ['read_file']).includes(IMPORT_MARK));
  assert.ok(!buildSystemPrompt(1, BRIEF_2).includes('一条都不许少'));
});

test('v0.1.3：已知风险——导入后的第一棒压缩掉决策条目会被「只增不删」拒收，补齐即通过', () => {
  const { built } = roundTrip();
  const shrunk = built.handoff.replace('4. 冲突合并用时间戳优先，因为它最简单且可预期\n', '');
  const bad = validateHandoff(shrunk, { prevHandoff: built.handoff });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.code === 'DECISIONS_SHRUNK'), JSON.stringify(bad.errors));
  // 原样保留（提示词里那条硬规则要模型做的事）→ 通过
  assert.ok(validateHandoff(BRIEF_3, { prevHandoff: built.handoff }).ok);
});

test('v0.1.3：终局简报过大时按丢弃优先级自尾部裁（先画像后决策），并如实标注裁了几条', () => {
  const fat = `## 进展\nx\n## 决策\n${Array.from({ length: 8 }, (_, i) => `${i + 1}. ${'决策内容'.repeat(22)}`).join('\n')}\n## 用户画像\n1. ${'画像内容'.repeat(20)}\n2. ${'画像内容'.repeat(20)}\n## 开放问题\n无\n## 副作用\n无`;
  const chain = { format: BRIEF_CHAIN_FORMAT, v: 1, exportedAt: '2026-09-21T14:00:00.000Z', batons: [], finalBrief: fat };
  const built = buildImportedBrief(chain);
  assert.ok(built.chars <= IMPORT_BRIEF_BUDGET, `裁完仍超预算：${built.chars}`);
  assert.ok(validateHandoff(built.handoff).ok, '裁过的导入简报仍要能过校验');
  assert.ok(built.dropped['用户画像'] > 0, '画像先被裁');
  assert.ok(built.dropped['决策'] > 0, '画像裁到底后轮到决策');
  assert.match(built.handoff, /导入时超出基底预算，本节自尾部未搬运 \d+ 条/);
  const now = parseSections(built.handoff);
  // 留下的条目 + 一行裁剪说明 = 该校验器看到的条目数
  assert.equal(countItems(now['决策']), 8 - built.dropped['决策'] + 1);
});

test('v0.1.3：裁无可裁时如实报告超预算 —— 不硬塞，也不假装达标', () => {
  const chainOf = (repeat) => ({
    format: BRIEF_CHAIN_FORMAT,
    v: 1,
    exportedAt: '',
    batons: [],
    finalBrief: `## 进展\nx\n## 决策\n1. ${'超长条目'.repeat(repeat)}\n## 用户画像\n1. 甲\n## 开放问题\n无\n## 副作用\n无`,
  });
  // a) 超导入预算 600、但仍在 §4 的 800 之内：可用，但必须如实标记（第一棒大概率被拒收重派）
  const soft = buildImportedBrief(chainOf(120));
  assert.ok(soft.chars > IMPORT_BRIEF_BUDGET, `应超导入预算：${soft.chars}`);
  assert.equal(soft.overBudget, true, '超了就要如实标记，不假装达标');
  assert.ok(soft.chars <= BRIEF_BUDGET);
  assert.ok(validateHandoff(soft.handoff).ok, '仍在 §4 的 800 之内，因此可用');
  // b) 连 §4 的 800 都超：过不了校验，路由据此拒绝落进会话
  const hard = buildImportedBrief(chainOf(200));
  assert.ok(hard.chars > BRIEF_BUDGET, `应超 §4 预算：${hard.chars}`);
  assert.equal(validateHandoff(hard.handoff).ok, false, '过不了校验就必须被路由拦下');
});

test('v0.1.3：认不出 / 损坏的简报链一律以 error 返回，不抛错；缺 finalBrief 时回落到最后一棒', () => {
  const badInputs = [
    '{不是 JSON',
    '{"format":"other"}',
    JSON.stringify({ format: BRIEF_CHAIN_FORMAT, v: 1, finalBrief: '   ' }),
    JSON.stringify({ format: BRIEF_CHAIN_FORMAT, v: BRIEF_CHAIN_V + 1, finalBrief: 'x' }),
    null,
    [],
  ];
  for (const bad of badInputs) {
    const r = readBriefChain(bad);
    assert.equal(r.ok, false, `这份输入不该被认领：${JSON.stringify(bad)}`);
    assert.ok(r.error);
  }
  const ok = readBriefChain({ format: BRIEF_CHAIN_FORMAT, v: 1, batons: [{ agentId: 2, handoff: BRIEF_2 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.chain.finalBrief, BRIEF_2);
  assert.equal(readBriefChain(BRIEF_3).ok, false, '一份裸简报不是简报链');
});
