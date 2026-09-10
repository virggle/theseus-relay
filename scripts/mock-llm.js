// 本地 mock LLM：实现 /chat/completions，用于无 key 端到端联调。
// 行为：如果消息里出现"翻日志结果"，直接给正常 JSON 回复；否则按序号先要求翻日志（第 2 轮起偶发）。
//
// 校验器联调：设 MOCK_BAD_BRIEF=<mode> 让首轮故意交坏简报，验证「拒收 → 重派 → 兜底」链路。
//   mode: placeholder | missing | budget | shrink | pointer
//   被拒收后（消息含 [系统·简报校验未通过]）自动改交好简报，用于观察重派成功率。
import http from 'node:http';

let turnCount = 0;

const REJECT_MARK = '[系统·简报校验未通过]';

const GOOD_BRIEF = '## 进展\nmock 交接，链路正常\n## 决策\n1. 先验证再落盘\n2. 决策只增不删\n## 用户画像\n测试用户，偏好简短\n## 开放问题\n无';

function badBrief(mode) {
  switch (mode) {
    case 'placeholder':
      return '## 进展\nmock 交接\n## 决策\n（保留全部旧结论）\n## 用户画像\n测试用户\n## 开放问题\n无';
    case 'missing':
      return '## 进展\nmock 交接，故意缺节\n## 用户画像\n测试用户\n## 开放问题\n无';
    case 'budget':
      return '## 进展\n' + '这是一段很长的填充内容用于突破八百字预算上限'.repeat(40) + '\n## 决策\n1. 无\n## 用户画像\n测试用户\n## 开放问题\n无';
    case 'shrink':
      return '## 进展\nmock 交接\n## 决策\n## 用户画像\n测试用户\n## 开放问题\n无';
    case 'pointer':
      return '## 进展\nmock 交接\n## 决策\n1. 无\n## 用户画像\n测试用户\n## 开放问题\n见 -> docs/NOPE-404.md';
    default:
      return GOOD_BRIEF;
  }
}

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

    let content;
    if (rejected) {
      // 被基底拒收后默认改交好简报；MOCK_ALWAYS_BAD=1 时继续交坏简报，用于验证「重派仍不过 → 兜底」分支
      content = JSON.stringify({
        reply: `（mock 重派后）已收到校验错误。`,
        handoff: process.env.MOCK_ALWAYS_BAD ? badBrief(badMode || 'placeholder') : GOOD_BRIEF,
      });
    } else if (last.startsWith('[系统·翻日志结果]')) {
      content = JSON.stringify({
        reply: `（mock 第${turnCount}次）我翻了日志，现在回答你。`,
        handoff: badMode ? badBrief(badMode) : GOOD_BRIEF,
      });
    } else if (turnCount % 3 === 0) {
      // 每三棒模拟一次"需要翻日志"
      content = JSON.stringify({ action: 'read_log', query: '最开始' });
    } else {
      const m = sys.match(/第(\d+)棒 Agent/);
      const n = m ? m[1] : '?';
      content = JSON.stringify({
        reply: `（mock 第${n}棒）收到你的消息：「${last.slice(0, 30)}」。我只读了交接和这句话，历史我什么都不知道。`,
        handoff: badMode ? badBrief(badMode) : `## 进展\n用户说了「${last.slice(0, 20)}」\n## 决策\n1. 沿用上一棒结论\n## 用户画像\n待观察\n## 开放问题\n无`,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

server.listen(5051, () => console.log('mock LLM on :5051' + (process.env.MOCK_BAD_BRIEF ? ` (MOCK_BAD_BRIEF=${process.env.MOCK_BAD_BRIEF})` : '')));
