// 成本双账本（v0.1.2）：把 P1「上下文有界 → 成本有界」从论战变成面板上的两个数字。
//
// 实际接力成本：用端点回传的真实 usage（没有则按字符估算，标记 estimated）。
// 模拟单体成本：假设同一个模型每轮都把 system + 全部历史重读一遍——
//   已经读过的部分命中前缀缓存（按缓存价），只有本轮新消息按全价，输出与实际相同。
// 口径写死在这里，谁都能复算：输了不藏着，这才是这条轨道的可信度来源。

// 价目单位：美元 / 每百万 token。改价改这张表即可。
export const MODEL_PRICES = [
  { match: /^deepseek-chat$/i, label: 'DeepSeek V3', in: 0.27, out: 1.10, cached: 0.07 },
  { match: /^deepseek-reasoner$/i, label: 'DeepSeek R1', in: 0.55, out: 2.19, cached: 0.14 },
  { match: /gpt-4o-mini/i, label: 'GPT-4o mini', in: 0.15, out: 0.60, cached: 0.075 },
  { match: /^gpt-4o$/i, label: 'GPT-4o', in: 2.5, out: 10, cached: 1.25 },
  { match: /gpt-3\.5-turbo/i, label: 'GPT-3.5 turbo', in: 0.5, out: 1.5, cached: 0.5 },
  { match: /:free$/i, label: '免费档', in: 0, out: 0, cached: 0, free: true },
  { match: /llama|qwen|ollama|localhost|127\.0\.0\.1/i, label: '本地/开源自部署', in: 0, out: 0, cached: 0, free: true },
];

// 未知模型不假装知道价格，但也不让面板空着：按中位档估算，并在面板标注。
export const DEFAULT_PRICE = { label: '未知模型（按默认档估算）', in: 0.3, out: 1.2, cached: 0.03, unknown: true };

// 单体架构的 system prompt 长度假设（每轮都要重读，计入缓存部分）
export const SINGLE_SYSTEM_CHARS = 600;

export function priceOf(model) {
  const m = String(model || '');
  for (const p of MODEL_PRICES) if (p.match.test(m)) return p;
  return DEFAULT_PRICE;
}

// 粗估：汉字 1 字 ≈ 1 token，其余每 4 字符 ≈ 1 token。够用来画曲线，不用来对账。
export function estimateTokens(text) {
  const s = String(text || '');
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = s.replace(/[\u4e00-\u9fff]/g, '').replace(/\s+/g, ' ').length;
  return Math.ceil(han + rest / 4);
}

export function estimateMessagesTokens(messages) {
  return (messages || []).reduce((n, m) => n + estimateTokens(m?.content) + 4, 0);
}

function usd(tokens, pricePerMillion) {
  return (tokens / 1_000_000) * pricePerMillion;
}

/**
 * 会话成本双账本。
 * @param {object} o { batons, log, model }
 * @returns 累计序列 series:[{n, relay, single}] 与两侧总计，单位美元
 */
export function computeCost({ batons = [], log = [], model = '' } = {}) {
  const p = priceOf(model);
  const series = [];
  let relayIn = 0, relayOut = 0, relayCost = 0, singleCost = 0;
  // 单体架构第 n 轮的输入前缀 = system + 前 n-1 轮的 user+assistant 全文
  let prefixTokens = estimateTokens('x'.repeat(SINGLE_SYSTEM_CHARS));
  let estimated = false;

  for (let i = 0; i < batons.length; i++) {
    const b = batons[i];
    const t = b.telemetry || {};
    const inTok = t.inputTokens || 0;
    const outTok = t.outputTokens || 0;
    if (t.estimated) estimated = true;

    relayIn += inTok;
    relayOut += outTok;
    relayCost += usd(inTok, p.in) + usd(outTok, p.out);

    const fresh = estimateTokens(b.userMessage);
    const cached = prefixTokens;
    singleCost += usd(cached, p.cached) + usd(fresh, p.in) + usd(outTok, p.out);
    prefixTokens += fresh + outTok;

    series.push({ n: i + 1, relay: relayCost, single: singleCost });
  }

  return {
    model,
    price: { label: p.label, in: p.in, out: p.out, cached: p.cached, unknown: !!p.unknown, free: !!p.free },
    relay: { in: relayIn, out: relayOut, cost: relayCost },
    single: { cost: singleCost },
    series,
    estimated,
    turns: batons.length,
    logChars: (log || []).reduce((n, l) => n + String(l.text || '').length, 0),
  };
}
