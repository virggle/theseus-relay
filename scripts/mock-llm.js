// 本地 mock LLM：实现 /chat/completions，用于无 key 端到端联调。
// 行为：如果消息里出现"翻日志结果"，直接给正常 JSON 回复；否则按序号先要求翻日志（第 2 轮起偶发）。
import http from 'node:http';

let turnCount = 0;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { messages } = JSON.parse(body || '{}');
    const sys = messages[0]?.content || '';
    const last = messages[messages.length - 1]?.content || '';
    turnCount++;

    let content;
    if (last.startsWith('[系统·翻日志结果]')) {
      content = JSON.stringify({
        reply: `（mock 第${turnCount}次）我翻了日志，现在回答你。`,
        handoff: '## 进展\nmock 交接\n## 决策\n无\n## 用户画像与偏好\n测试用户\n## 开放问题\n无',
      });
    } else if (turnCount % 3 === 0) {
      // 每三棒模拟一次"需要翻日志"
      content = JSON.stringify({ action: 'read_log', query: '最开始' });
    } else {
      const m = sys.match(/第(\d+)棒 Agent/);
      const n = m ? m[1] : '?';
      content = JSON.stringify({
        reply: `（mock 第${n}棒）收到你的消息：「${last.slice(0, 30)}」。我只读了交接和这句话，历史我什么都不知道。`,
        handoff: `## 进展\n用户说了「${last.slice(0, 20)}」\n## 决策\n无\n## 用户画像与偏好\n待观察\n## 开放问题\n无`,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

server.listen(5051, () => console.log('mock LLM on :5051'));
