// 返回值两类处理（PROTOCOL §2.1 / §2.2，H0）：基底对工具返回的机械分类与聚合。
// 原则：能写成确定性规则的写进脚本——分类不问模型，聚合不进提示词。
//
// 两类：
//   确认型（ack）  写入成功/失败、权限拒绝 —— 聚合为一行交给下一棒，不为每个确认各开一棒
//   信息型（info） 搜索命中、文件内容、报错详情 —— 这是"新信息"，触发换棒
//
// 分类规则是纯查表 + 纯函数：write_file 的成败都是确认；权限拒绝是确认；
// 其余工具的返回（含报错详情）一律信息型 —— 报错是下一棒决策的依据，不能压成一行。

/**
 * 按工具名与执行结果分类返回值。
 * @param {string} tool 工具名
 * @param {object} result executeTool 的返回：{ ok, tool, … } 或 { ok:false, denied:true, … }
 * @returns {'ack'|'info'}
 */
export function classifyReturn(tool, result) {
  if (result && result.denied) return 'ack'; // 权限拒绝：只值得一句确认，不值得换棒
  if (tool === 'write_file') return 'ack'; // 写入成败都是确认（§2.1 表：成功/失败、退出码）
  return 'info'; // search_files / read_file / 未知工具 / 报错详情
}

// 单条确认的一行摘要：write → 「path ✓ (N 字)」/「path ✗ (原因)」；denied → 「tool ✗ 越权」
function ackLine(r) {
  if (r.denied) return `${r.tool} 被拒（不在本棒白名单）`;
  if (r.ok) return `${r.tool} ${r.target || r.path || '?'} 成功${r.bytes != null ? `（${r.bytes} 字）` : ''}`;
  return `${r.tool} ${r.target || r.path || '?'} 失败（${r.error || '未知原因'}）`;
}

/**
 * 把一批确认型返回聚合为一行（§2.1：不为每个确认各开一棒）。
 * 空输入返回空串。错误码逐个点名，成功只报计数 —— 一行说清"世界上被改了什么"。
 * @param {Array<{tool:string, ok:boolean, target?:string, path?:string, bytes?:number, error?:string, denied?:boolean}>} acks
 * @returns {string} 形如「写入/确认 3 个：2 成功、1 失败（EACCES@sub/b.txt）」
 */
export function aggregateAcks(acks) {
  const list = (acks || []).filter(Boolean);
  if (!list.length) return '';
  const ok = list.filter((r) => r.ok && !r.denied);
  const bad = list.filter((r) => !r.ok && !r.denied);
  const denied = list.filter((r) => r.denied);
  const parts = [];
  if (ok.length) parts.push(`${ok.length} 成功`);
  if (bad.length) parts.push(`${bad.length} 失败（${bad.map((r) => `${r.error || '?'}@${r.target || r.path || '?'}`).join('、')}）`);
  if (denied.length) parts.push(`${denied.length} 越权被拒（${denied.map((r) => r.tool).join('、')}）`);
  return `确认聚合 ${list.length} 个：${parts.join('、')}`;
}

/**
 * 信息型返回的一行导语：供驱动输入里标注「为什么换棒」。
 * @param {Array} infos 分类为 info 的返回
 * @returns {string} 如「search_files 命中 12 处」/「read_file 返回 sub/a.txt 共 80 行」/「read_file 失败：ENOENT」
 */
export function infoLine(r) {
  if (!r) return '';
  if (r.ok === false) return `${r.tool} 失败：${r.error || '未知原因'}`;
  if (r.tool === 'search_files') return `${r.tool}「${r.pattern}」命中 ${r.total ?? (r.hits || []).length} 处`;
  if (r.tool === 'read_file') return `${r.tool} ${r.path} 共 ${r.totalLines ?? '?'} 行`;
  return `${r.tool} 返回`;
}
