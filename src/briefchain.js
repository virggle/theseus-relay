// 简报链的导出与跨会话导入（v0.1.3）——P6 持久化轨道的第一个落点：
// 简报链从「会话内工件」变成「人类可读、模型无关、可导出可导入」的记忆载体。
//
// 三条口径写死在这里，不靠提示词：
// 1. **导出逐字段白名单**：只搬 { agentId, ts, handoff, handoffReason } + 终局简报 + 显式头部。
//    没有 key、没有 baseUrl、没有工具调用参数、没有遥测——白名单而非黑名单，新字段默认不外泄。
// 2. **导入只搬两节**：决策 + 用户画像。进展 / 开放问题 / 副作用不跨会话搬运；
//    上一会话的 log 一行都不进新会话（PROTOCOL §5：log 是档案库，永不自动进入任何棒的上下文）。
// 3. **导入的简报就是「上一份简报」**：它必须能过 validateHandoff，且预算要留出余地——
//    导入部分占满 800 字的话，第一棒要么丢条目（判成「条目变少」被拒收），要么自己超标（同样被拒收）。

import { parseSections, countChars } from './validate.js';

export const BRIEF_CHAIN_FORMAT = 'theseus-brief-chain';
export const BRIEF_CHAIN_V = 1; // 为 v0.5 的 schema 版本化留位：导入端只认自己认识的 v

// 导入简报的身份标记。它同时是提示词开关：relay / task 据此给第一棒加一条硬规则。
export const IMPORT_MARK = '【跨会话导入】';

// 给导入后第一棒的硬规则。只在「上一份简报带导入标记」时出现，且落在简报之前——
// 它在同一会话内是常量，因此不会缩短可缓存前缀（R4）。
export const IMPORT_RULE = `【跨会话导入】这份简报是上一会话导入的：其中「决策」与「用户画像」两节的条目**一条都不许少**——基底校验会拿这份导入简报做「只增不删」diff，少一条即拒收重派。\n\n`;

// 唯一跨会话搬运的两节
export const IMPORT_SECTIONS = ['决策', '用户画像'];

// 导入简报的预算上限（低于 validate.js 的 BRIEF_BUDGET = 800）：
// 差额留给第一棒自己写进展 / 开放问题 / 副作用。超出的部分按丢弃优先级自尾部裁掉并如实标注。
export const IMPORT_BRIEF_BUDGET = 600;

const PROGRESS = '本会话尚未产生新的进展。';
const OPEN_Q = '新会话尚未提出开放问题；上一会话的开放问题按协议不跨会话搬运。';
const SIDE = '无';

function sectionLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 导出一条会话的简报链（纯函数，确定性：exportedAt 可注入）。
 * @returns {{format:string, v:number, exportedAt:string, batons:Array, finalBrief:string}}
 */
export function buildBriefChain(session, opts = {}) {
  // 逐字段白名单：只认这四样，其余（calls / telemetry / drivingInput / userMessage …）一概不进导出物
  const batons = ((session && session.batons) || []).map((b) => ({
    agentId: b.agentId,
    ts: b.ts ?? null,
    handoff: String(b.handoff || ''),
    handoffReason: b.handoffReason || null,
  }));
  const lastHandoff = batons.length ? batons[batons.length - 1].handoff : '';
  return {
    format: BRIEF_CHAIN_FORMAT,
    v: BRIEF_CHAIN_V,
    exportedAt: opts.exportedAt || new Date().toISOString(),
    batons,
    finalBrief: String((session && session.handoff) || lastHandoff || ''),
  };
}

// 人类可读的落盘形态（缩进 2）：导出文件与下载内容都走这一个序列化器，口径只有一处
export function serializeBriefChain(chain) {
  return JSON.stringify(chain, null, 2);
}

/**
 * 读入并认领一条外部简报链。不抛错：坏输入以 { ok:false, error } 返回。
 */
export function readBriefChain(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      return { ok: false, error: `不是合法的 JSON：${e.message}` };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '简报链必须是一个 JSON 对象' };
  }
  if (obj.format !== BRIEF_CHAIN_FORMAT) {
    return { ok: false, error: `这不是本基底的简报链（format 应为 ${BRIEF_CHAIN_FORMAT}）` };
  }
  const v = Number(obj.v);
  if (!Number.isFinite(v) || v < 1) return { ok: false, error: '简报链缺少版本号 v' };
  if (v > BRIEF_CHAIN_V) return { ok: false, error: `简报链版本 v${v} 高于本基底支持的 v${BRIEF_CHAIN_V}` };

  const batons = Array.isArray(obj.batons) ? obj.batons : [];
  const last = batons.length ? String(batons[batons.length - 1].handoff || '') : '';
  const finalBrief = String(obj.finalBrief || last || '').trim();
  if (!finalBrief) return { ok: false, error: '简报链里没有终局简报（finalBrief 为空）' };
  return { ok: true, chain: { format: obj.format, v, exportedAt: obj.exportedAt || '', batons, finalBrief } };
}

/**
 * 由简报链构造新会话的初始简报：决策 + 画像逐条搬运，其余三节按规矩补齐（事实陈述，不是占位符）。
 * 超出 IMPORT_BRIEF_BUDGET 时按丢弃优先级自尾部裁（画像先于决策），并如实标注裁了几条。
 * @returns {{ handoff:string, chars:number, dropped:{决策:number,用户画像:number} }}
 */
export function buildImportedBrief(chain, opts = {}) {
  const budget = opts.budget ?? IMPORT_BRIEF_BUDGET;
  const sec = parseSections(chain.finalBrief);
  const decisions = sectionLines(sec['决策']);
  const profile = sectionLines(sec['用户画像']);
  const dropped = { 决策: 0, 用户画像: 0 };

  const compose = () => {
    // 裁掉的条目要如实说，不能假装简报本来是完整的
    const clip = (title) =>
      dropped[title] ? `（导入时超出基底预算，本节自尾部未搬运 ${dropped[title]} 条）` : '';
    const block = (title, arr) =>
      `## ${title}\n${[arr.join('\n'), clip(title)].filter(Boolean).join('\n')}`;
    return [
      `${IMPORT_MARK}本会话由上一会话的简报链导入：只搬运「决策」与「用户画像」两节，进展 / 开放问题 / 副作用按协议不跨会话搬运；上一会话的 log 一行都没有带过来。以下两节取自上一会话终局简报（导出于 ${chain.exportedAt || '未记录'}）。`,
      `## 进展\n${PROGRESS}`,
      block('决策', decisions),
      block('用户画像', profile),
      `## 开放问题\n${OPEN_Q}`,
      `## 副作用\n${SIDE}`,
    ].join('\n\n');
  };

  let handoff = compose();
  // 丢弃优先级（PROTOCOL §3 不变量 3）：画像 < 决策 —— 决策是最神圣的一节，最后才动。
  while (countChars(handoff) > budget && profile.length > 1) {
    profile.pop();
    dropped['用户画像'] += 1;
    handoff = compose();
  }
  while (countChars(handoff) > budget && decisions.length > 1) {
    decisions.pop();
    dropped['决策'] += 1;
    handoff = compose();
  }
  return { handoff, chars: countChars(handoff), dropped, overBudget: countChars(handoff) > budget };
}

/**
 * 把导入简报落进会话：agentCount 归零重新计数，log / batons / artifacts 全清。
 * 清空是**由构造保证**的——「上一会话的 log 一行都不进新会话」不是靠调用方自觉。
 * @returns {{ log:number, batons:number }} 被清掉的历史量（供面板如实告知）
 */
export function applyImportedBrief(session, handoff) {
  const cleared = { log: (session.log || []).length, batons: (session.batons || []).length };
  session.handoff = String(handoff || '');
  session.agentCount = 0;
  session.log = [];
  session.batons = [];
  session.artifacts = [];
  return cleared;
}
