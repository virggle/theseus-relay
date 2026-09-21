// 衰减探针（v0.1.4）——把 PROTOCOL §8 里那句「长程衰减无度量」的自白，变成面板上的一个指标。
//
// 它**不是一根棒**：不产出 handoff、不推进 agentCount、不写 log。它是基底的诊断行为，
// 因此它的花费也不进棒级账本，单独记账——否则 P1 的成本口径就掺水，那条轨道的可信度也就没了。
//
// 每 10 棒两次调用：
//   1) 抽样：只吃 **log 窗口**（不吃简报），产出 5 组 {question, answer}，answer 必须是 log 里的原片段；
//   2) 作答：只喂 **当前简报** + 那 5 个问句，要求固定 JSON {"answers":[…]}。
// 判分与归因全在基底做机械计算，**不调用模型判分**——否则探针会变成自证。
//
// 归因（本步真正的价值，不是只给一个百分比）：
//   事实在简报里 + 答对 → kept（保留成功）
//   事实在简报里 + 答错 → modelMissed（模型没用）
//   事实不在简报里      → briefMissed（简报没写）；此时用 F1 之后的 searchLog 回查一次 log，
//                        能检索到记「可救」，检索不到记「检索没给」——第三列只作观察，不进百分比。

import { callLLM, sumCalls, extractJSON, searchLog } from './relay.js';
import { batonCostUsd } from './pricing.js';

export const PROBE_EVERY = 10; // 每 10 棒一次
export const PROBE_FACTS = 5; // 每次抽 5 个事实

// v0.1.5 的钩子（本轮明确不做）：保留率跌破阈值 → 给下一棒升档（简报带宽分级 L0/L1/L2）。
// 这里只负责把指标暴露出来，**不做任何自动反应**——阈值与升档策略要等实测数据，
// 现在写死一个阈值等于把噪声当信号。将来接线点就在这条记录（retention[i].rate）与接棒处。
// 抽样窗口：log 的**早段**才是衰减最先发生的地方，所以窗口从头取（这是个刻意选择，不是遗漏）。
export const PROBE_LOG_MAX_CHARS = 4000;
export const PROBE_LOG_MAX_ENTRIES = 40;

export const PROBE_FACT_PROMPT = `你在为一次记忆衰减抽查出题。下面是某个会话的历史记录片段。
请挑出 5 个**有唯一答案的事实**，各写一个问句，并把答案写成记录里出现过的**原始片段**（照抄，不许改写或概括）。
规则：
- 事实必须是记录里明确写下的（数字、专名、术语、约定、结论），不许推测
- 答案不超过 20 字，且必须在记录里逐字出现
- 答案里要有可核对的片段（数字、专名、术语），不要出只有编号的题（「第几条」这种）
- 5 个事实尽量来自记录的不同位置
只输出 JSON：{"facts":[{"question":"…","answer":"…"}]}`;

export const PROBE_ANSWER_PROMPT = `你是一名刚接棒的助手。你只知道下面这份《工作简报》，看不到历史对话。
请只用简报里的信息回答给定的问句；答不出来就如实说「简报里没有」，绝不编造。
只输出 JSON：{"answers":["…","…"]}，顺序与问句一致。`;

// ---------- 触发 ----------

export function shouldProbe(agentCount, opts = {}) {
  const every = opts.every ?? PROBE_EVERY;
  return agentCount > 0 && agentCount % every === 0;
}

// ---------- 纯函数：抽样窗口 → 事实/答案解析 → 机械判分 → 归因 ----------

// 抽样窗口：与 log 的抬头格式一致（第N棒·用户/助手），从头累积到上限为止
export function pickLogWindow(log, opts = {}) {
  const maxEntries = opts.maxEntries ?? PROBE_LOG_MAX_ENTRIES;
  const maxChars = opts.maxChars ?? PROBE_LOG_MAX_CHARS;
  const out = [];
  let chars = 0;
  for (const e of log || []) {
    const text = String(e.text || '').trim();
    if (!text) continue;
    const tag = e.agentId ? `第${e.agentId}棒` : '对照段';
    const line = `【${tag}·${e.role === 'user' ? '用户' : '助手'}】${text}`;
    if (out.length >= maxEntries || chars + line.length > maxChars) break;
    out.push(line);
    chars += line.length;
  }
  return out.join('\n');
}

export function parseFacts(raw) {
  const obj = extractJSON(raw);
  const list = Array.isArray(obj && obj.facts) ? obj.facts : [];
  const facts = [];
  for (const f of list) {
    const question = String((f && f.question) || '').trim();
    const answer = String((f && f.answer) || '').trim();
    if (question && answer) facts.push({ question, answer });
  }
  return facts.slice(0, PROBE_FACTS);
}

export function parseAnswers(raw) {
  const obj = extractJSON(raw);
  const list = Array.isArray(obj && obj.answers) ? obj.answers : [];
  return list.map((a) => String(a ?? '').trim());
}

// 关键片段：数字与拉丁词是**硬**片段（一字不差必须出现）；没有硬片段时，中文取每段的首尾 2-gram，
// 命中任一即算答对。规则写死在这里，谁都能复算——判分不调用模型。
// 单字符数字不做硬片段：「1」在任何编号里都出现，等于没有信息量（实测：它会把「第 1 条」判成
// 「简报里写了」，把简报没写的事记到模型头上）。
export function keyFragments(truth) {
  const t = String(truth || '');
  const hard = [];
  for (const m of t.matchAll(/[0-9][0-9.,]*/g)) if (m[0].length >= 2) hard.push(m[0]);
  for (const m of t.matchAll(/[a-zA-Z][a-zA-Z0-9._+-]*/g)) if (m[0].length >= 2) hard.push(m[0].toLowerCase());
  const soft = [];
  for (const seg of t.split(/[^\u4e00-\u9fff]+/)) {
    if (seg.length < 2) continue;
    soft.push(seg.slice(0, 2));
    if (seg.length > 3) soft.push(seg.slice(-2));
  }
  return { hard, soft };
}

// 机械判分：文本里是否有关键片段。truth 为空 = 无从判分，不记为失败（调用方已保证 truth 非空）。
export function judgeText(text, truth) {
  const hay = String(text || '').toLowerCase();
  const { hard, soft } = keyFragments(truth);
  const missingHard = hard.filter((f) => !hay.includes(f));
  if (hard.length) return { hit: missingHard.length === 0, missingHard, softHit: null };
  const softHit = soft.length ? soft.some((f) => hay.includes(f)) : true;
  return { hit: softHit, missingHard, softHit };
}

/**
 * 归因：把 5 个事实逐条判成 kept / modelMissed / briefMissed，并对 briefMissed 那条回查一次 log。
 * @param object o { facts, answers, brief, lookup }
 *   lookup: (query) => string[] 命中行；只有 briefMissed 才调用（可救 / 检索没给 只作观察）
 */
export function attribute({ facts = [], answers = [], brief = '', lookup } = {}) {
  const counts = { kept: 0, modelMissed: 0, briefMissed: 0 };
  const salvage = { rescuable: 0, searchMissed: 0 };
  const details = [];
  for (let i = 0; i < facts.length; i++) {
    const { question, answer } = facts[i];
    const given = String(answers[i] ?? '');
    const inBrief = judgeText(brief, answer).hit;
    const correct = judgeText(given, answer).hit;
    const verdict = !inBrief ? 'briefMissed' : correct ? 'kept' : 'modelMissed';
    counts[verdict] += 1;
    let reach = null;
    if (verdict === 'briefMissed' && typeof lookup === 'function') {
      const hits = lookup(answer) || [];
      const found = hits.some((h) => judgeText(h, answer).hit);
      reach = found ? '可救' : '检索没给';
      if (found) salvage.rescuable += 1;
      else salvage.searchMissed += 1;
    }
    details.push({ question, truth: answer, answer: given, inBrief, correct, verdict, reach });
  }
  const total = facts.length;
  return { counts, salvage, details, rate: total ? counts.kept / total : 0 };
}

// ---------- IO：跑一次抽查（异步、不阻塞用户那一轮） ----------

/**
 * @param object p { session, cfg, opts }
 *   opts: { askLLM, lookup, now, maxChars, maxEntries, topK, every }
 *   askLLM 默认 relay.callLLM，可注入假实现（测试不许依赖真实模型）
 * @returns 一条 retention 记录（含它自己的花费）
 */
export async function runRetentionProbe({ session, cfg, opts = {} }) {
  const ask = opts.askLLM || callLLM;
  const calls = [];
  const logWindow = pickLogWindow(session.log, opts);
  const brief = String(session.handoff || '');
  const record = {
    at: opts.now ?? Date.now(),
    batonCount: session.agentCount || 0,
    asked: 0,
    rate: null,
    counts: { kept: 0, modelMissed: 0, briefMissed: 0 },
    salvage: { rescuable: 0, searchMissed: 0 },
    details: [],
    note: '',
    cost: null,
  };

  // 调用 1：抽样。输入面只有 log 窗口——不吃简报（否则问不出「简报丢没丢」）
  const sample = await ask(
    cfg,
    [
      { role: 'system', content: PROBE_FACT_PROMPT },
      { role: 'user', content: logWindow || '（历史为空）' },
    ],
    'probe'
  );
  calls.push(sample.call);
  const facts = parseFacts(sample.content);

  let answers = [];
  if (facts.length) {
    // 调用 2：作答。输入面只有简报 + 问句——不给 log（否则测的就不是简报的保留了）
    const asked = await ask(
      cfg,
      [
        { role: 'system', content: PROBE_ANSWER_PROMPT },
        {
          role: 'user',
          content: `【工作简报】\n${brief || '（无简报）'}\n\n【问句】\n${JSON.stringify(facts.map((f) => f.question))}`,
        },
      ],
      'probe'
    );
    calls.push(asked.call);
    answers = parseAnswers(asked.content);
  }

  const total = sumCalls(calls);
  record.cost = {
    usd: batonCostUsd(total, cfg.model),
    input: total.inputTokens,
    output: total.outputTokens,
    calls: calls.length,
    model: cfg.model || '',
    estimated: total.estimated,
  };

  if (!facts.length) {
    // 抽样失败不藏：记一条 null 率的记录，面板显示「—」，而不是悄悄跳过这次抽查
    record.note = '抽样失败：模型没有产出可判分的事实';
  } else {
    const lookup = opts.lookup || ((q) => searchLog(session, q, opts.topK ?? 3));
    const a = attribute({ facts, answers, brief, lookup });
    Object.assign(record, { asked: facts.length, rate: a.rate, counts: a.counts, salvage: a.salvage, details: a.details });
  }
  return record;
}

export function recordProbe(session, record) {
  if (!Array.isArray(session.retention)) session.retention = [];
  session.retention.push(record);
  return record;
}

// 探针的开销单独汇总（面板注明「召回抽查另花 $X」，不混进棒级账本）
export function retentionCost(session) {
  const list = (session && session.retention) || [];
  return {
    probes: list.length,
    calls: list.reduce((n, r) => n + ((r.cost && r.cost.calls) || 0), 0),
    inputTokens: list.reduce((n, r) => n + ((r.cost && r.cost.input) || 0), 0),
    outputTokens: list.reduce((n, r) => n + ((r.cost && r.cost.output) || 0), 0),
    usd: list.reduce((n, r) => n + ((r.cost && r.cost.usd) || 0), 0),
    estimated: list.some((r) => r.cost && r.cost.estimated),
  };
}
