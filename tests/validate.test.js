// 基底校验器单测（node:test，Node ≥18 内置，零依赖）
// 用例全部来自真实故障样本：PROTOCOL §6/§8 实测到的模型作弊与截断形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoff, parseSections, countItems, countChars, findPointers } from '../src/validate.js';

const GOOD = `## 进展
用户在评估接力协议，已跑到第 12 棒。
## 决策
1. 简报节标题原样保留
2. 决策账本只增不删
3. 不引入向量数据库
## 约束
1. 改文件前先把改法给我看
2. 回复一律用中文
## 用户画像
偏好结论优先、结构化表格；要求中英双语同步
## 开放问题
长程衰减如何度量
## 副作用
无`;

const codes = (v) => v.errors.map((e) => e.code);

test('好简报通过全部五项', () => {
  const v = validateHandoff(GOOD);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.errors, []);
});

test('① 六节齐全：缺「## 决策」被拒', () => {
  const v = validateHandoff(GOOD.replace(/## 决策\n[\s\S]*?(?=## 约束)/, ''));
  assert.ok(codes(v).includes('SECTIONS_MISSING'));
  assert.match(v.errors[0].msg, /决策/);
});

test('① 六节齐全：缺「## 约束」被拒（2026-09-23 新增第六节）', () => {
  const v = validateHandoff(GOOD.replace(/## 约束\n[\s\S]*?(?=## 用户画像)/, ''));
  assert.ok(codes(v).includes('SECTIONS_MISSING'));
  assert.match(v.errors[0].msg, /约束/);
});

test('① 六节齐全：缺「## 副作用」被拒（H0 新增）', () => {
  const v = validateHandoff(GOOD.replace(/\n## 副作用\n无$/, ''));
  assert.ok(codes(v).includes('SECTIONS_MISSING'));
  assert.match(v.errors[0].msg, /副作用/);
});

test('① 副作用节无单调性：上一棒有写入、本棒「无」也通过', () => {
  const prev = GOOD.replace('## 副作用\n无', '## 副作用\n1. 写入 data/workspace/a.txt');
  const cur = GOOD; // 本棒无副作用
  assert.equal(validateHandoff(cur, { prevHandoff: prev }).ok, true, JSON.stringify(validateHandoff(cur, { prevHandoff: prev }).errors));
});

test('① 六节齐全：接受历史写法「## 用户画像与偏好」', () => {
  const v = validateHandoff(GOOD.replace('## 用户画像', '## 用户画像与偏好'));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('② 无占位符：圆括号「（保留全部旧结论）」被拒', () => {
  const v = validateHandoff(GOOD.replace('1. 简报节标题原样保留', '（保留全部旧结论）'));
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
  const prev = GOOD; // 决策 3 条、约束 2 条、画像 1 条
  const shrunk = GOOD.replace('3. 不引入向量数据库\n', '');
  const v = validateHandoff(shrunk, { prevHandoff: prev });
  assert.ok(codes(v).includes('DECISIONS_SHRUNK'));
  assert.equal(v.checks.monotonic.decisions.prev, 3);
  assert.equal(v.checks.monotonic.decisions.cur, 2);

  const grown = GOOD.replace('## 决策\n', '## 决策\n0. 新增一条决策\n');
  assert.equal(validateHandoff(grown, { prevHandoff: prev }).ok, true);
  assert.equal(validateHandoff(GOOD, { prevHandoff: prev }).ok, true);
});

test('④ 约束只增不删：条目变少被拒（第六节与决策同等受保护）', () => {
  const prev = GOOD; // 约束 2 条
  const shrunk = GOOD.replace('2. 回复一律用中文\n', '');
  const v = validateHandoff(shrunk, { prevHandoff: prev });
  assert.ok(codes(v).includes('CONSTRAINTS_SHRUNK'), JSON.stringify(v.errors));
  assert.equal(v.checks.monotonic.constraints.prev, 2);
  assert.equal(v.checks.monotonic.constraints.cur, 1);
  assert.match(v.errors.find((e) => e.code === 'CONSTRAINTS_SHRUNK').msg, /约束账本/);
});

test('④ 约束只增不删：新增约束、持平都通过；把约束并进一行（分号并列）也算没丢', () => {
  const prev = GOOD;
  const grown = GOOD.replace('## 约束\n', '## 约束\n0. 不碰仓库外的文件\n');
  assert.equal(validateHandoff(grown, { prevHandoff: prev }).ok, true);
  assert.equal(validateHandoff(GOOD, { prevHandoff: prev }).ok, true);

  const mergedLine = GOOD.replace('1. 改文件前先把改法给我看\n2. 回复一律用中文\n', '1. 改文件前先把改法给我看；2. 回复一律用中文\n');
  assert.equal(countItems(parseSections(mergedLine)['约束']), 2, '合并成一行仍应数出 2 条');
  assert.equal(validateHandoff(mergedLine, { prevHandoff: prev }).ok, true);
});

test('④ 决策只增不删：画像条目变少同样被拒', () => {
  const shrunk = GOOD.replace('偏好结论优先、结构化表格；要求中英双语同步\n', '');
  const v = validateHandoff(shrunk, { prevHandoff: GOOD });
  assert.ok(codes(v).includes('PROFILE_SHRUNK'));
});

test('④ 只增不删：第一棒（无上一份简报）跳过该校验，且三节键位恒定存在', () => {
  const v = validateHandoff('## 进展\n首棒\n## 决策\n（暂无）\n## 约束\n（暂无）\n## 用户画像\n待观察\n## 开放问题\n无\n## 副作用\n无');
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(Object.keys(v.checks.monotonic).sort(), ['constraints', 'decisions', 'profile']);
  for (const label of ['decisions', 'constraints', 'profile']) {
    assert.equal(v.checks.monotonic[label].prev, null);
    assert.equal(v.checks.monotonic[label].cur, null);
  }
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
  assert.deepEqual(Object.keys(s), ['进展', '决策', '约束', '用户画像', '开放问题', '副作用']);
  assert.equal(countItems(s.决策), 3);
  assert.equal(countItems(s.约束), 2);
  assert.equal(countItems(s.副作用), 1);
  assert.equal(countItems(''), 0);
  assert.equal(countChars('  a b\n c '), 3);
  assert.deepEqual(findPointers('a -> x/y.md#z b'), ['x/y.md']);
  assert.deepEqual(findPointers('无指针'), []);
});

// ---------- R5：条目计数不再按行 ----------

test('R5：一行里用分号并列的条目各算一条——合并行不再被误判成「条目变少」', () => {
  const merged = GOOD.replace('1. 简报节标题原样保留\n2. 决策账本只增不删\n', '1. 简报节标题原样保留；2. 决策账本只增不删\n');
  assert.equal(countItems(parseSections(merged)['决策']), 3, '合并后仍应数出 3 条');
  const v = validateHandoff(merged, { prevHandoff: GOOD });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.checks.monotonic.decisions.cur, 3);
});

test('R5：真丢了一条仍然拒收（口径放宽不等于不查）', () => {
  const shrunk = GOOD.replace('2. 决策账本只增不删\n', '');
  assert.ok(codes(validateHandoff(shrunk, { prevHandoff: GOOD })).includes('DECISIONS_SHRUNK'));
});

test('R5：计数边界——项目符号/序号不计数，顿号不拆（它是条目内部的并列属性）', () => {
  assert.equal(countItems('- a\n- b'), 2);
  assert.equal(countItems('1. a；b'), 2);
  assert.equal(countItems('（3） c'), 1);
  assert.equal(countItems('偏好结论优先、结构化表格'), 1);
  assert.equal(countItems('# 标题\na'), 1);
});
