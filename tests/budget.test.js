// 棒内预算单测（node:test）
// 用例直接对着 ROADMAP R1 / R2：三类调用不再共用一个计数器，触顶不抛错而是收尾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNext, BUDGET } from '../src/relay.js';

const used = (o = {}) => ({ calls: 0, logLookups: 0, repairs: 0, fallbacks: 0, ...o });
const readLog = { action: 'read_log', query: '用户偏好' };
const answer = { reply: '好的', handoff: '## 进展\n…' };

test('R1：翻日志预算独立于其他预算 —— 用尽后仍可给出答案', () => {
  // 用尽翻日志预算的那一次，判据只看 logLookups，不看 repairs / fallbacks
  assert.equal(planNext({ parsed: readLog, used: used({ logLookups: 0, calls: 1 }) }), 'log');
  assert.equal(planNext({ parsed: readLog, used: used({ logLookups: 1, calls: 2 }) }), 'log');
  assert.equal(planNext({ parsed: readLog, used: used({ logLookups: 2, calls: 3 }) }), 'nudge');
  // 同一根棒里，翻日志用尽之后仍然可以正常作答（旧实现在这里会耗尽共享预算并抛错）
  assert.equal(planNext({ parsed: answer, used: used({ logLookups: 2, calls: 4 }) }), 'answer');
});

test('R1：2 次翻日志 + 1 次校验重派不再互相挤占', () => {
  const u = used({ logLookups: 2, repairs: 1, fallbacks: 1, calls: 6 });
  assert.equal(planNext({ parsed: answer, used: u }), 'answer');
  assert.ok(u.calls < BUDGET.calls, '收尾之前仍有预算可用');
});

test('R2：翻日志预算用尽走 nudge，不掉进抢救分支', () => {
  assert.equal(planNext({ parsed: readLog, used: used({ logLookups: BUDGET.logLookups }) }), 'nudge');
});

test('坏输出走 salvage，空输出不算 answer', () => {
  assert.equal(planNext({ parsed: null, used: used() }), 'salvage');
  assert.equal(planNext({ parsed: { reply: '   ' }, used: used() }), 'salvage');
});

test('触顶收尾：wrapup 优先于一切', () => {
  assert.equal(planNext({ parsed: answer, used: used({ calls: BUDGET.calls }) }), 'wrapup');
  assert.equal(planNext({ parsed: readLog, used: used({ calls: BUDGET.calls }) }), 'wrapup');
});
