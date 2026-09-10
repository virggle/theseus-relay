// 基底校验器单测（node:test，Node ≥18 内置，零依赖）
// 用例全部来自真实故障样本：PROTOCOL §6/§8 实测到的模型作弊与截断形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoff, parseSections, countItems, countChars, findPointers } from '../src/validate.js';

const GOOD = `## 进展
用户在评估接力协议，已跑到第 12 棒。
## 决策
1. 简报四节固定，节标题原样保留
2. 决策账本只增不删
3. 不引入向量数据库
## 用户画像
偏好结论优先、结构化表格；要求中英双语同步
## 开放问题
长程衰减如何度量`;

const codes = (v) => v.errors.map((e) => e.code);

test('好简报通过全部五项', () => {
  const v = validateHandoff(GOOD);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.errors, []);
});

test('① 四节齐全：缺「## 决策」被拒', () => {
  const v = validateHandoff(GOOD.replace(/## 决策\n[\s\S]*?(?=## 用户画像)/, ''));
  assert.ok(codes(v).includes('SECTIONS_MISSING'));
  assert.match(v.errors[0].msg, /决策/);
});

test('① 四节齐全：接受历史写法「## 用户画像与偏好」', () => {
  const v = validateHandoff(GOOD.replace('## 用户画像', '## 用户画像与偏好'));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('② 无占位符：圆括号「（保留全部旧结论）」被拒', () => {
  const v = validateHandoff(GOOD.replace('1. 简报四节固定，节标题原样保留', '（保留全部旧结论）'));
  assert.ok(codes(v).includes('PLACEHOLDER'));
});

test('② 无占位符：整行「同上」与「略」被拒', () => {
  assert.ok(codes(validateHandoff(GOOD.replace('## 决策\n', '## 决策\n同上\n'))).includes('PLACEHOLDER'));
  assert.ok(codes(validateHandoff(GOOD.replace('## 决策\n', '## 决策\n略\n'))).includes('PLACEHOLDER'));
});

test('② 无占位符：正文里的「策略」「忽略」不算占位符', () => {
  const v = validateHandoff(GOOD.replace('用户在评估接力协议，已跑到第 12 棒。', '用户在评估缓存策略，忽略冷启动成本。'));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('③ 预算内：超过 800 字被拒，800 字整通过', () => {
  const over = GOOD.replace('## 进展\n', '## 进展\n' + '填充内容'.repeat(500));
  const v = validateHandoff(over);
  assert.ok(codes(v).includes('BUDGET'));
  assert.ok(v.checks.chars > v.checks.budget);

  const exact = GOOD.replace('## 进展\n', '## 进展\n' + '填'.repeat(800 - countChars(GOOD)));
  assert.equal(countChars(exact), 800);
  assert.equal(validateHandoff(exact).ok, true);
});

test('④ 决策只增不删：条目变少被拒，持平/新增通过', () => {
  const prev = GOOD; // 决策 3 条、画像 1 条
  const shrunk = GOOD.replace('3. 不引入向量数据库\n', '');
  const v = validateHandoff(shrunk, { prevHandoff: prev });
  assert.ok(codes(v).includes('DECISIONS_SHRUNK'));
  assert.equal(v.checks.monotonic.decisions.prev, 3);
  assert.equal(v.checks.monotonic.decisions.cur, 2);

  const grown = GOOD.replace('## 决策\n', '## 决策\n0. 新增一条决策\n');
  assert.equal(validateHandoff(grown, { prevHandoff: prev }).ok, true);
  assert.equal(validateHandoff(GOOD, { prevHandoff: prev }).ok, true);
});

test('④ 决策只增不删：画像条目变少同样被拒', () => {
  const shrunk = GOOD.replace('偏好结论优先、结构化表格；要求中英双语同步\n', '');
  const v = validateHandoff(shrunk, { prevHandoff: GOOD });
  assert.ok(codes(v).includes('PROFILE_SHRUNK'));
});

test('④ 决策只增不删：第一棒（无上一份）跳过该校验', () => {
  const v = validateHandoff('## 进展\n首棒\n## 决策\n（暂无）\n## 用户画像\n待观察\n## 开放问题\n无');
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.checks.monotonic.decisions.prev, null);
});

test('⑤ 指针有效：无指针通过，指向不存在路径被拒', () => {
  const withOk = GOOD.replace('## 开放问题\n', '## 开放问题\n详见 -> docs/PROTOCOL.md\n');
  const exists = (p) => p === 'docs/PROTOCOL.md';
  const vOk = validateHandoff(withOk, { exists });
  assert.deepEqual(vOk.checks.pointers, ['docs/PROTOCOL.md']);
  assert.equal(vOk.ok, true, JSON.stringify(vOk.errors));

  const withDead = GOOD.replace('## 开放问题\n', '## 开放问题\n详见 -> docs/不存在的文件.md\n');
  const vBad = validateHandoff(withDead, { exists });
  assert.ok(codes(vBad).includes('POINTER_MISSING'));
});

test('⑤ 指针有效：默认用真实文件系统判断（仓库内文件为真）', () => {
  assert.equal(validateHandoff(GOOD.replace('## 开放问题\n', '## 开放问题\n见 -> docs/PROTOCOL.md\n')).ok, true);
  assert.ok(codes(validateHandoff(GOOD.replace('## 开放问题\n', '## 开放问题\n见 -> docs/NOPE-404.md\n'))).includes('POINTER_MISSING'));
});

test('辅助函数：parseSections / countItems / findPointers 边界', () => {
  const s = parseSections(GOOD);
  assert.deepEqual(Object.keys(s), ['进展', '决策', '用户画像', '开放问题']);
  assert.equal(countItems(s.决策), 3);
  assert.equal(countItems(''), 0);
  assert.equal(countChars('  a b\n c '), 3);
  assert.deepEqual(findPointers('a -> x/y.md#z b'), ['x/y.md']);
  assert.deepEqual(findPointers('无指针'), []);
});
