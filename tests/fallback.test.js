// 兜底简报解析（issue #1）单测。纯函数，零 IO，不依赖真实端点。
// 要守的不只是"能解出 handoff"，而是**解出来的东西真的能被校验器收下**——
// 否则只是把一坨 JSON 换成另一坨下一棒照样读不懂的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapFallbackBrief } from '../src/relay.js';
import { validateHandoff } from '../src/validate.js';

const GOOD = '## 进展\nmock 交接\n## 决策\n1. 先验证再落盘\n## 约束\n1. 不改动工作区外的文件\n## 用户画像\n测试用户\n## 开放问题\n无\n## 副作用\n无';

test('信封 JSON：取出 handoff 字段，不把 reply 一起带进来', () => {
  const out = unwrapFallbackBrief(JSON.stringify({ reply: '（mock 重派后）已收到校验错误。', handoff: GOOD }));
  assert.equal(out, GOOD);
  assert.ok(!out.includes('reply'), 'reply 是给用户看的，不许混进简报');
});

test('信封里的 \\n 被 JSON 解码成真换行，节标题逐节能被匹配', () => {
  const out = unwrapFallbackBrief('{"reply":"好","handoff":"## 进展\\n一行\\n## 决策\\n1. 甲\\n## 约束\\n1. 乙\\n## 用户画像\\n丙\\n## 开放问题\\n无\\n## 副作用\\n无"}');
  assert.match(out, /^## 进展$/m);
  assert.ok(out.includes('\n'), '换行必须是真换行而不是字面量 \\n');
});

test('原样文档：原样返回，一个字符都不动', () => {
  assert.equal(unwrapFallbackBrief(GOOD), GOOD);
  assert.equal(unwrapFallbackBrief(`  ${GOOD}  `), GOOD, '只做 trim，不重排');
});

test('含花括号但不是 JSON：不得被误拆', () => {
  const brief = '## 进展\n用 {placeholder} 标记\n## 决策\n1. 甲\n## 约束\n1. 乙\n## 用户画像\n丙\n## 开放问题\n无\n## 副作用\n无';
  assert.equal(unwrapFallbackBrief(brief), brief);
});

test('JSON 但没有 handoff 键：原样返回，不拿别的字段凑数', () => {
  const raw = JSON.stringify({ action: 'read_log', query: '最开始' });
  assert.equal(unwrapFallbackBrief(raw), raw, '宁可保留原样，也不猜哪个字段是简报');
});

test('handoff 为空串 / 非字符串 / 纯空白：都判为"没有简报"', () => {
  assert.equal(unwrapFallbackBrief(JSON.stringify({ handoff: '' })), '{"handoff":""}');
  assert.equal(unwrapFallbackBrief(JSON.stringify({ handoff: '   ' })), '{"handoff":"   "}');
  assert.equal(unwrapFallbackBrief(JSON.stringify({ handoff: 123 })), '{"handoff":123}');
  assert.equal(unwrapFallbackBrief(JSON.stringify({ handoff: { a: 1 } })), '{"handoff":{"a":1}}');
});

test('空输入返回空串（调用方靠它判断 break，不许返回 undefined）', () => {
  assert.equal(unwrapFallbackBrief(''), '');
  assert.equal(unwrapFallbackBrief(null), '');
  assert.equal(unwrapFallbackBrief(undefined), '');
});

test('守门：解出来的简报必须过得了机械校验（六节齐全）', () => {
  const brief = unwrapFallbackBrief(JSON.stringify({ reply: 'x', handoff: GOOD }));
  const v = validateHandoff(brief, { prevHandoff: '' });
  assert.deepEqual(v.errors, [], `校验器拒收了：${JSON.stringify(v.errors)}`);
});

test('守门：修复前的那坨信封原文确实过不了校验（反例锁定）', () => {
  const raw = JSON.stringify({ action: 'read_log', query: '最开始' });
  assert.ok(!validateHandoff(raw, { prevHandoff: '' }).ok, '未修复时这就是实际交给下一棒的东西');
});