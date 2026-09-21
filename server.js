// 忒修斯号 · 零依赖 Web 服务器
// BYOK：key 只随请求透传，不落盘；也支持站长在 .env 配置内置通道（LLM_API_KEY 等）供朋友免配置体验。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runChain } from './src/task.js';
import { toLlmConfig, PROVIDER_PRESETS, loadEnv } from './src/config.js';
import { testConnection } from './src/llmAdapter.js';
import { computeCost } from './src/pricing.js';
import { buildBriefChain, serializeBriefChain, readBriefChain, buildImportedBrief, applyImportedBrief } from './src/briefchain.js';
import { validateHandoff } from './src/validate.js';
import { shouldProbe, runRetentionProbe, recordProbe, retentionCost } from './src/retention.js';

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
  const s = { sid, agentCount: 0, handoff: '', log: [], batons: [], artifacts: [], mode: 'relay' };
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
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
      // v0.1.4：探针结果要跨刷新留存（它不进 log，也不属于任何一根棒）
      retention: Array.isArray(raw.retention) ? raw.retention : [],
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
      JSON.stringify({
        agentCount: session.agentCount,
        handoff: session.handoff,
        log: session.log,
        batons: session.batons,
        artifacts: session.artifacts || [],
        retention: session.retention || [],
      })
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
      // 成本双账本（v0.1.2）：model 优先取请求参数，否则回落到最近一棒实际用的模型
      const model =
        searchParams.get('model') ||
        (s.batons.slice().reverse().find((b) => b.telemetry && b.telemetry.model) || {}).telemetry?.model ||
        '';
      return send(res, 200, {
        agentCount: s.agentCount,
        handoff: s.handoff,
        log: s.log,
        batons: s.batons,
        cost: computeCost({ batons: s.batons, log: s.log, model }),
        // v0.1.4：召回抽查的结果与它自己的花费（单独记账，不混进 cost.relay）
        retention: s.retention || [],
        retentionCost: retentionCost(s),
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
      // 本链第一棒的「上一份简报」= 链开始前会话持有的简报（普通会话是上一轮终局简报；
      // v0.1.3 导入过的会话就是那份导入简报）。必须在 runChain 之前取，否则会被本轮结果覆盖。
      const chainEntryHandoff = s.handoff || '';

      // H0：一条用户消息跑完整条单链（工具返回驱动换棒），而不是只跑一根棒
      const result = await runChain({ session: s, message, cfg });

      // 记录与换代：链上每根棒都是一张面板卡片
      s.agentCount += result.batons.length;
      s.handoff = result.handoff;
      // 用户消息无条件进 log：用户确实说过这句话，档案库不该有洞（ROADMAP R1 推论）
      s.log.push({ ts, role: 'user', agentId: result.batons[0].agentId, text: message, mode: 'relay' });
      if (result.reply) {
        s.log.push({ ts, role: 'assistant', agentId: result.batons[result.batons.length - 1].agentId, text: result.reply, mode: 'relay' });
      }
      for (const b of result.batons) {
        s.batons.push({
          agentId: b.agentId,
          ts,
          handoff: b.handoff || '',
          prevHandoff: b.seq === 1 ? chainEntryHandoff : result.batons[b.seq - 2].handoff || '',
          drivingInput: b.drivingInput, // 本棒的驱动输入（用户消息或工具返回装配结果）
          userMessage: b.seq === 1 ? message : null, // 兼容旧面板字段
          calls: b.calls, // [{tool, args, class, ok, denied, summary, artifact}]
          handoffReason: b.handoffReason || null, // reply | info-return | ack-aggregate | budget
          writes: b.writes,
          lastReply: b.reply,
          logQueries: [],
          degraded: !!(b.salvaged || b.rejected),
          rejected: !!b.rejected,
          validation: b.validation || null,
          salvaged: !!b.salvaged,
          failed: !b.reply && !b.emittedCalls,
          telemetry: b.telemetry || null,
          costUsd: b.costUsd || 0,
        });
      }
      persist(s);
      const cost = computeCost({ batons: s.batons, log: s.log, model: cfg.model });

      // v0.1.4 衰减探针：每 10 棒跑一次。**异步**，不阻塞这一轮的回答；探针不是棒——
      // 它不写 log、不推进 agentCount、不产出 handoff，花费单独记账（见 src/retention.js）。
      const probeScheduled = shouldProbe(s.agentCount) && !s.probing;
      if (probeScheduled) {
        s.probing = true;
        runRetentionProbe({ session: s, cfg })
          .then((rec) => {
            recordProbe(s, rec);
            persist(s);
          })
          .catch((e) => console.error('[retention]', e.message))
          .finally(() => {
            s.probing = false;
          });
      }

      return send(res, 200, {
        agentId: result.batons[result.batons.length - 1].agentId,
        reply: result.reply,
        chain: { status: result.status, stoppedReason: result.stoppedReason, batons: result.batons.length, costUsd: result.costUsd },
        logQueries: [],
        degraded: result.batons.some((b) => b.salvaged || b.rejected),
        rejected: result.batons.some((b) => b.rejected),
        validation: result.batons[result.batons.length - 1].validation || null,
        salvaged: result.batons.some((b) => b.salvaged),
        cost,
        probe: probeScheduled ? 'scheduled' : null,
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
        s.artifacts = [];
        persist(s);
      }
      return send(res, 200, { ok: true });
    }

    // 简报链导出（v0.1.3）：人类可读、模型无关，逐字段白名单——不含 key / baseUrl / 遥测
    if (method === 'GET' && pathname === '/api/export') {
      const s = getSession(searchParams.get('sid'));
      if (!s) return send(res, 404, { error: '会话不存在' });
      if (!(s.batons || []).length && !s.handoff) return send(res, 400, { error: '本会话还没有简报链可导出' });
      const chain = buildBriefChain(s);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="theseus-brief-chain-${s.sid}.json"`,
        'Cache-Control': 'no-cache',
      });
      return res.end(serializeBriefChain(chain));
    }

    // 跨会话导入（v0.1.3）：只搬「决策」+「用户画像」，log 一行都不搬；导入的简报必须能过基底校验
    if (method === 'POST' && pathname === '/api/import') {
      const body = await parseJSONBody(req);
      const s = getSession(body.sid);
      if (!s) return send(res, 404, { error: '会话不存在：先开一个新会话再导入' });
      const read = readBriefChain(body.chain);
      if (!read.ok) return send(res, 400, { error: read.error });
      const built = buildImportedBrief(read.chain);
      const v = validateHandoff(built.handoff);
      if (!v.ok) return send(res, 400, { error: `导入的简报没过基底校验：${v.errors.map((e) => e.msg).join('；')}` });
      const cleared = applyImportedBrief(s, built.handoff);
      persist(s);
      return send(res, 200, {
        ok: true,
        agentCount: s.agentCount,
        batons: read.chain.batons.length,
        chars: built.chars,
        dropped: built.dropped,
        overBudget: built.overBudget,
        cleared,
        handoff: s.handoff,
      });
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
