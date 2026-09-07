// 极简 .env 加载器（零依赖）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

let _cache = null;

export function loadEnv() {
  if (_cache) return _cache;
  const env = { ...process.env };
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in env)) env[m[1]] = v;
    }
  } catch {
    /* 没有 .env 就用 process.env */
  }
  _cache = env;
  return env;
}

// 预设服务商（前端下拉选单的数据源，也供后端 /api/providers 暴露）。
// 选「其他」时由用户自定义 baseUrl / model。
export const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    reasoningDefault: false, // DeepSeek 普通模型无需关闭推理
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    reasoningDefault: false,
  },
  openrouter: {
    label: 'OpenRouter（免费档需自备 key）',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'nvidia/nemotron-3-super-120b-a12b:free',
      'meta-llama/llama-3.1-8b-instruct:free',
      'openai/gpt-oss-120b',
    ],
    reasoningDefault: true, // 推理模型需关闭思考过程，避免污染台词
  },
  ollama: {
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3', 'qwen2.5', 'deepseek-r1'],
    reasoningDefault: false,
  },
  other: {
    label: '其他（自定义）',
    baseUrl: '',
    models: [],
    reasoningDefault: false,
  },
};

// 把一个 ProviderProfile（前端 BYOK 传入）规整为 llmConfig
export function toLlmConfig(profile) {
  const base = (profile.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const cfg = {
    baseUrl: base,
    apiKey: profile.apiKey || '',
    model: profile.model || 'nvidia/nemotron-3-super-120b-a12b:free',
    temperature: profile.temperature ?? 0.9,
  };
  // reasoning 仅当用户显式开启/关闭时才下发，避免干扰 DeepSeek 等普通模型
  if (profile.reasoning) cfg.reasoning = profile.reasoning;
  return cfg;
}
