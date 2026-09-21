// 本地 mock LLM：实现 /chat/completions，用于无 key 端到端联调。
// 行为：如果消息里出现"翻日志结果"，直接给正常 JSON 回复；否则按序号先要求翻日志（第 2 轮起偶发）。
//
// 校验器联调：设 MOCK_BAD_BRIEF=<mode> 让首轮故意交坏简报，验证「拒收 → 重派 → 兜底」链路。
//   mode: placeholder | missing | budget | shrink | pointer
//   被拒收后（消息含 [系统·简报校验未通过]）自动改交好简报，用于观察重派成功率。
//
// 单链步进联调（H0）：设 MOCK_CHAIN=1，mock 走一条完整工具链：
//   第 1 棒发 calls（write_file + search_files）→ 收到确认聚合 + 信息返回
//   第 2 棒再发 calls（read_file，信息型）→ 收到信息返回
//   第 3 棒给出 reply，链终止 —— 面板上可看到全部四类交接原因中的三类。
import http from 'node:http';

let turnCount = 0;

const REJECT_MARK = '[系统·简报校验未通过]';

const GOOD_BRIEF = '## 进展\nmock 交接，链路正常\n## 决策\n1. 先验证再落盘\n2. 决策只增不删\n## 用户画像\n测试用户，偏好简短\n## 开放问题\n无\n## 副作用\n无';

function badBrief(mode) {
  switch (mode) {
    case 'placeholder':
      return '## 进展\nmock 交接\n## 决策\n（保留全部旧结论）\n## 用户画像\n测试用户\n## 开放问题\n无\n## 副作用\n无';
    case 'missing':
      return '## 进展\nmock 交接，故意缺节\n## 用户画像\n测试用户\n## 开放问题\n无\n## 副作用\n无';
    case 'budget':
      return '## 进展\n' + '这是一段很长的填充内容用于突破八百字预算上限'.repeat(40) + '\n## 决策\n1. 无\n## 用户画像\n测试用户\n## 开放问题\n无\n## 副作用\n无';
    case 'shrink':
      return '## 进展\nmock 交接\n## 决策\n## 用户画像\n测试用户\n## 开放问题\n无\n## 副作用\n无';
    case 'pointer':
      return '## 进展\nmock 交接\n## 决策\n1. 无\n## 用户画像\n测试用户\n## 开放问题\n见 -> docs/NOPE-404.md\n## 副作用\n无';
    default:
      return GOOD_BRIEF;
  }
}

const briefOf = () => (process.env.MOCK_BAD_BRIEF ? badBrief(process.env.MOCK_BAD_BRIEF) : GOOD_BRIEF);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { messages } = JSON.parse(body || '{}');
    const sys = messages[0]?.content || '';
    const last = messages[messages.length - 1]?.content || '';
    turnCount++;

    const badMode = process.env.MOCK_BAD_BRIEF;
    const rejected = last.startsWith(REJECT_MARK);
    const chainMode = !!process.env.MOCK_CHAIN;
    // 驱动输入是「确认聚合 + 实际写入 + 信息返回」的拼装体，用 includes 判定到了链条哪一步
    const hasAckReturn = last.includes('[系统·确认聚合]') || last.includes('[系统·实际写入]');
    const hasInfoReturn = last.includes('[系统·信息返回]');

    let content;
    if (rejected) {
      // 被基底拒收后默认改交好简报；MOCK_ALWAYS_BAD=1 时继续交坏简报，用于验证「重派仍不过 → 兜底」分支
      content = JSON.stringify({
        reply: `（mock 重派后）已收到校验错误。`,
        handoff: process.env.MOCK_ALWAYS_BAD ? badBrief(badMode || 'placeholder') : GOOD_BRIEF,
      });
    } else if (chainMode && hasInfoReturn && !hasAckReturn) {
      // 链上第 3 棒：只有信息返回（read_file 的结果），给出回答，链终止
      content = JSON.stringify({
        reply: `（mock 链完成）写入与读取都已确认：hello.txt 已落工作区，任务收尾。`,
        handoff: briefOf(),
      });
    } else if (chainMode && hasAckReturn) {
      // 链上第 2 棒：确认聚合已回来，再发一次信息型调用（read_file），验证「信息型触发换棒」
      content = JSON.stringify({
        calls: [{ tool: 'read_file', args: { path: 'hello.txt' } }],
        handoff: briefOf(),
      });
    } else if (chainMode) {
      // 链上第 1 棒：一批互不依赖的调用（写 + 搜），一次发完 —— 确认型 + 信息型混合
      // MOCK_PATTERN 可指向预置大文件的关键词，用于验证「长输出落基底」路径
      const pattern = process.env.MOCK_PATTERN || 'hello';
      content = JSON.stringify({
        calls: [
          { tool: 'write_file', args: { path: 'hello.txt', content: 'hello from mock chain\n第二次搜索命中行' } },
          { tool: 'search_files', args: { dir: '.', pattern } },
        ],
        handoff: briefOf(),
      });
    } else if (sys.includes('【跨会话导入】')) {
      // v0.1.3 跨会话导入联调：把导入简报里的「决策」「用户画像」原样回显——
      // 证明上一会话的决策真的通过简报到达了模型，而不是停在导出文件里。
      // 回写的 handoff 条目数与导入简报一致，否则会撞上「决策只增不删」的拒收重派。
      const lastSection = (title) => {
        const seg = sys.split('## ' + title).pop() || '';
        return seg.split(/\n##\s/)[0].trim();
      };
      const decisions = lastSection('决策');
      const profile = lastSection('用户画像');
      content = JSON.stringify({
        reply: `（mock 跨会话回显）我读到的上一会话决策是：\n${decisions}`,
        handoff:
          `## 进展\nmock 跨会话导入联调：本棒读到导入简报，决策与画像条目原样保留。\n` +
          `## 决策\n${decisions}\n## 用户画像\n${profile}\n## 开放问题\n无\n## 副作用\n无`,
      });
    } else if (last.startsWith('[系统·翻日志结果]')) {
      content = JSON.stringify({
        reply: `（mock 第${turnCount}次）我翻了日志，现在回答你。`,
        handoff: briefOf(),
      });
    } else if (turnCount % 3 === 0) {
      // 每三棒模拟一次"需要翻日志"
      content = JSON.stringify({ action: 'read_log', query: '最开始' });
    } else {
      const m = sys.match(/第(\d+)棒/);
      const n = m ? m[1] : '?';
      content = JSON.stringify({
        reply: `（mock 第${n}棒）收到你的消息：「${last.slice(0, 30)}」。我只读了交接和这句话，历史我什么都不知道。`,
        handoff: briefOf(),
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 带上 usage，让遥测/成本面板在无 key 联调时也有真实 token 数可看
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 220, completion_tokens: 90 },
    }));
  });
});

server.listen(5051, () => {
  const tags = [];
  if (process.env.MOCK_BAD_BRIEF) tags.push(`MOCK_BAD_BRIEF=${process.env.MOCK_BAD_BRIEF}`);
  if (process.env.MOCK_CHAIN) tags.push('MOCK_CHAIN=1');
  console.log('mock LLM on :5051' + (tags.length ? ` (${tags.join(', ')})` : ''));
});
