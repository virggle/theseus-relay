// 单链步进纯函数单测（node:test）—— H0 验收的确定性部分。
// 完整链路（LLM + 工具 + artifacts）由 mock-llm 无 key 联调覆盖（TESTS.md §C）；
// 这里锁定：驱动输入装配、长输出摘要 + 指针形态、停机报告文本 —— 全部确定性断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDrivingInput, buildChainReport, renderInfoResult, buildToolPrompt, TASK_BUDGET, ARTIFACT_MAX_CHARS } from '../src/task.js';
import { buildSystemPrompt, withProvenance } from '../src/relay.js';
import { validateHandoff } from '../src/validate.js';
import { TOOL_SIGNATURES } from '../src/tools.js';
import { aggregateAcks } from '../src/returns.js';

test('buildDrivingInput：只有确认时 = 聚合一行 + 实际写入记录', () => {
  const { text } = buildDrivingInput({
    acks: [
      { tool: 'write_file', ok: true, target: 'a.txt', bytes: 10 },
      { tool: 'write_file', ok: false, target: 'b.txt', error: 'EACCES' },
    ],
    writes: [{ target: 'a.txt', bytes: 10 }],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '[系统·确认聚合] 确认聚合 2 个：1 成功、1 失败（EACCES@b.txt）', '确认必须压成一行');
  assert.match(text, /\[系统·实际写入\].*a\.txt/);
});

test('buildDrivingInput：信息型短输出原文进入驱动输入（≤ 阈值不落基底）', () => {
  const { text } = buildDrivingInput({ infos: [{ tool: 'read_file', ok: true, path: 'a.txt', totalLines: 3, lines: [{ no: 1, text: 'hello' }] }] });
  assert.match(text, /read_file a\.txt 共 3 行/);
  assert.match(text, /1\|hello/);
  assert.ok(!text.includes('落基底'));
});

test('buildDrivingInput：长输出只给摘要 + 指针，上下文里没有原文（v0.3a 验收口径）', () => {
  const longText = Array.from({ length: 200 }, (_, i) => `${i + 1}|这一行很长很长用来撑大输出体积-${'x'.repeat(50)}`).join('\n');
  assert.ok(longText.length > ARTIFACT_MAX_CHARS);
  const info = {
    tool: 'read_file',
    ok: true,
    path: 'big.txt',
    totalLines: 200,
    lines: longText.split('\n').map((t) => ({ no: Number(t.split('|')[0]), text: t.split('|')[1] })),
    artifact: { path: 'data/artifacts/sid123/b1-0.txt', chars: longText.length, tool: 'read_file' },
  };
  const { text } = buildDrivingInput({ infos: [info] });
  assert.match(text, /-> data\/artifacts\/sid123\/b1-0\.txt/);
  assert.match(text, /read_file 按行分段取回/);
  assert.ok(text.length < ARTIFACT_MAX_CHARS, `驱动输入必须远小于原文（${text.length} < ${longText.length}）`);
  assert.ok(!text.includes(longText), '全文原文不许出现在驱动输入里（允许有头部摘要）');
});

test('buildDrivingInput：空返回给占位说明，不产生空驱动输入', () => {
  const { text } = buildDrivingInput({});
  assert.match(text, /没有产生任何返回内容/);
});

test('renderInfoResult：read_file / search_files 的确定性渲染', () => {
  assert.equal(renderInfoResult({ tool: 'read_file', lines: [{ no: 2, text: 'b' }, { no: 3, text: 'c' }] }), '2|b\n3|c');
  assert.equal(renderInfoResult({ tool: 'search_files', hits: [{ file: 'a.md', lineNo: 4, text: '预算' }] }), 'a.md:4: 预算');
  assert.equal(renderInfoResult({ tool: 'read_file', ok: false, error: 'ENOENT' }), 'ENOENT');
});

test('buildChainReport：触顶报告含原因、成本、简报留存，确定性文本', () => {
  const r1 = buildChainReport({
    status: 'budget_stopped', stoppedReason: 'maxBatons', batonsRun: 12, costUsd: 0.21,
    maxBatons: 12, maxCost: 0.5, lastHandoff: '## 进展\n…', pendingInfos: [],
  });
  assert.match(r1, /棒数触顶（已运行 12 根 ≥ 上限 12 根）/);
  assert.match(r1, /\$0\.2100/);
  assert.match(r1, /下一步意图/);

  const r2 = buildChainReport({
    status: 'budget_stopped', stoppedReason: 'maxCost', batonsRun: 7, costUsd: 0.5123,
    maxBatons: 12, maxCost: 0.5, lastHandoff: '', pendingInfos: [{ tool: 'search_files', ok: true, pattern: 'TODO', total: 9 }],
  });
  assert.match(r2, /任务成本触顶/);
  assert.match(r2, /search_files「TODO」命中 9 处/);
});

test('TASK_BUDGET 默认值存在且为正（任务级预算必须可配置前有兜底）', () => {
  assert.ok(TASK_BUDGET.maxBatonsPerTask > 0);
  assert.ok(TASK_BUDGET.maxCostPerTaskUsd > 0);
});

test('端到端口径演练：确认聚合函数在链上产物是一行（aggregateAcks 回归锚点）', () => {
  const line = aggregateAcks([{ tool: 'write_file', ok: true, target: 'docs/x.md', bytes: 1 }]);
  assert.equal(line, '确认聚合 1 个：1 成功');
  assert.equal(line.includes('\n'), false);
});

// ---------- R4 + PROTOCOL §1：简报必须真的交给下一棒，且落在可缓存前缀之后 ----------

const BRIEF_SAMPLE = '## 进展\n上一棒留下的进展\n## 决策\n定过的事\n## 用户画像\n喜欢短句\n## 开放问题\n下一步读 a.txt\n## 副作用\n无';

test('工具棒 system prompt 必须注入上一棒简报（PROTOCOL §1 核心不变量）', () => {
  const p = buildToolPrompt(3, BRIEF_SAMPLE, Object.keys(TOOL_SIGNATURES));
  assert.equal(p.indexOf(BRIEF_SAMPLE), p.lastIndexOf(BRIEF_SAMPLE), '简报必须原样出现且只出现一次');
  assert.ok(p.includes('## 副作用'), '五节简报不能被截断');
});

test('R4：简报在 prompt 最后，且同一份简报下任意两棒的 prompt 逐字节相同', () => {
  const tool = buildToolPrompt(1, BRIEF_SAMPLE, ['read_file']);
  const chat = buildSystemPrompt(1, BRIEF_SAMPLE);
  for (const p of [tool, chat]) {
    assert.ok(p.trimEnd().endsWith(BRIEF_SAMPLE.trimEnd()), '简报必须是 prompt 的最后一块');
  }
  // 逐棒变化的只允许是简报：棒编号之类一律不进 prompt，否则前缀缓存在那一字节处被截断
  assert.equal(tool, buildToolPrompt(99, BRIEF_SAMPLE, ['read_file']));
  assert.equal(chat, buildSystemPrompt(99, BRIEF_SAMPLE));
});

test('第一棒没有简报时给明确说明，不留空段', () => {
  assert.match(buildToolPrompt(1, '', Object.keys(TOOL_SIGNATURES)), /本棒是第一棒/);
  assert.match(buildSystemPrompt(1, ''), /你是第一位助手/);
});

// ---------- R7：兜底简报必须自报来源 ----------

test('R7：兜底生成的简报带来源标注，普通简报不加标注', () => {
  const marked = withProvenance(BRIEF_SAMPLE, true);
  assert.ok(marked.startsWith('【简报来源·基底】'), '兜底简报必须自报来源');
  assert.ok(marked.endsWith(BRIEF_SAMPLE), '原文必须完整保留');
  assert.equal(withProvenance(BRIEF_SAMPLE, false), BRIEF_SAMPLE);
  assert.equal(withProvenance('', true), '', '没有简报时不能只留一个标注');
});

test('R7：标注落在节标题之前，不影响分节与机械校验（下一棒照常校验）', () => {
  const marked = withProvenance(BRIEF_SAMPLE, true);
  const v = validateHandoff(marked, { prevHandoff: BRIEF_SAMPLE });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.checks.monotonic.decisions.prev, 1);
  assert.equal(v.checks.monotonic.decisions.cur, 1);
});
