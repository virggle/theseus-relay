// 最小工具集（H0，PROTOCOL §2.2）：search_files / read_file / write_file。
// 三条纪律落在这里：
//   1. 路径守卫归脚本：一律相对本会话工作区，绝对路径 / .. / 盘符直接拒绝，不问模型
//   2. 写操作必须记录 target：write_file 返回里的 target 就是 write_target（§2.1 硬条款 1 的单链形态）
//   3. 权限按棒授予：白名单由基底传入，越权调用不执行（判定在 task.js，这里只提供名单）
//
// 工具错误不抛给链路：一律归一化为 { ok:false, error } 返回值，由 returns.js 分类处理。

import fs from 'node:fs';
import path from 'node:path';

export const TOOL_NAMES = ['search_files', 'read_file', 'write_file'];

// 每个工具的参数签名（面板与提示词共用）
export const TOOL_SIGNATURES = {
  search_files: '{dir=".", pattern}  子串匹配，大小写不敏感',
  read_file: '{path, offset=1, limit=100}  按行读',
  write_file: '{path, content}',
};

/**
 * 路径守卫：把工具入参解析为工作区内的绝对路径。
 * @param {string} wsRoot 工作区绝对路径
 * @param {string} p 相对路径
 * @returns {string} 绝对路径
 * @throws {Error} code=EBADPATH：绝对路径、盘符、..、空路径
 */
export function resolveWorkspacePath(wsRoot, p) {
  const raw = String(p ?? '').trim();
  if (!raw) throw Object.assign(new Error('路径为空'), { code: 'EBADPATH' });
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    throw Object.assign(new Error(`不允许绝对路径：${raw}`), { code: 'EBADPATH' });
  }
  const abs = path.resolve(wsRoot, raw);
  const rel = path.relative(wsRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error(`路径越出工作区：${raw}`), { code: 'EBADPATH' });
  }
  return abs;
}

const SEARCH_MAX_HITS = 50;
const SEARCH_MAX_FILES = 2000;
const SEARCH_MAX_FILE_BYTES = 256 * 1024;
const READ_MAX_LINES = 500;

// 递归收集目录下全部相对路径（受 SEARCH_MAX_FILES 保护）
function walkFiles(root, dir, out) {
  const abs = path.resolve(root, dir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= SEARCH_MAX_FILES) return out;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walkFiles(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function findTool(wsRoot, { dir = '.', pattern }) {
  const pat = String(pattern ?? '');
  if (!pat) return { ok: false, tool: 'search_files', error: 'pattern 为空' };
  const baseAbs = resolveWorkspacePath(wsRoot, dir);
  const relDir = path.relative(wsRoot, baseAbs) || '.';
  const files = walkFiles(wsRoot, relDir === '.' ? '.' : relDir, []);
  const low = pat.toLowerCase();
  const hits = [];
  let total = 0;
  for (const f of files) {
    const abs = path.resolve(wsRoot, f);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // 二进制等不可读文件跳过
    }
    const lines = text.split(/\r\n|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(low)) {
        total++;
        if (hits.length < SEARCH_MAX_HITS) {
          hits.push({ file: f.split(path.sep).join('/'), lineNo: i + 1, text: lines[i].slice(0, 200) });
        }
      }
    }
  }
  return { ok: true, tool: 'search_files', dir: relDir, pattern: pat, hits, total, truncated: total > hits.length };
}

function readTool(wsRoot, { path: p, offset = 1, limit = 100 }) {
  const abs = resolveWorkspacePath(wsRoot, p);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, tool: 'read_file', path: p, error: e.code || e.message };
  }
  const lines = text.split(/\r\n|\n/);
  const off = Math.max(1, Number(offset) || 1);
  const lim = Math.min(READ_MAX_LINES, Math.max(1, Number(limit) || 100));
  const slice = lines.slice(off - 1, off - 1 + lim).map((t, i) => ({ no: off + i, text: t.slice(0, 500) }));
  return {
    ok: true,
    tool: 'read_file',
    path: p,
    offset: off,
    limit: lim,
    totalLines: lines.length,
    lines: slice,
    truncated: lines.length > off - 1 + lim,
  };
}

function writeTool(wsRoot, { path: p, content }) {
  const abs = resolveWorkspacePath(wsRoot, p);
  const body = String(content ?? '');
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  } catch (e) {
    return { ok: false, tool: 'write_file', path: p, target: p, error: e.code || e.message };
  }
  // target 即 write_target（§2.2）：统一用正斜杠相对路径，面板/账本/下一棒看到的是同一个字符串
  return { ok: true, tool: 'write_file', path: p, target: p.split(path.sep).join('/'), bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * 构造绑定到某个工作区的工具执行器。
 * @param {object} opts { workspaceDir }
 * @returns {{ execute(name, args): object }}
 */
export function createTools({ workspaceDir }) {
  const wsRoot = path.resolve(workspaceDir);
  return {
    workspaceDir: wsRoot,
    names: TOOL_NAMES,
    signatures: TOOL_SIGNATURES,
    execute(name, args = {}) {
      try {
        switch (name) {
          case 'search_files':
            return findTool(wsRoot, args);
          case 'read_file':
            return readTool(wsRoot, args);
          case 'write_file':
            return writeTool(wsRoot, args);
          default:
            return { ok: false, tool: String(name), error: `未知工具：${name}` };
        }
      } catch (e) {
        // 路径守卫等确定性拒绝：归一化返回，不抛进链路
        return { ok: false, tool: String(name), error: e.code === 'EBADPATH' ? e.message : e.code || e.message };
      }
    },
  };
}
