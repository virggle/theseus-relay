// 返回值分类与确认聚合单测（node:test）—— PROTOCOL §2.1 两类处理 / §2.2 工具棒契约。
// 断言全部确定性：纯函数、固定输入输出，不依赖随机与顺序假设。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReturn, aggregateAcks, infoLine } from '../src/returns.js';

test('分类：write_file 成败都是确认型，报错详情也是确认（写入语义）', () => {
  assert.equal(classifyReturn('write_file', { ok: true, path: 'a.txt', bytes: 12 }), 'ack');
  assert.equal(classifyReturn('write_file', { ok: false, path: 'a.txt', error: 'EACCES' }), 'ack');
});

test('分类：信息型 —— 搜索命中 / 文件内容 / 其他工具报错', () => {
  assert.equal(classifyReturn('search_files', { ok: true, hits: [], total: 3 }), 'info');
  assert.equal(classifyReturn('read_file', { ok: true, path: 'a.txt', totalLines: 80 }), 'info');
  assert.equal(classifyReturn('search_files', { ok: false, error: 'EISDIR' }), 'info');
});

test('分类：权限拒绝是确认型（不值得为它换棒）', () => {
  assert.equal(classifyReturn('write_file', { ok: false, denied: true, tool: 'write_file' }), 'ack');
  assert.equal(classifyReturn('read_file', { ok: false, denied: true, tool: 'read_file' }), 'ack');
});

test('聚合：空输入返回空串', () => {
  assert.equal(aggregateAcks([]), '');
  assert.equal(aggregateAcks(null), '');
});

test('聚合：全成功只报计数', () => {
  const line = aggregateAcks([
    { tool: 'write_file', ok: true, path: 'a.txt', bytes: 10 },
    { tool: 'write_file', ok: true, path: 'b.txt', bytes: 20 },
  ]);
  assert.equal(line, '确认聚合 2 个：2 成功');
});

test('聚合：失败逐个点名错误码与目标，成功报计数 —— 一行（§2.1 示例形态）', () => {
  const line = aggregateAcks([
    { tool: 'write_file', ok: true, path: 'a.txt', bytes: 10 },
    { tool: 'write_file', ok: false, path: 'sub/b.txt', error: 'EACCES' },
    { tool: 'write_file', ok: true, path: 'c.txt', bytes: 3 },
  ]);
  assert.equal(line, '确认聚合 3 个：2 成功、1 失败（EACCES@sub/b.txt）');
  assert.equal(line.split('\n').length, 1, '聚合结果必须是一行');
});

test('聚合：越权被拒单独点名工具名', () => {
  const line = aggregateAcks([
    { tool: 'write_file', ok: true, path: 'a.txt', bytes: 1 },
    { tool: 'exec_shell', ok: false, denied: true, tool: 'exec_shell' },
  ]);
  assert.equal(line, '确认聚合 2 个：1 成功、1 越权被拒（exec_shell）');
});

test('infoLine：三类信息型都能给出一行导语', () => {
  assert.equal(infoLine({ tool: 'search_files', ok: true, pattern: '预算', total: 12 }), 'search_files「预算」命中 12 处');
  assert.equal(infoLine({ tool: 'read_file', ok: true, path: 'sub/a.txt', totalLines: 80 }), 'read_file sub/a.txt 共 80 行');
  assert.equal(infoLine({ tool: 'read_file', ok: false, path: 'x.txt', error: 'ENOENT' }), 'read_file 失败：ENOENT');
  assert.equal(infoLine(null), '');
});
