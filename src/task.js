// 单链步进 runner（H0，PROTOCOL §2.1 / §2.2）。
//
// 一根棒只做一次动作：发出 {"calls":[…],"handoff":"…"} 或 {"reply":"…","handoff":"…"}，然后销毁。
// 工具返回不回到产出它的那根棒：
//   - 确认型（写成功/失败、越权拒绝）→ 基底聚合成一行，连同实际写入记录注入下一棒
//   - 信息型（搜索命中/文件内容/报错详情）→ 触发换棒，新棒带着它上场（长输出先落基底，棒内只见摘要 + 指针）
// 任务级预算（棒数 / 成本）触顶：停机并给出基底生成的报告，不抛错。
//
// 棒内的校验重派 / 兜底摘要是 §2.1 硬条款 2 认可的机械修补，不是 ReAct 循环。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callLLM, fallbackHandoff, extractJSON, salvageReply, unescapeText, HANDOFF_FORMAT, BUDGET, sumCalls } from './relay.js';
import { validateHandoff, BRIEF_BUDGET } from './validate.js';
import { createTools, TOOL_SIGNATURES } from './tools.js';
import { classifyReturn, aggregateAcks, infoLine } from './returns.js';
import { batonCostUsd } from './pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

// ---------- H0 常量（默认值，可被 opts 覆盖） ----------

export const TASK_BUDGET = { maxBatonsPerTask: 24, maxCostPerTaskUsd: 0.5 }; // 棒数上限须容得下验收口径「20 步任务跑完」，余量待实测标定（ROADMAP）
export const MAX_CALLS_PER_BATON = 8; // 防异常输出刷爆基底；正常一批调用远小于此
export const ARTIFACT_MAX_CHARS = 1000; // 超过则全文落基底（v0.3a），棒内只见摘要 + 指针
export const ARTIFACT_SUMMARY_CHARS = 300;

// ---------- 纯函数：工具结果的呈现与驱动输入装配（可单测） ----------

/**
 * 把信息型返回渲染为文本（供驱动输入 / artifact 全文）。
 */
export function renderInfoResult(r) {
  if (!r) return '';
  if (r.tool === 'read_file' && r.lines) {
    return r.lines.map((l) => `${l.no}|${l.text}`).join('\n');
  }
  if (r.tool === 'search_files' && r.hits) {
    return r.hits.map((h) => `${h.file}:${h.lineNo}: ${h.text}`).join('\n');
  }
  return r.error ? String(r.error) : JSON.stringify(r);
}

/**
 * 装配下一棒的驱动输入：确认聚合一行 + 实际写入记录 + 信息型返回（长输出落基底后给摘要 + 指针）。
 * @returns {{ text: string, artifacts: Array<{path:string, chars:number, tool:string}> }}
 */
export function buildDrivingInput({ acks = [], infos = [], writes = [] }) {
  const parts = [];
  const agg = aggregateAcks(acks);
  if (agg) parts.push(`[系统·确认聚合] ${agg}`);
  if (writes.length) parts.push(`[系统·实际写入] 本棒真实发生的写入（基底记账）：${writes.map((w) => w.target).join('、')}`);
  const artifacts = [];
  for (const r of infos) {
    const text = renderInfoResult(r);
    if (text.length > ARTIFACT_MAX_CHARS) {
      const a = r.artifact; // 基底在执行调用时已把全文落盘，指针挂在结果上
      if (a) artifacts.push(a);
      const summary = text.slice(0, ARTIFACT_SUMMARY_CHARS);
      parts.push(
        `[系统·信息返回] ${infoLine(r)}\n` +
          `${summary}\n…（输出共 ${text.length} 字，超过 ${ARTIFACT_MAX_CHARS} 字已全文落基底：-> ${a ? a.path : '（落盘失败）'}）。` +
          `本棒上下文里没有原文；需要细节时用 read_file 按行分段取回（那会是一次新的信息型返回）。`
      );
    } else {
      parts.push(`[系统·信息返回] ${infoLine(r)}\n${text}`);
    }
  }
  if (!parts.length) parts.push('[系统·工具返回] 上一棒发出了调用，但没有产生任何返回内容。');
  return { text: parts.join('\n\n'), artifacts };
}

/**
 * 触顶停机报告：基底生成，零 token，确定性文本。
 */
export function buildChainReport({ status, stoppedReason, batonsRun, costUsd, maxBatons, maxCost, lastHandoff, pendingInfos }) {
  const why =
    stoppedReason === 'maxCost'
      ? `任务成本触顶（累计 $${costUsd.toFixed(4)} ≥ 上限 $${maxCost}）`
      : `棒数触顶（已运行 ${batonsRun} 根 ≥ 上限 ${maxBatons} 根）`;
  const lines = [
    `【任务停机报告】${status === 'budget_stopped' ? why : '任务已完成。'}`,
    `已运行 ${batonsRun} 根棒，累计成本 $${costUsd.toFixed(4)}。`,
  ];
  if (pendingInfos && pendingInfos.length) {
    lines.push(`尚未消费的信息型返回：${pendingInfos.map((i) => infoLine(i)).join('；')}`);
  }
  lines.push(lastHandoff ? `最后一棒简报已保留下一步意图（${lastHandoff.length} 字），可从中断处继续。` : '无简报留存。');
  return lines.join('\n');
}

// ---------- 工具棒的 system prompt ----------

// R4：同 relay.buildSystemPrompt —— 固定内容全部在前，逐棒变化的内容（只有简报）只许出现在末尾；
// 棒编号一类的逐棒差异一律不进 prompt（它会把前缀缓存在那一字节处截断）。
// 同时修掉一个真实缺陷：此前 prev 变量算了却从未注入，工具棒根本看不到上一棒的简报，
// 而 PROTOCOL §1 的核心不变量是「简报是棒与棒之间唯一的传输介质」。
export function buildToolPrompt(agentId, prevHandoff, whitelist) {
  const sigs = whitelist.map((t) => `- ${t} ${TOOL_SIGNATURES[t] || ''}`).join('\n');
  return `你是任务接力中的一棒（单链步进）。你只有两样东西：上一棒的简报 + 本棒的驱动输入（用户消息或上一批工具调用的返回值）。

可用工具（白名单，越权调用会被基底拒绝并计入确认聚合）：
${sigs}

判定规则（唯一判据，静态判断）：
- 下一步的行动**依赖**某个调用的返回值 → 本棒只发出这批依赖的调用，然后交棒
- **不依赖** → 这批调用在本棒一次性发完；不需要工具就直接回答

输出单个 JSON（不含其他文字），calls 与 reply 互斥：
发调用：{"calls":[{"tool":"工具名","args":{...}},...],"handoff":"..."}
回答：{"reply":"回复内容","handoff":"..."}

简报固定格式（五节缺一不可，节标题原样保留）：
${HANDOFF_FORMAT}

简报规则：累积压缩而非本轮纪要；决策只增不删；发出 calls 时返回值还没回来，「开放问题」必须写明**下一步做什么 + 依据哪个证据**（意图包）。总长 ${BRIEF_BUDGET} 字以内。你的简报会被基底机械校验，不过则拒收重派一次。

【重要】calls 与 reply 不许同时出现；一次输出完整 JSON，不要拖延。

【工作简报（上一棒留给你，其中已压缩了此前全部链路的信息）】
${prevHandoff || '（无，本棒是第一棒）'}`;
}

// ---------- 单棒执行（发一次动作 + 机械修补），结构对照 relay.runTurn ----------

async function runBaton({ agentId, drivingInput, prevHandoff, cfg, whitelist }) {
  const calls = [];
  const used = { calls: 0, logLookups: 0, repairs: 0, fallbacks: 0 };
  const messages = [
    { role: 'system', content: buildToolPrompt(agentId, prevHandoff, whitelist) },
    { role: 'user', content: drivingInput },
  ];

  let emittedCalls = null; // [{tool,args}] 原始请求
  let reply = null;
  let brief = null;
  let salvaged = false;
  let rejected = false;
  let validation = null;

  while (used.calls < BUDGET.calls) {
    const { content: raw, call } = await callLLM(cfg, messages, used.repairs ? 'repair' : 'turn');
    calls.push(call);
    used.calls += 1;

    const parsed = extractJSON(raw);

    // 翻日志（受限检索，属 calls 语义）：任务链不带全量 log，明确告知而非静默失败
    if (parsed && parsed.action === 'read_log') {
      if (used.logLookups >= BUDGET.logLookups) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: `[系统·翻日志次数已用尽] 本棒最多查 ${BUDGET.logLookups} 次。请用现有信息继续：发出 calls 或给出 reply。`,
        });
        continue;
      }
      used.logLookups += 1;
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `[系统·翻日志结果] 任务链模式下不提供历史检索（命中 0 条）。请直接基于简报与驱动输入行动。`,
      });
      continue;
    }

    // calls 路径：calls 与 reply 互斥，calls 优先（基底强制 §2.2 合同）
    if (parsed && Array.isArray(parsed.calls) && parsed.calls.length) {
      emittedCalls = parsed.calls;
      brief = parsed.handoff && String(parsed.handoff).trim() ? String(parsed.handoff) : null;
    } else if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      reply = unescapeText(parsed.reply);
      brief = parsed.handoff && String(parsed.handoff).trim() ? String(parsed.handoff) : null;
    } else {
      const s = salvageReply(raw);
      if (s == null) continue; // 什么都没抢到：再给一次机会（受 calls 上限保护）
      reply = unescapeText(s);
      salvaged = true;
    }

    // 简报缺失 → 兜底摘要（§6）
    if (!brief && used.fallbacks < BUDGET.fallbacks) {
      used.fallbacks += 1;
      used.calls += 1;
      const actionDesc = emittedCalls
        ? `发出了 ${emittedCalls.length} 个工具调用：${emittedCalls.map((c) => c && c.tool).join('、')}`
        : String(reply || '').slice(0, 200);
      brief = await fallbackHandoff(cfg, drivingInput, actionDesc, prevHandoff, calls);
    }
    if (!brief) break;

    validation = validateHandoff(brief, { prevHandoff });
    if (validation.ok) break;

    if (used.repairs < BUDGET.repairs) {
      used.repairs += 1;
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content:
          `[系统·简报校验未通过] 基底机械校验拒收了你的 handoff：\n` +
          validation.errors.map((e) => `- ${e.msg}`).join('\n') +
          `\n\n请修正后重新输出完整 JSON（动作内容保持不变，只重写 handoff）。`,
      });
      continue;
    }

    rejected = true; // 仍不过：兜底重写（下一段），不拦截动作本身
    if (used.fallbacks < BUDGET.fallbacks) {
      used.fallbacks += 1;
      used.calls += 1;
      const actionDesc = emittedCalls
        ? `发出了 ${emittedCalls.length} 个工具调用：${emittedCalls.map((c) => c && c.tool).join('、')}`
        : String(reply || '').slice(0, 200);
      brief = await fallbackHandoff(cfg, drivingInput, actionDesc, prevHandoff, calls);
      validation = validateHandoff(brief, { prevHandoff });
    }
    break;
  }

  // 遥测口径与对话线共用 sumCalls（R3 的 cached 才不会在两处漂移）
  const telemetry = {
    model: cfg.model || '',
    calls,
    ...sumCalls(calls),
    repairs: used.repairs,
    fallbacks: used.fallbacks,
    rejected,
    salvaged,
  };

  return { emittedCalls, reply, brief, telemetry, validation, rejected, salvaged };
}

// ---------- artifacts（v0.3a：长工具输出落基底） ----------

function persistArtifact(sid, batonSeq, callIdx, tool, text) {
  try {
    const dir = path.join(REPO_ROOT, 'data', 'artifacts', sid);
    fs.mkdirSync(dir, { recursive: true });
    const name = `b${batonSeq}-${callIdx}.txt`;
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, text, 'utf8');
    return { path: `data/artifacts/${sid}/${name}`, chars: text.length, tool };
  } catch {
    return null; // 落盘失败不阻断链路：驱动输入里会标注「落盘失败」
  }
}

// ---------- 单链步进主循环 ----------

/**
 * 跑完一条任务链：用户消息起棒 → calls/返回交替驱动新棒 → reply 或触顶收束。
 * @param {object} p { session, message, cfg, opts }
 *   opts: { maxBatonsPerTask, maxCostPerTaskUsd, toolWhitelist }
 * @returns {{ status:'done'|'budget_stopped', stoppedReason, reply, handoff, batons:Array, costUsd, artifacts:Array }}
 */
export async function runChain({ session, message, cfg, opts = {} }) {
  const sid = session.sid || 'anon';
  const maxBatons = Math.max(1, opts.maxBatonsPerTask ?? TASK_BUDGET.maxBatonsPerTask);
  const maxCost = opts.maxCostPerTaskUsd ?? TASK_BUDGET.maxCostPerTaskUsd;
  const whitelist = opts.toolWhitelist || Object.keys(TOOL_SIGNATURES);

  const workspace = path.join(REPO_ROOT, 'data', 'workspace', sid);
  fs.mkdirSync(workspace, { recursive: true });
  const tools = createTools({ workspaceDir: workspace });

  let prevHandoff = session.handoff || '';
  let drivingInput = message;
  let status = 'done';
  let stoppedReason = null;
  let finalReply = null;
  let costUsd = 0;
  const chainBatons = [];
  const sessionArtifacts = session.artifacts || (session.artifacts = []);
  let lastInfos = [];

  for (let seq = 1; seq <= maxBatons; seq++) {
    const agentId = session.agentCount + seq;
    const baton = await runBaton({ agentId, drivingInput, prevHandoff, cfg, whitelist });
    costUsd += batonCostUsd(baton.telemetry, cfg.model);

    // 执行调用（§2.2：权限白名单按棒授予；写操作记录 target）
    const execResults = [];
    const acks = [];
    const infos = [];
    const writes = [];
    const artifactsThisBaton = [];
    if (baton.emittedCalls) {
      for (let ci = 0; ci < Math.min(baton.emittedCalls.length, MAX_CALLS_PER_BATON); ci++) {
        const c = baton.emittedCalls[ci] || {};
        const name = String(c.tool || '');
        let r;
        if (!whitelist.includes(name)) {
          r = { ok: false, denied: true, tool: name, error: '不在本棒白名单' };
        } else {
          r = tools.execute(name, c.args || {});
        }
        r.class = classifyReturn(name, r);
        execResults.push({ tool: name, args: c.args || {}, result: r });
        (r.class === 'ack' ? acks : infos).push(r);
        if (name === 'write_file' && r.ok && !r.denied) writes.push({ target: r.target || r.path, bytes: r.bytes });
        if (r.class === 'info') {
          const text = renderInfoResult(r);
          if (text.length > ARTIFACT_MAX_CHARS) {
            // v0.3a：长输出全文落基底，指针挂到结果上；buildDrivingInput 只放摘要 + 引用
            r.fullLength = text.length;
            const a = persistArtifact(sid, seq, ci, name, text);
            if (a) {
              r.artifact = a;
              artifactsThisBaton.push(a);
            }
          }
        }
      }
    }
    lastInfos = infos;

    chainBatons.push({
      agentId,
      seq,
      drivingInput,
      calls: execResults.map(({ tool, args, result }) => ({
        tool,
        args,
        class: result.class,
        ok: !!result.ok && !result.denied,
        denied: !!result.denied,
        summary: result.class === 'ack' ? (result.denied ? `${tool} 越权被拒` : `${result.target || result.path || tool} ${result.ok ? '成功' : '失败：' + (result.error || '?')}`) : infoLine(result),
        artifact: result.artifact ? result.artifact.path : null,
      })),
      emittedCalls: !!baton.emittedCalls,
      reply: baton.reply,
      handoff: baton.brief,
      writes,
      validation: baton.validation,
      rejected: baton.rejected,
      salvaged: baton.salvaged,
      telemetry: baton.telemetry,
      costUsd: batonCostUsd(baton.telemetry, cfg.model),
    });
    sessionArtifacts.push(...artifactsThisBaton);

    // 链终止条件 1：给出了回答
    if (baton.reply != null && baton.reply !== '') {
      finalReply = baton.reply;
      prevHandoff = unescapeText(baton.brief || prevHandoff);
      chainBatons[chainBatons.length - 1].handoffReason = 'reply';
      break;
    }

    prevHandoff = unescapeText(baton.brief || prevHandoff);

    // 链终止条件 2：任务级预算触顶 —— 停机并报告，不抛错
    if (seq >= maxBatons || costUsd >= maxCost) {
      status = 'budget_stopped';
      stoppedReason = costUsd >= maxCost && seq < maxBatons ? 'maxCost' : 'maxBatons';
      chainBatons[chainBatons.length - 1].handoffReason = 'budget';
      finalReply = buildChainReport({
        status, stoppedReason, batonsRun: seq, costUsd, maxBatons, maxCost,
        lastHandoff: prevHandoff, pendingInfos: infos,
      });
      break;
    }

    // 装配下一棒驱动输入（确认聚合 / 实际写入 / 信息返回；长输出已在执行时落基底）
    const { text } = buildDrivingInput({ acks, infos, writes });
    drivingInput = text;
    chainBatons[chainBatons.length - 1].handoffReason = infos.length ? 'info-return' : 'ack-aggregate';
  }

  return {
    status,
    stoppedReason,
    reply: finalReply,
    handoff: prevHandoff,
    batons: chainBatons,
    costUsd,
    artifacts: sessionArtifacts,
  };
}
