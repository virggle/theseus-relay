// 忒修斯号接力引擎。
// 核心约束（架构即卖点，不可妥协）：
// 1. 每轮用户消息 = 一个全新 Agent（第 n 棒）。
// 2. 新棒的全部输入 = 上一棒的交接文档 + 用户本轮消息，仅此两样。
// 3. 完整对话 log 只是外部记忆：Agent 默认不读，仅可通过「翻日志」动作按需检索。
// 4. 每棒回答完必须留下结构化交接文档，然后"销毁"。
// 5. 简报必须过基底机械校验（v0.1.1）：不过则拒收重派，再不过走兜底摘要。
// 6. 每棒的调用全程记账（v0.1.2）：token、延迟、重派与抢救事件，落会话存储喂成本面板。

import { chatCompletion } from './llmAdapter.js';
import { validateHandoff, BRIEF_BUDGET } from './validate.js';
import { estimateTokens, estimateMessagesTokens } from './pricing.js';
import { IMPORT_MARK, IMPORT_RULE } from './briefchain.js';

// R7：兜底生成的简报必须自报来源。它没过机械校验，却仍要交给下一棒（否则链路当场断掉），
// 所以机械保证在这里退化为**如实标注**：下一棒与面板都能看见这份简报不可靠。
export const FALLBACK_PROVENANCE =
  '【简报来源·基底】本简报由兜底摘要生成（本棒原始输出格式不可解析或未通过机械校验），可靠性低于正常简报：其中可能与实际发生的事有出入，重要结论请以落盘文件或原始记录为准。';

export function withProvenance(brief, fromFallback) {
  const b = String(brief || '');
  return fromFallback && b ? `${FALLBACK_PROVENANCE}\n\n${b}` : b;
}

// ---------- log 检索（F1：前缀不参与打分 + 低信息熵过滤 + 结果去重） ----------
// 零依赖、纯确定性：同一 (log, query) 连跑两次结果逐字节相同（不依赖 Map/Set 隐式顺序、不用时间）。
// 为什么这三件事要紧：命中不可信时，失败会多出一种「检索没给」，它和「简报没写」「模型没用」
// 长得一模一样——衰减探针（v0.1.4）的判据会被它污染。规则放基底脚本，不靠提示词让模型"搜得准一点"。

// F1-②(A) 静态低信息熵词表。两类词入表：
//   1) 中文功能词（「可以」「已经」「什么」…）——任何一段话里都出现，命中不构成区分度；
//   2) log 行抬头自身的词汇（「用户」「助手」「对照」）——抬头词等于"命中每一行"。
// 纪律：内容词（考试、预算、航班、纪要…）一个都不许进表。误杀真命中比漏滤噪声严重得多。
export const STOP_TOKENS = new Set([
  '用户', '助手', '对照',
  '可以', '我们', '你们', '他们', '自己', '大家',
  '什么', '怎么', '这样', '那样', '这个', '那个', '这些', '那些', '一些', '一下', '一个',
  '就是', '不是', '没有', '已经', '还是', '或者', '而且', '但是', '因为', '所以',
  '如果', '以及', '关于', '对于', '由于', '为了', '时候', '的话',
  '现在', '然后', '之后', '之前', '最后', '起来', '出来', '还有', '也是', '一直', '其实',
]);

// F1-②(B) 动态闸：token 在**本次会话 log** 里的文档频率 ≥ 该比例，即视为"无区分度"。
// 它兜住静态表想不到的会话内高频词：某个词平时有信息量，但这段会话里到处都在说它，同样不能主导排序。
export const STOP_DF_RATIO = 0.6;

// F1-③ 去重键与打分对象都是「去抬头后的正文」，归一化 = 低头 → 空白折叠。
// 抬头（【第N棒·用户】/【第N棒·助手】/【对照段·…】）仍随结果返回（后棒需要知道这句话出自哪一棒），
// 但不参与打分：否则查「用户偏好」时"用户"二字命中几乎所有行，排序当场退化（F1-①）。
const LINE_PREFIX = /^【[^】]*】/;

function normalizeBody(line) {
  return String(line).replace(LINE_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function logEntries(session) {
  const entries = [];
  for (const t of (session && session.log) || []) {
    const tag = t.agentId ? `第${t.agentId}棒` : '对照段';
    const line = `【${tag}·${t.role === 'user' ? '用户' : '助手'}】${t.text}`;
    entries.push({ line, body: normalizeBody(line) });
  }
  return entries;
}

// 中文按 2-gram + 英文/数字按词切分；单个汉字（切不出 2-gram）退化为整串子串匹配
function tokenize(q) {
  const tokens = new Set();
  for (const m of q.match(/[a-zA-Z0-9]+/g) || []) tokens.add(m.toLowerCase());
  const han = q.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < han.length - 1; i++) tokens.add(han.slice(i, i + 2));
  if (tokens.size === 0) tokens.add(q.toLowerCase());
  return tokens;
}

// 两级过滤 + 三级回退。回退的判据是**命中是否被清空**，不是 token 是否被清空——
// 两级闸把 token 删光之后，剩下的 token 也可能恰好一条都不匹配，那同样是"过滤误杀了线索"。
// 过滤的目的是压掉噪声，不是删掉唯一线索：任一级把命中清空，就放宽到下一级重算，宁可给出低质量命中。
// 第一级 = 静态表 + DF 闸（正常路径）；第二级 = 只留 DF 闸（静态表误判时松绑）；
// 第三级 = 不过滤（极短 log 里 DF 天然偏高，闸门失去意义）。
function tokenTiers(tokens, bodies) {
  const total = bodies.length;
  const df = (tk) => bodies.reduce((n, b) => n + (b.includes(tk) ? 1 : 0), 0);
  const tiers = [[true, true], [false, true], [false, false]];
  return tiers.map(([useStatic, useDf]) =>
    tokens.filter(
      (tk) =>
        (!useStatic || !STOP_TOKENS.has(tk)) &&
        (!useDf || total === 0 || df(tk) / total < STOP_DF_RATIO)
    )
  );
}

function rankHits(entries, tokens, topK) {
  const scored = entries.map((e, i) => {
    let score = 0;
    for (const tk of tokens) if (e.body.includes(tk)) score += tk.length;
    return { line: e.line, body: e.body, i, score };
  });

  // 排序：得分降序；同分按出现先后（显式 tie-break，不依赖 sort 的稳定性）。
  // 去重：同一句正文只留一条（上方同分规则保证留下的是**最早**那一次），
  // 且去重必须发生在截断之前——否则复述会白占 8 条额度。
  const seen = new Set();
  const hits = [];
  for (const s of scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (seen.has(s.body)) continue;
    seen.add(s.body);
    hits.push(s.line);
    if (hits.length >= topK) break;
  }
  return hits;
}

export function searchLog(session, query, topK = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (!(topK > 0)) return [];

  const entries = logEntries(session);
  const tiers = tokenTiers([...tokenize(q)], entries.map((e) => e.body));
  for (const tokens of tiers) {
    const hits = rankHits(entries, tokens, topK);
    if (hits.length) return hits;
  }
  return [];
}

// ---------- 交接文档 ----------

const HANDOFF_FORMAT = `## 进展
到目前为止发生了什么、当前状态（含跨轮未完成事项）
## 决策
已确定的结论、被否掉的方案（含理由）——逐条列出，下一棒不许推翻已定决策
## 用户画像
沟通风格、背景、在意什么
## 开放问题
悬而未决、下一棒需要留意的（含下一步意图：做什么 + 依据哪个证据）
## 副作用
本棒执行过的不可逆操作逐条列出；没有就写「无」`;

// 导出给 task.js（单链步进）复用：对话与任务两条线共用同一套简报格式与抢救管线
export { HANDOFF_FORMAT };

// ---------- system prompt ----------

// R4：固定内容全部排在前面，简报挪到 system prompt 的**最后**——
// 前缀缓存命中的是「从头开始完全相同的 token 前缀」，简报夹在中间时，它之后的固定内容永远命不中缓存。
// 同理：任何逐棒变化的片段（简报、本棒编号）都只许出现在末尾。
export function buildSystemPrompt(agentId, prevHandoff) {
  const prev = prevHandoff
    ? `【工作简报（上一任助手留给你，其中已压缩了此前全部对话的重要信息）】\n${prevHandoff}`
    : '【工作简报】你是第一位助手，没有简报。请自然回应用户，并按下方固定格式写 handoff（各节内容可以简短，但五节一个都不能少）。';
  return `你是一个对话助手。你面前只有两样东西：
1. 一份《工作简报》——上一任助手留下的、对此前全部对话的压缩记录（见下）
2. 用户本轮的最新消息

规则：
- 简报里没有的历史细节，你并不掌握。如果用户提到简报中没有的过往内容，坦诚说明"这部分不在我拿到的简报里"，绝不要编造。确有必要时可用「翻日志」工具检索历史片段（每轮最多两次）。
- 回答完必须更新简报（handoff 字段）：把上一份简报中仍相关的内容压缩保留，融入本轮新信息——下一任助手只能看到这份文档，看不到本轮对话。
- 简报「决策」一节只增不删：已确定的结论、被否掉的方案及理由，一条都不许丢。
- 严禁元注释和占位符：不许写「（保留全部旧结论）」「同上」「略」这类缩写——下一任助手看不到旧简报的原文，占位符等于销毁信息。「决策」与「用户画像」必须逐条完整写出，哪怕与上一份简报一字不差。
- 「用户画像」合并更新；「开放问题」清旧加新；「副作用」如实记录；总长 ${BRIEF_BUDGET} 字以内，优先级：决策与约束 > 副作用 > 用户画像 > 开放问题 > 进展细节。

你的简报会被基底机械校验（不是人看，是脚本判）：五节齐全、无占位符、${BRIEF_BUDGET} 字内、决策与用户画像条目不得比上一份少。校验不过会被拒收并要求你重发，所以一次写对更省事。

【简报固定格式——每一棒都必须遵守，五节缺一不可，节标题原样保留】
${HANDOFF_FORMAT}

【翻日志工具】如果简报不够、必须回查历史，只返回这个 JSON（不含其他文字）：
{"action":"read_log","query":"想查的关键词"}

【正常回答】返回这个 JSON（不含其他文字）：
{"reply":"回复用户的内容","handoff":"按上述四节格式更新的工作简报"}

要求：reply 用简体中文，自然、有人味；handoff 客观精炼，事实性陈述。只输出一个 JSON 对象。

【重要】reply 与 handoff 必须在本轮一次输出完整。绝不要对用户说「稍后给你」「马上给你一版」「先到这里」之类的拖延话术，也不要在 handoff 里记「重写尚未输出」——本轮能答就答完，篇幅不够时精炼内容，而不是中断承诺。

${String(prevHandoff || '').includes(IMPORT_MARK) ? IMPORT_RULE : ''}${prev}`;
}

// 简报被基底拒收时，把校验错误原样回灌给该棒（PROTOCOL §6：带校验错误重派一次）
function rejectionMessage(v) {
  return (
    `[系统·简报校验未通过] 基底机械校验拒收了你的 handoff：\n` +
    v.errors.map((e) => `- ${e.msg}`).join('\n') +
    `\n\n请修正后重新输出完整 JSON（reply 内容保持不变，只重写 handoff）：\n{"reply":"…","handoff":"…"}`
  );
}

// ---------- 遥测：每次 LLM 调用都记账 ----------

// purpose: turn（主回答，含翻日志那一次试探）| repair（拒收后重派）| fallback（兜底摘要）
// 端点不回 usage 时按字符估算，并标记 estimated —— 面板必须说清哪些数是估的。
export async function callLLM(cfg, messages, purpose, opts = {}) {
  const t0 = Date.now();
  const { content, usage } = await chatCompletion({
    ...cfg,
    temperature: opts.temperature ?? cfg.temperature ?? 0.7,
    maxTokens: opts.maxTokens ?? cfg.maxTokens ?? 3000,
    messages,
  });
  return {
    content,
    call: {
      purpose,
      latencyMs: Date.now() - t0,
      input: usage.input ?? estimateMessagesTokens(messages),
      output: usage.output ?? estimateTokens(content),
      cached: usage.cached || 0,
      estimated: usage.input == null || usage.output == null,
    },
  };
}

// R3：把端点回传的 cached 一路带上来，账本才可能按缓存价计费（否则接力侧被系统性高估）。
export function sumCalls(calls) {
  return {
    inputTokens: calls.reduce((n, c) => n + c.input, 0),
    outputTokens: calls.reduce((n, c) => n + c.output, 0),
    cachedTokens: calls.reduce((n, c) => n + (c.cached || 0), 0),
    latencyMs: calls.reduce((n, c) => n + c.latencyMs, 0),
    estimated: calls.some((c) => c.estimated),
  };
}

// ---------- 辅助：从模型输出抠 JSON ----------

export function extractJSON(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// JSON 解析失败的兜底：单独一次调用生成交接文档
export async function fallbackHandoff(cfg, userMsg, reply, prevHandoff, calls) {
  const messages = [
    {
      role: 'system',
      content: `你在为下一任助手更新《工作简报》。核心规则：简报是"已知信息的累积压缩"，不是本轮纪要——把上一份简报中仍相关的内容压缩保留，再融入本轮新信息；决策账本只增不删。格式：\n${HANDOFF_FORMAT}\n总长 ${BRIEF_BUDGET} 字以内。只输出文档本身。`,
    },
    {
      role: 'user',
      content: `【上一棒交接（已含此前所有轮次的压缩信息）】\n${prevHandoff || '（无，本轮是第一棒）'}\n\n【本轮用户消息】\n${userMsg}\n\n【本轮助手回复】\n${reply}\n\n请写出留给下一棒的交接文档：覆盖上一棒交接中的重要内容 + 本轮新增。`,
    },
  ];
  const { content, call } = await callLLM(cfg, messages, 'fallback', { temperature: 0.3, maxTokens: 600 });
  calls.push(call);
  return content.trim();
}

// 从损坏/截断的 JSON 中抢救 reply 字段
export function salvageReply(raw) {
  // 情形一：reply 字符串完整闭合，只是 handoff 部分缺失或非法
  const m = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      const parsed = JSON.parse('"' + m[1] + '"');
      if (parsed && parsed.trim()) return parsed.trim();
    } catch { /* 继续尝试情形二 */ }
  }
  // 情形二：reply 字符串本身被截断——取其后全部内容，去掉 handoff 键残留
  const i = raw.indexOf('"reply"');
  if (i !== -1) {
    const start = raw.indexOf('"', i + 7);
    if (start !== -1) {
      let tail = raw.slice(start + 1);
      tail = tail.replace(/",?\s*"handoff"[\s\S]*$/, '');
      tail = tail.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, ' ');
      if (tail.trim().length > 4) return tail.trim();
    }
  }
  return null;
}

// 模型有时会把 \n 双重转义成字面量，这里归一化成真实换行
export function unescapeText(s) {
  return String(s).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
}

// ---------- 棒内预算与决策（R1 / R2 的机械层） ----------

// 三类调用各有独立预算，不再共用一个计数器（ROADMAP R1）：
// - logLookups 翻日志、repairs 校验重派、fallbacks 兜底摘要，各管各的；
// - calls 是防真死循环的硬上限，正常路径永远用不满，触到它说明这一棒确实该换人了。
export const BUDGET = { logLookups: 2, repairs: 1, fallbacks: 2, calls: 8 };

// 纯函数：拿到模型输出后决定下一步。无 IO，可单测。
// R2 的落点就在 'nudge' 这一支：翻日志预算用尽要明说，而不是掉进抢救分支让用户看见 JSON。
export function planNext({ parsed, used }) {
  if (used.calls >= BUDGET.calls) return 'wrapup';
  if (parsed && parsed.action === 'read_log') {
    if (used.logLookups < BUDGET.logLookups) return 'log';
    return 'nudge';
  }
  if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) return 'answer';
  return 'salvage';
}

// ---------- 单轮接力 ----------

// session: { sid, log: [{ts, role, agentId, text}], handoff, agentCount }
// 返回: { agentId, reply, handoff, logQueries, degraded, rejected, salvaged, failed, validation, telemetry }
// failed=true 表示这一棒整体失败（PROTOCOL §6）：产物不落盘（handoff 沿用上一棒），
// 但用户消息仍要进 log —— 用户确实说过这句话，档案库不该有洞。
export async function runTurn({ session, message, cfg }) {
  const agentId = session.agentCount + 1;
  const prevHandoff = session.handoff || '';
  const logQueries = [];
  const calls = [];
  const used = { calls: 0, logLookups: 0, repairs: 0, fallbacks: 0 };

  const messages = [
    { role: 'system', content: buildSystemPrompt(agentId, prevHandoff) },
    { role: 'user', content: message },
  ];

  let reply = null;
  let brief = null;
  let briefFromFallback = false; // 简报是否由兜底摘要生成（R7：交给下一棒时要自报来源）
  let salvaged = false;
  let rejected = false;
  let validation = null;

  // 触顶不抛错：预算耗尽时按 PROTOCOL §2.1 收尾——带着已经拿到的东西退出，
  // 而不是把这一轮连同用户的那句话一起丢掉（ROADMAP R1 的三处空洞）。
  while (used.calls < BUDGET.calls) {
    const { content: raw, call } = await callLLM(cfg, messages, used.repairs ? 'repair' : 'turn');
    calls.push(call);
    used.calls += 1;

    const parsed = extractJSON(raw);
    const action = planNext({ parsed, used });
    if (action === 'wrapup') break;

    if (action === 'log') {
      const query = String((parsed && parsed.query) || '');
      const hits = searchLog(session, query);
      logQueries.push({ query, hits });
      used.logLookups += 1;
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content:
          `[系统·翻日志结果] 关键词「${query}」共命中 ${hits.length} 条：\n` +
          (hits.length ? hits.join('\n---------\n') : '（没有找到相关内容）') +
          `\n\n历史记录只有这些检索片段，完整记录你依然看不到。请现在用正常 JSON 格式回答用户。`,
      });
      continue;
    }

    // R2：翻日志预算用尽要明说，不能掉进抢救分支让用户看见 JSON 原文
    if (action === 'nudge') {
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content:
          `[系统·翻日志次数已用尽] 本棒最多只能查 ${BUDGET.logLookups} 次历史，这次不能再查了。` +
          `请就用现有信息，按正常 JSON 格式回答用户：{"reply":"…","handoff":"…"}`,
      });
      continue;
    }

    if (action === 'answer') {
      reply = unescapeText(parsed.reply);
      brief = parsed.handoff && String(parsed.handoff).trim() ? String(parsed.handoff) : null;
    } else {
      // 模型没按格式来：先尝试从坏 JSON 里抢救 reply
      const s = salvageReply(raw);
      if (s == null) continue; // 什么都没抢到：再给一次机会，受 calls 上限保护
      reply = unescapeText(s);
      salvaged = true;
    }

    // 简报缺失 → 独立摘要调用兜底（§6）
    if (!brief && used.fallbacks < BUDGET.fallbacks) {
      used.fallbacks += 1;
      used.calls += 1;
      brief = await fallbackHandoff(cfg, message, reply, prevHandoff, calls);
      briefFromFallback = true;
    }
    if (!brief) break;

    validation = validateHandoff(brief, { prevHandoff });
    if (validation.ok) break;

    // 拒收 → 带校验错误重派一次（§6）
    if (used.repairs < BUDGET.repairs) {
      used.repairs += 1;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: rejectionMessage(validation) });
      continue;
    }

    // 再不过 → 独立摘要调用兜底，并标记为 rejected
    rejected = true;
    if (used.fallbacks < BUDGET.fallbacks) {
      used.fallbacks += 1;
      used.calls += 1;
      const fb = await fallbackHandoff(cfg, message, reply, prevHandoff, calls);
      brief = fb;
      briefFromFallback = true;
      validation = validateHandoff(fb, { prevHandoff });
    }
    break;
  }

  const telemetry = {
    model: cfg.model || '',
    calls,
    ...sumCalls(calls),
    logLookups: logQueries.length,
    salvage: salvaged,
    rejected,
  };

  // 棒整体失败：产物不落盘，简报沿用上一棒，但用户消息仍进 log（由 server.js 保证）
  if (!reply) {
    return {
      agentId, reply: '', handoff: prevHandoff, logQueries,
      degraded: true, rejected: false, salvaged, failed: true,
      validation: null, telemetry: { ...telemetry, failed: true },
    };
  }

  return {
    agentId,
    reply,
    handoff: brief ? withProvenance(unescapeText(brief), briefFromFallback) : unescapeText(prevHandoff),
    logQueries,
    degraded: salvaged || rejected || used.fallbacks > 0,
    rejected,
    salvaged,
    failed: false,
    validation: validation || { ok: true, errors: [] },
    telemetry: { ...telemetry, failed: false },
  };
}
