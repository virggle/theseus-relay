// 最小工具集单测（node:test）—— PROTOCOL §2.2。
// 断言优先确定性：用 mkdtemp 建一次性工作区，验文件存在 / 计数 / 具体错误码，不依赖随机结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools, resolveWorkspacePath } from '../src/tools.js';

function makeWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-ws-'));
}

test('路径守卫：绝对路径 / 盘符 / .. / 空路径全部拒绝', () => {
  const ws = makeWs();
  const bad = ['C:\\Windows\\x', '/etc/passwd', '../outside.txt', 'a/../../b.txt', ''];
  for (const p of bad) {
    assert.throws(() => resolveWorkspacePath(ws, p), (e) => e.code === 'EBADPATH', `应拒绝：${p}`);
  }
  // 合法相对路径解析到工作区内
  const ok = resolveWorkspacePath(ws, 'sub/a.txt');
  assert.ok(ok.startsWith(ws));
});

test('write_file：写入成功、记录 target、bytes 正确、自动建父目录', () => {
  const ws = makeWs();
  const tools = createTools({ workspaceDir: ws });
  const r = tools.execute('write_file', { path: 'sub/a.txt', content: '你好 hello' });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'sub/a.txt');
  assert.equal(r.bytes, Buffer.byteLength('你好 hello', 'utf8'));
  assert.ok(fs.existsSync(path.join(ws, 'sub', 'a.txt')), '文件必须真实存在于工作区');
  assert.equal(fs.readFileSync(path.join(ws, 'sub', 'a.txt'), 'utf8'), '你好 hello');
});

test('read_file：按行读、offset/limit、totalLines 与截断标记', () => {
  const ws = makeWs();
  fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 250 }, (_, i) => `line-${i + 1}`).join('\n'));
  const tools = createTools({ workspaceDir: ws });
  const r = tools.execute('read_file', { path: 'big.txt', offset: 240, limit: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.totalLines, 250);
  assert.equal(r.lines[0].no, 240);
  assert.equal(r.lines[0].text, 'line-240');
  assert.equal(r.lines.length, 11); // 240..250
  assert.equal(r.truncated, false);

  const head = tools.execute('read_file', { path: 'big.txt' });
  assert.equal(head.lines.length, 100); // 默认 limit=100
  assert.equal(head.truncated, true);
});

test('read_file：不存在的文件返回 ok:false + ENOENT，不抛进链路', () => {
  const tools = createTools({ workspaceDir: makeWs() });
  const r = tools.execute('read_file', { path: 'nope.txt' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ENOENT');
});

test('search_files：子串匹配大小写不敏感，命中带 file/lineNo，计数正确', () => {
  const ws = makeWs();
  fs.writeFileSync(path.join(ws, 'a.txt'), '预算上限 800 字\nTODO: 补测试\n');
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(ws, 'sub', 'b.md'), 'another TODO here\n');
  const tools = createTools({ workspaceDir: ws });
  const r = tools.execute('search_files', { dir: '.', pattern: 'todo' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 2, '两个文件各命中一处');
  assert.deepEqual(r.hits.map((h) => h.file).sort(), ['a.txt', 'sub/b.md']);
  assert.equal(r.hits.find((h) => h.file === 'sub/b.md').lineNo, 1);
});

test('search_files：空 pattern 拒绝；dir 限定子目录后不越界', () => {
  const ws = makeWs();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'TODO\n');
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(ws, 'sub', 'b.txt'), 'TODO\n');
  const tools = createTools({ workspaceDir: ws });
  assert.equal(tools.execute('search_files', { pattern: '' }).ok, false);
  const r = tools.execute('search_files', { dir: 'sub', pattern: 'TODO' });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].file, 'sub/b.txt');
});

test('未知工具与路径越界：归一化为 ok:false，不抛异常', () => {
  const tools = createTools({ workspaceDir: makeWs() });
  const u = tools.execute('exec_shell', { cmd: 'rm -rf /' });
  assert.equal(u.ok, false);
  assert.match(u.error, /未知工具/);
  const p = tools.execute('read_file', { path: '../escape.txt' });
  assert.equal(p.ok, false);
  assert.match(p.error, /越出工作区|绝对路径/);
});
