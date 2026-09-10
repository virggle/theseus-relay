// 成本双账本单测（v0.1.2）：数字必须能手算复现，否则面板就是玄学。
// 口径：价目 = 美元/百万 token；单体 = 每轮重读 system + 全部历史（前缀按缓存价）+ 本轮新消息（全价）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceOf, estimateTokens, computeCost, SINGLE_SYSTEM_CHARS } from '../src/pricing.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// 400 个英文字符 ≈ 100 token（粗估口径：非汉字 4 字符 1 token）
const MSG = 'a'.repeat(400);
const MSG_TOK = 100;
const SYS_TOK = Math.ceil(SINGLE_SYSTEM_CHARS / 4); // 150

function baton(i) {
  return {
    agentId: i + 1,
    userMessage: MSG,
    lastReply: 'b'.repeat(400),
    telemetry: { inputTokens: 1000, outputTokens: 100 },
  };
}
const series = (n) => Array.from({ length: n }, (_, i) => baton(i));

test('价目表：已知模型命中、免费档为 0、未知模型回落默认档并标记', () => {
  const p = priceOf('deepseek-chat');
  assert.equal(p.label, 'DeepSeek V3');
  assert.equal(p.in, 0.27);
  assert.equal(p.out, 1.1);
  assert.equal(p.cached, 0.07);

  assert.equal(priceOf('nvidia/nemotron:free').free, true);
  assert.equal(priceOf('llama3').in, 0);

  const unknown = priceOf('some-future-model');
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.in, 0.3);
});

test('token 粗估：汉字 1:1，其余 4 字符 1 token', () => {
  assert.equal(estimateTokens('中文测试'), 4);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('中文abcd'), 3);
  assert.equal(estimateTokens(''), 0);
});

test('两棒短会话：接力更贵——面板必须如实认输', () => {
  const c = computeCost({ batons: series(2), log: [], model: 'deepseek-chat' });
  // 接力：2 × (1000 × 0.27 + 100 × 1.10) = 760 / 1e6
  assert.ok(near(c.relay.cost, 760 / 1e6), String(c.relay.cost));
  // 单体：缓存 (150 + 350) × 0.07 + 新消息 200 × 0.27 + 输出 200 × 1.10 = 309 / 1e6
  assert.ok(near(c.single.cost, 309 / 1e6), String(c.single.cost));
  assert.ok(c.relay.cost > c.single.cost);
  assert.equal(c.series.length, 2);
});

test('四十棒长会话：接力反超——单调成本 vs 线性增长的差别', () => {
  const n = 40;
  const c = computeCost({ batons: series(n), log: [], model: 'deepseek-chat' });
  // 接力：n × 380 / 1e6 = 15200 / 1e6
  assert.ok(near(c.relay.cost, (n * 380) / 1e6));
  // 单体：Σ(150 + 200k) × 0.07 + 100n × 0.27 + 100n × 1.10，k = 0..n-1
  const cached = n * SYS_TOK + 200 * ((n - 1) * n / 2);
  const expect = (cached * 0.07 + 100 * n * 0.27 + 100 * n * 1.1) / 1e6;
  assert.ok(near(c.single.cost, expect), `${c.single.cost} vs ${expect}`);
  assert.ok(c.relay.cost < c.single.cost, `${c.relay.cost} < ${c.single.cost}`);
});

test('交叉点：约 35 棒之后接力开始省钱（可由口径手算推出）', () => {
  const at = (n) => {
    const c = computeCost({ batons: series(n), log: [], model: 'deepseek-chat' });
    return c.relay.cost <= c.single.cost;
  };
  assert.equal(at(30), false);
  assert.equal(at(35), true);
});

test('累计序列单调不减，且每棒都记账', () => {
  const c = computeCost({ batons: series(10), log: [{ text: 'x'.repeat(100) }], model: 'deepseek-chat' });
  for (let i = 1; i < c.series.length; i++) {
    assert.ok(c.series[i].relay >= c.series[i - 1].relay);
    assert.ok(c.series[i].single >= c.series[i - 1].single);
  }
  assert.equal(c.turns, 10);
  assert.equal(c.logChars, 100);
  assert.equal(c.estimated, false);
});

test('端点没给 usage 时：estimated 标记一路传到面板', () => {
  const b = series(1);
  b[0].telemetry.estimated = true;
  assert.equal(computeCost({ batons: b, log: [], model: 'deepseek-chat' }).estimated, true);
});

test('空会话不炸：0 棒 → 0 成本', () => {
  const c = computeCost({ batons: [], log: [], model: 'deepseek-chat' });
  assert.equal(c.relay.cost, 0);
  assert.equal(c.single.cost, 0);
  assert.equal(c.series.length, 0);
});
