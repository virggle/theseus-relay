# 忒修斯号 · Theseus Relay

> 每一句对话，都由一个全新的 Agent 接棒。它没读过历史——它只读上一棒留下的《工作简报》。

**中文** | [English](README.en.md)

一个把「忒修斯之船」架构做成可玩体验的聊天应用：对话界面看起来是连续的，但后台每个 Agent 只活一轮，回答完留下结构化简报就离场，下一棒带着简报 + 你的最新消息上场。

**它的意义不在聊天，而在协议。** 无状态工人 + 有状态协议，同时兑现六条价值轨道——成本有界、新鲜上下文、天然审计、棒级事务、跨模型调度、跨会话记忆——这些是长成 harness 的种子。见 [docs/PURPOSES.md](docs/PURPOSES.md)（六条价值轨道与证明指标）、[docs/PROTOCOL.md](docs/PROTOCOL.md)（接力协议规范）、[docs/ROADMAP.md](docs/ROADMAP.md)（chatbox → harness 演进路线）与 [docs/POSITIONING.md](docs/POSITIONING.md)（与 Ralph Loop 等近亲架构的边界）。

## 它演示什么

- **六条并行价值轨道**：同一份协议的六种读法——P1 成本、P2 稳定性、P3 审计、P4 事务、P5 调度、P6 持久化（见 [docs/PURPOSES.md](docs/PURPOSES.md)）
- **有界上下文**：每个 Agent 的输入恒定 = 一份简报 + 一条消息，token 成本不随对话长度增长——P1 轨道的机制基础
- **简报协议**：累积压缩（不是本轮纪要）、决策账本只增不删、严禁占位符、有损预算与丢弃优先级
- **日志即外部记忆**：完整对话 log 只对用户可见；Agent 默认不读，确有必要时用「翻日志」按需检索（每棒限 2 次）
- **可审计换棒**：后台面板展示每一棒的简报、它读到的完整输入、翻日志行为、降级与抢救标记

## 运行

零依赖，Node ≥ 18：

```bash
npm start          # http://localhost:3000
```

### 配置 LLM（BYOK）

方式一：网页「设置」里填任意 OpenAI 兼容端点（DeepSeek / OpenAI / OpenRouter / Ollama…），Key 存浏览器本地。

方式二：站长内置通道——项目根放 `.env`（参考 `.env.example`），访问者无需配置即可体验。

### 本地联调（无 key）

```bash
npm run mock       # :5051 起一个 mock LLM
LLM_BASE_URL=http://localhost:5051 LLM_API_KEY=mock LLM_MODEL=mock npm start
```

## 架构

```
server.js          零依赖 HTTP 服务器（会话存储 + API）
src/relay.js       接力引擎：简报构建、翻日志检索、JSON 协议解析与抢救兜底
src/llmAdapter.js  OpenAI 兼容适配层（重试 + 超时）
public/index.html  聊天界面 + 后台接力实况面板
TESTS.md           协议一致性测试集（行为探针 + 真题四步脚本）
benchmark.html     配套智力测试（给人玩的，10 题自动判分）
```

## 实测沉淀的协议陷阱（详见 PROTOCOL.md §6、§8）

- 模型会把简报写成"本轮纪要"→ 协议必须强调累积压缩
- 模型会用「（保留旧结论）」占位符作弊 → 必须协议级禁止
- reply + 简报同在一个 JSON，长回答必撞 token 上限 → 需要截断抢救器
- token 压力下模型学会"稍后给你"式拖延 → 需要反拖延条款

## 文档维护规则

文档中英双语维护，**同步修改**：任何内容变更必须在同一提交内同时落到中文版（`*.md`）与英文版（`*.en.md`）。章节锚点（`§`）属于契约的一部分——重编号必须同步更新所有引用处。

## License

MIT
