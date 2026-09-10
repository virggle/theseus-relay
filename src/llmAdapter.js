// OpenAI 兼容的 Chat Completions 适配层。
// 任何实现了 /chat/completions 的端点都能用：OpenAI / DeepSeek / OpenRouter / 本地 Ollama-vLLM 等。
// 关键约束：玩家只填 baseUrl + apiKey + model，后缀 /chat/completions 由本层自动补全，
// 玩家永远不需要关心协议细节（参考 SillyTavern 的 Custom/OpenAI-compatible 连接模型）。

// 免费档供应商常有限速（429）、偶发 5xx，或网络抖动导致连接挂起。
// 这里做：指数退避重试 + 单次请求超时（超时视为瞬时故障，自动重连重试），让 demo 更稳。

const DEFAULT_TIMEOUT = 90000; // 单次请求最长等待（ms），超时即重试
const MAX_RETRIES = 6; // 最多重试次数（含首次共 7 次尝试）

// 组合「外部取消信号」与「单次超时」为本次 fetch 用的 AbortSignal
function makeSignal(externalSignal, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    clear() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

// 是否可重试的瞬时故障
function isTransient(err) {
  if (err.name === 'AbortError') return true; // 超时或外部取消
  if (err.message.startsWith('LLM 请求失败')) return true; // 429/5xx
  if (/network|fetch failed|timeout|econn|eai_again|socket/i.test(err.message)) return true;
  return false;
}

async function postWithRetry(url, headers, body, signal, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { signal: sig, clear } = makeSignal(signal, timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: sig,
      });
      clear();
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(3000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 1000);
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        throw new Error(`LLM 请求失败 ${res.status}（重试 ${maxRetries} 次后仍失败）: ${detail.slice(0, 400)}`);
      }
      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        throw new Error(`LLM 请求失败 ${res.status}: ${detail.slice(0, 600)}`);
      }
      return res;
    } catch (e) {
      clear();
      lastErr = e;
      if (isTransient(e) && attempt < maxRetries) {
        const wait = Math.min(3000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 1000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('LLM 请求未知错误');
}

export async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.8,
  maxTokens = 512,
  topP,
  reasoning,
  signal,
  timeoutMs,
  maxRetries,
}) {
  const url = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '') + '/chat/completions';

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (topP != null) body.top_p = topP;
  // OpenRouter 推理模型（Nemotron/GPT-OSS 等）可关闭思考过程，避免污染角色台词与 JSON
  if (reasoning != null) body.reasoning = reasoning;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // OpenRouter 需要的可选头，其他兼容端点会忽略
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'Theseus Relay',
  };

  const res = await postWithRetry(
    url,
    headers,
    body,
    signal,
    { timeoutMs, maxRetries }
  );
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error(`LLM 返回为空：${JSON.stringify(data).slice(0, 300)}`);
  }
  // usage 用于遥测（v0.1.2）。端点不给就算 null，由上层按字符估算并标记 estimated。
  const u = data?.usage || {};
  const usage = {
    input: Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null,
    output: Number.isFinite(u.completion_tokens) ? u.completion_tokens : null,
    cached: Number.isFinite(u.prompt_tokens_details?.cached_tokens)
      ? u.prompt_tokens_details.cached_tokens
      : Number.isFinite(u.prompt_cache_hit_tokens) ? u.prompt_cache_hit_tokens : 0,
  };
  return { content, usage };
}

// 轻量连通性测试（快速失败：不深度重试，避免挂到代理超时）
export async function testConnection(llmConfig, opts = {}) {
  const { content } = await chatCompletion({
    ...llmConfig,
    maxTokens: 16,
    messages: [{ role: 'user', content: '只回复：ok' }],
    timeoutMs: opts.timeoutMs ?? 20000,
    maxRetries: opts.maxRetries ?? 1,
  });
  return content.trim();
}
