// 忒修斯号 · 零依赖 Web 服务器
// BYOK：key 只随请求透传，不落盘；也支持站长在 .env 配置内置通道（LLM_API_KEY 等）供朋友免配置体验。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runTurn } from './src/relay.js';
import { toLlmConfig, PROVIDER_PRESETS, loadEnv } from './src/config.js';
import { testConnection } from './src/llmAdapter.js';

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data', 'sessions');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseJSONBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------- 会话存储（内存 + JSON 落盘；不含任何 key） ----------

const sessions = new Map();

function newSession(sid) {
  const s = { sid, agentCount: 0, handoff: '', log: [], batons: [], mode: 'relay' };
  sessions.set(sid, s);
  return s;
}

function getSession(sid) {
  if (!sid || !/^[a-zA-Z0-9_-]{6,64}$/.test(sid)) return null;
  if (sessions.has(sid)) return sessions.get(sid);
  const file = path.join(DATA_DIR, `${sid}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = {
      sid,
      agentCount: raw.agentCount || 0,
      handoff: raw.handoff || '',
      log: Array.isArray(raw.log) ? raw.log : [],
      batons: Array.isArray(raw.batons) ? raw.batons : [],
      mode: raw.mode === 'single' ? 'single' : 'relay',
    };
    sessions.set(sid, s);
    return s;
  } catch {
    return null;
  }
}

function persist(session) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, `${session.sid}.json`),
      JSON.stringify({ agentCount: session.agentCount, handoff: session.handoff, log: session.log, batons: session.batons })
    );
  } catch (e) {
    console.error('[persist]', e.message);
  }
}

// ---------- key 解析：客户端 BYOK 优先，否则站长内置通道 ----------

function resolveProfile(bodyProfile) {
  const env = loadEnv();
  if (bodyProfile && bodyProfile.apiKey) return { profile: bodyProfile, source: 'byok' };
  if (env.LLM_API_KEY) {
    return {
      profile: {
        baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
        model: env.LLM_MODEL || 'deepseek-chat',
        apiKey: env.LLM_API_KEY,
        temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
      },
      source: 'builtin',
    };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const { pathname, searchParams } = url;
    const method = req.method;

    // 静态页面
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return fs.readFile(path.join(PUBLIC, 'index.html'), (err, buf) => {
        if (err) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }

    // 服务商预设
    if (method === 'GET' && pathname === '/api/providers') {
      return send(res, 200, PROVIDER_PRESETS);
    }

    // 站长是否配了内置通道（不暴露 key 本体）
    if (method === 'GET' && pathname === '/api/default-profile') {
      const env = loadEnv();
      return send(res, 200, {
        builtin: !!env.LLM_API_KEY,
        baseUrl: env.LLM_API_KEY ? env.LLM_BASE_URL || null : null,
        model: env.LLM_API_KEY ? env.LLM_MODEL || null : null,
      });
    }

    // 新会话
    if (method === 'POST' && pathname === '/api/session') {
      const sid = crypto.randomBytes(9).toString('base64url');
      newSession(sid);
      return send(res, 200, { sid });
    }

    // 会话状态（后台面板 + 刷新恢复）
    if (method === 'GET' && pathname === '/api/state') {
      const s = getSession(searchParams.get('sid'));
      if (!s) return send(res, 404, { error: '会话不存在' });
      return send(res, 200, {
        agentCount: s.agentCount,
        handoff: s.handoff,
        log: s.log,
        batons: s.batons,
      });
    }

    // 核心：一轮接力
    if (method === 'POST' && pathname === '/api/turn') {
      const body = await parseJSONBody(req);
      const message = String(body.message || '').trim();
      if (!message) return send(res, 400, { error: '消息为空' });
      if (message.length > 8000) return send(res, 400, { error: '消息过长（上限 8000 字）' });

      const s = getSession(body.sid) || newSession(body.sid);
      const resolved = resolveProfile(body.profile);
      if (!resolved) {
        return send(res, 400, { error: '未配置 API Key：请在设置中填写，或联系站长开启内置通道' });
      }
      const cfg = toLlmConfig(resolved.profile);
      if (!cfg.apiKey) return send(res, 400, { error: 'API Key 为空' });

      const ts = Date.now();

      const result = await runTurn({ session: s, message, cfg });

      // 记录与换代
      s.agentCount = result.agentId;
      s.handoff = result.handoff;
      s.log.push({ ts, role: 'user', agentId: result.agentId, text: message, mode: 'relay' });
      s.log.push({ ts, role: 'assistant', agentId: result.agentId, text: result.reply, mode: 'relay' });
      s.batons.push({
        agentId: result.agentId,
        ts,
        handoff: result.handoff,
        prevHandoff: s.batons.length ? s.batons[s.batons.length - 1].handoff : '',
        userMessage: message,
        lastReply: result.reply,
        logQueries: result.logQueries,
        degraded: result.degraded,
        salvaged: !!result.salvaged,
      });
      persist(s);

      return send(res, 200, {
        agentId: result.agentId,
        reply: result.reply,
        logQueries: result.logQueries,
        degraded: result.degraded,
        salvaged: !!result.salvaged,
        keySource: resolved.source,
      });
    }

    // 清空重来
    if (method === 'POST' && pathname === '/api/reset') {
      const body = await parseJSONBody(req);
      const s = getSession(body.sid);
      if (s) {
        s.agentCount = 0;
        s.handoff = '';
        s.log = [];
        s.batons = [];
        persist(s);
      }
      return send(res, 200, { ok: true });
    }

    // 连通性测试
    if (method === 'POST' && pathname === '/api/test') {
      const body = await parseJSONBody(req);
      try {
        const r = await testConnection(toLlmConfig(body));
        return send(res, 200, { ok: true, reply: r });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[handler error]', err);
    try {
      send(res, 500, { error: String((err && err.message) || err) });
    } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`忒修斯号运行于 http://localhost:${PORT}`);
});
