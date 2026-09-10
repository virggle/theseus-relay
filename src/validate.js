// 基底校验器 v0.1.1 —— 把 PROTOCOL §4 的五项机械校验从提示词落到脚本。
// 原则：能写进基底的规则不留在提示词里。模型会作弊（「（保留全部旧结论）」就是实录），脚本不会。
//
// 五项校验（纯函数，除指针项外无 IO）：
//   1. 四节齐全        标题结构匹配
//   2. 无占位符        元注释正则
//   3. 预算内          去空白字符数 ≤ 800
//   4. 决策只增不删    与上一份简报 diff：决策、用户画像条目数不得减少
//   5. 指针有效        不变量 4 的落盘指针，指向的基底路径必须真实存在（无指针则通过）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTION_TITLES = ['进展', '决策', '用户画像', '开放问题'];
export const BRIEF_BUDGET = 800;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// lazy: 兼容历史会话里写过的「## 用户画像与偏好」，统一输出后（v0.3）可收紧为纯「用户画像」
const HEADING_RE = SECTION_TITLES.map(
  (t) => new RegExp(`^#{1,6}\\s*${t}(?:与偏好)?\\s*$`, 'm')
);

// 占位符模式：全是实测抓到的模型作弊样本，命中即协议级违规
export const PLACEHOLDER_RES = [
  /[（(]\s*保留[^）)\n]{0,20}(?:旧|之前|上述|上面)[^）)\n]{0,20}[）)]/,
  /\[\s*保留[^\]\n]{0,20}(?:旧|之前|上述)[^\]\n]{0,20}\]/,
  /(?:保留全部旧结论|保留旧结论|保留之前的结论|保留上述内容|保留上一版)/,
  /^\s*[-*·]?\s*(?:同上|同前|略|（略）|\(略\)|…|省略|见上|见前文|如前所述|不变|无变化)\s*[。.）)]?\s*$/m,
  /[（(]\s*(?:同上|略|省略|见前文|如前所述)\s*[）)]/,
];

// 落盘指针语法：-> 相对路径（可带 # 锚点）。例：-> docs/ADR-0001.md#决策
const POINTER_RE = /->\s*([^\s，,；;。)\]】]+)/g;

export function countChars(s) {
  return [...String(s || '').replace(/\s+/g, '')].length;
}

// 按节标题切分简报；缺节返回空串（由校验项 1 报错，这里不抛）
export function parseSections(handoff) {
  const text = String(handoff || '');
  const marks = [];
  for (let i = 0; i < SECTION_TITLES.length; i++) {
    const m = text.match(HEADING_RE[i]);
    if (m) marks.push({ key: SECTION_TITLES[i], at: m.index, len: m[0].length });
  }
  marks.sort((a, b) => a.at - b.at);
  const out = {};
  for (const t of SECTION_TITLES) out[t] = '';
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at + marks[i].len;
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    out[marks[i].key] = text.slice(start, end).trim();
  }
  return out;
}

// 条目计数：非空行，行首的项目符号/序号不计入条目本身
export function countItems(sectionText) {
  return String(sectionText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l)).length;
}

export function findPointers(handoff) {
  const text = String(handoff || '');
  const out = [];
  for (const m of text.matchAll(POINTER_RE)) out.push(m[1].replace(/#.*$/, ''));
  return out;
}

function defaultExists(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
  return fs.existsSync(abs);
}

/**
 * 校验一份简报。
 * @param {string} handoff 待校验简报
 * @param {object} opts { prevHandoff, budget, exists }
 * @returns {{ok:boolean, errors:Array<{code:string,msg:string}>, checks:object}}
 */
export function validateHandoff(handoff, opts = {}) {
  const { prevHandoff = '', budget = BRIEF_BUDGET, exists = defaultExists } = opts;
  const errors = [];
  const text = String(handoff || '');
  const sections = parseSections(text);

  // 1. 四节齐全
  const missing = SECTION_TITLES.filter((t) => !text.match(HEADING_RE[SECTION_TITLES.indexOf(t)]));
  if (missing.length) {
    errors.push({ code: 'SECTIONS_MISSING', msg: `缺少节标题：${missing.map((t) => '## ' + t).join('、')}` });
  }

  // 2. 无占位符
  for (const re of PLACEHOLDER_RES) {
    const m = text.match(re);
    if (m) {
      errors.push({ code: 'PLACEHOLDER', msg: `出现元注释/占位符：「${m[0].trim().slice(0, 30)}」——后棒看不到旧简报，占位符等于销毁信息` });
      break;
    }
  }

  // 3. 预算内
  const chars = countChars(text);
  if (chars > budget) {
    errors.push({ code: 'BUDGET', msg: `简报 ${chars} 字，超出上限 ${budget} 字` });
  }

  // 4. 决策只增不删（无上一份简报则跳过）
  const prevSections = prevHandoff ? parseSections(prevHandoff) : null;
  const monotonic = { decisions: { prev: null, cur: null }, profile: { prev: null, cur: null } };
  if (prevSections) {
    for (const [key, label, code] of [
      ['决策', 'decisions', 'DECISIONS_SHRUNK'],
      ['用户画像', 'profile', 'PROFILE_SHRUNK'],
    ]) {
      const p = countItems(prevSections[key]);
      const c = countItems(sections[key]);
      monotonic[label] = { prev: p, cur: c };
      if (c < p) {
        errors.push({ code, msg: `「${key}」条目由 ${p} 条减到 ${c} 条——决策账本只增不删` });
      }
    }
  }

  // 5. 指针有效（条件校验：无落盘指针则直接通过，等 v0.3 落盘规则落地后自动生效）
  const pointers = findPointers(text);
  const deadPointers = pointers.filter((p) => p && !exists(p));
  if (deadPointers.length) {
    errors.push({ code: 'POINTER_MISSING', msg: `落盘指针指向的基底路径不存在：${deadPointers.join('、')}` });
  }

  return {
    ok: errors.length === 0,
    errors,
    checks: { chars, budget, missing, monotonic, pointers },
  };
}
