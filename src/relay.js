// 忒修斯号接力引擎。
// 核心约束（架构即卖点，不可妥协）：
// 1. 每轮用户消息 = 一个全新 Agent（第 n 棒）。
// 2. 新棒的全部输入 = 上一棒的交接文档 + 用户本轮消息，仅此两样。
// 3. 完整对话 log 只是外部记忆：Agent 默认不读，仅可通过「翻日志」动作按需检索。
// 4. 每棒回答完必须留下结构化交接文档，然后"销毁"。
// 5. 简报必须过基底机械校验（v0.1.1）：不过则拒收重派，再不过走兜底摘要。

import { chatCompletion } from './llmAdapter.js';
import { validateHandoff, BRIEF_BUDGET } from './validate.js';

// ---------- log 检索（朴素关键词打分，零依赖） ----------

function logEntries(session) {
  const entries = [];
  for (const t of session.log) {
    const tag = t.agentId ? `第${t.agentId}棒` : '对照段';
    entries.push(`【${tag}·${t.role === 'user' ? '用户' : '助手'}】${t.text}`);
  }
  return entries;
}

export function searchLog(session, query, topK = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  // 中文按 2-gram + 英文/数字按词切分
  const tokens = new Set();
  for (const m of q.match(/[a-zA-Z0-9]+/g) || []) tokens.add(m.toLowerCase());
  const han = q.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < han.length - 1; i++) tokens.add(han.slice(i, i + 2));
  if (tokens.size === 0) tokens.add(q);

  const scored = logEntries(session).map((line) => {
    let score = 0;
    const low = line.toLowerCase();
    for (const tk of tokens) if (low.includes(tk)) score += tk.length;
    return { line, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.line);
}

// ---------- 交接文档 ----------

const HANDOFF_FORMAT = `## 进展
到目前为止发生了什么、当前状态（含跨轮未完成事项）
## 决策
已确定的结论、被否掉的方案（含理由）——逐条列出，下一棒不许推翻已定决策
## 用户画像
沟通风格、背景、在意什么
## 开放问题
悬而未决、下一棒需要留意的`;

// ---------- system prompt ----------

function buildSystemPrompt(agentId, prevHandoff) {
  const prev = prevHandoff
    ? `【工作简报（上一任助手留给你，其中已压缩了此前全部对话的重要信息）】\n${prevHandoff}`
    : '【工作简报】你是第一位助手，没有简报。请自然回应用户，并按下方固定格式写 handoff（各节内容可以简短，但四节一个都不能少）。';
  return `你是一个对话助手。你面前只有两样东西：
1. 一份《工作简报》——上一任助手留下的、对此前全部对话的压缩记录（见下）
2. 用户本轮的最新消息

规则：
- 简报里没有的历史细节，你并不掌握。如果用户提到简报中没有的过往内容，坦诚说明"这部分不在我拿到的简报里"，绝不要编造。确有必要时可用「翻日志」工具检索历史片段（每轮最多两次）。
- 回答完必须更新简报（handoff 字段）：把上一份简报中仍相关的内容压缩保留，融入本轮新信息——下一任助手只能看到这份文档，看不到本轮对话。
- 简报「决策」一节只增不删：已确定的结论、被否掉的方案及理由，一条都不许丢。
- 严禁元注释和占位符：不许写「（保留全部旧结论）」「同上」「略」这类缩写——下一任助手看不到旧简报的原文，占位符等于销毁信息。「决策」与「用户画像」必须逐条完整写出，哪怕与上一份简报一字不差。
- 「用户画像」合并更新；「开放问题」清旧加新；总长 ${BRIEF_BUDGET} 字以内，优先级：决策与约束 > 用户画像 > 开放问题 > 进展细节。

你的简报会被基底机械校验（不是人看，是脚本判）：四节齐全、无占位符、${BRIEF_BUDGET} 字内、决策与用户画像条目不得比上一份少。校验不过会被拒收并要求你重发，所以一次写对更省事。

${prev}

【简报固定格式——每一棒都必须遵守，四节缺一不可，节标题原样保留】
${HANDOFF_FORMAT}

【翻日志工具】如果简报不够、必须回查历史，只返回这个 JSON（不含其他文字）：
{"action":"read_log","query":"想查的关键词"}

【正常回答】返回这个 JSON（不含其他文字）：
{"reply":"回复用户的内容","handoff":"按上述四节格式更新的工作简报"}

要求：reply 用简体中文，自然、有人味；handoff 客观精炼，事实性陈述。只输出一个 JSON 对象。

【重要】reply 与 handoff 必须在本轮一次输出完整。绝不要对用户说「稍后给你」「马上给你一版」「先到这里」之类的拖延话术，也不要在 handoff 里记「重写尚未输出」——本轮能答就答完，篇幅不够时精炼内容，而不是中断承诺。`;
}

// 简报被基底拒收时，把校验错误原样回灌给该棒（PROTOCOL §6：带校验错误重派一次）
function rejectionMessage(v) {
  return (
    `[系统·简报校验未通过] 基底机械校验拒收了你的 handoff：\n` +
    v.errors.map((e) => `- ${e.msg}`).join('\n') +
    `\n\n请修正后重新输出完整 JSON（reply 内容保持不变，只重写 handoff）：\n{"reply":"…","handoff":"…"}`
  );
}

// ---------- 辅助：从模型输出抠 JSON ----------

function extractJSON(raw) {
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
async function fallbackHandoff(cfg, userMsg, reply, prevHandoff) {
  const out = await chatCompletion({
    ...cfg,
    temperature: 0.3,
    maxTokens: 600,
    messages: [
      {
        role: 'system',
        content: `你在为下一任助手更新《工作简报》。核心规则：简报是"已知信息的累积压缩"，不是本轮纪要——把上一份简报中仍相关的内容压缩保留，再融入本轮新信息；决策账本只增不删。格式：\n${HANDOFF_FORMAT}\n总长 ${BRIEF_BUDGET} 字以内。只输出文档本身。`,
      },
      {
        role: 'user',
        content: `【上一棒交接（已含此前所有轮次的压缩信息）】\n${prevHandoff || '（无，本轮是第一棒）'}\n\n【本轮用户消息】\n${userMsg}\n\n【本轮助手回复】\n${reply}\n\n请写出留给下一棒的交接文档：覆盖上一棒交接中的重要内容 + 本轮新增。`,
      },
    ],
  });
  return out.trim();
}

// 从损坏/截断的 JSON 中抢救 reply 字段
function salvageReply(raw) {
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
function unescapeText(s) {
  return String(s).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
}

// ---------- 单轮接力 ----------

// session: { sid, log: [{ts, role, agentId, text}], handoff, agentCount }
// 返回: { agentId, reply, handoff, logQueries, degraded, rejected, validation }
export async function runTurn({ session, message, cfg }) {
  const agentId = session.agentCount + 1;
  const prevHandoff = session.handoff || '';
  const logQueries = [];

  const messages = [
    { role: 'system', content: buildSystemPrompt(agentId, prevHandoff) },
    { role: 'user', content: message },
  ];

  let briefRetried = false;

  for (let i = 0; i < 3; i++) {
    const raw = await chatCompletion({
      ...cfg,
      temperature: cfg.temperature ?? 0.7,
      maxTokens: cfg.maxTokens ?? 3000, // reply + 四节简报同在一个 JSON，长回答很容易撞破小上限导致截断
      messages,
    });

    const parsed = extractJSON(raw);

    // 翻日志动作
    if (parsed && parsed.action === 'read_log' && logQueries.length < 2) {
      const query = String(parsed.query || '');
      const hits = searchLog(session, query);
      logQueries.push({ query, hits });
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

    // 正常回答：reply 有了，简报还要过基底校验
    if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      const reply = unescapeText(parsed.reply);
      const brief = (parsed.handoff && String(parsed.handoff).trim())
        ? String(parsed.handoff)
        : await fallbackHandoff(cfg, message, reply, prevHandoff);

      const v = validateHandoff(brief, { prevHandoff });
      if (v.ok) {
        return { agentId, reply, handoff: unescapeText(brief), logQueries, degraded: false, rejected: false, validation: { ok: true, errors: [] } };
      }

      // 拒收 → 带校验错误重派一次（§6）
      if (!briefRetried) {
        briefRetried = true;
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: rejectionMessage(v) });
        continue;
      }

      // 再不过 → 独立摘要调用兜底，并标记为 rejected
      const fb = await fallbackHandoff(cfg, message, reply, prevHandoff);
      return {
        agentId,
        reply,
        handoff: unescapeText(fb),
        logQueries,
        degraded: true,
        rejected: true,
        validation: validateHandoff(fb, { prevHandoff }),
      };
    }

    // 模型没按格式来：先尝试从坏 JSON 里抢救 reply，实在不行才整段兜底
    const salvaged = salvageReply(raw);
    const reply = salvaged != null ? unescapeText(salvaged) : unescapeText(raw.trim());
    if (!reply) throw new Error('模型返回为空');
    const fb = await fallbackHandoff(cfg, message, reply, prevHandoff);
    return {
      agentId,
      reply,
      handoff: unescapeText(fb),
      logQueries,
      degraded: true,
      rejected: false,
      validation: validateHandoff(fb, { prevHandoff }),
    };
  }

  throw new Error('翻日志次数超限，模型未给出正常回复');
}
