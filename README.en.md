# Theseus Relay

> Every message is answered by a brand-new agent. It has never read the history — it only reads the *Work Brief* left by the previous baton.

[中文](README.md) | **English**

A chat application that turns the "Ship of Theseus" architecture into a playable experience: the conversation looks continuous, but behind the scenes each agent lives for exactly one turn — it answers, leaves behind a structured brief, and exits. The next baton enters with that brief plus your latest message.

**The point is not the chat. The point is the protocol.** Stateless workers + a stateful protocol deliver six value tracks at once — bounded cost, fresh context, audits by construction, baton-level transactions, cross-model scheduling, cross-session memory — the seeds of a harness. See [docs/PURPOSES.en.md](docs/PURPOSES.en.md) (the six value tracks and their proof metrics), [docs/PROTOCOL.en.md](docs/PROTOCOL.en.md) (the relay protocol spec), [docs/ROADMAP.en.md](docs/ROADMAP.en.md) (the chatbox → harness evolution path), and [docs/POSITIONING.en.md](docs/POSITIONING.en.md) (boundaries against Ralph Loop and other kindred architectures).

## What it demonstrates

- **Six parallel value tracks**: six readings of one protocol — P1 cost, P2 stability, P3 audit, P4 transactions, P5 scheduling, P6 persistence (see [docs/PURPOSES.en.md](docs/PURPOSES.en.md))
- **Bounded context**: each agent's input is constant = one brief + one message; token cost does not grow with conversation length — the mechanical basis of track P1
- **The brief protocol**: cumulative compression (not a per-turn recap), an append-only decision ledger, placeholders strictly forbidden, a lossy budget with discard priorities
- **Logs as external memory**: the full conversation log is visible only to the user; agents don't read it by default and may consult it via bounded retrieval when truly necessary (max 2 lookups per baton)
- **Auditable handoffs**: the backstage panel shows each baton's brief, its complete input, its log-lookup behavior, and any degradation or salvage markers

## Running

Zero dependencies, Node ≥ 18:

```bash
npm start          # http://localhost:3000
```

### Configuring an LLM (BYOK)

Option 1: fill in any OpenAI-compatible endpoint (DeepSeek / OpenAI / OpenRouter / Ollama…) in the web "Settings". The key is stored locally in your browser.

Option 2: host-provided channel — put a `.env` in the project root (see `.env.example`), and visitors can try it with zero setup.

### Local development without a key

```bash
npm run mock       # starts a mock LLM on :5051
LLM_BASE_URL=http://localhost:5051 LLM_API_KEY=mock LLM_MODEL=mock npm start
```

## Architecture

```
server.js          zero-dependency HTTP server (session storage + API)
src/validate.js    substrate validator (v0.1.1): five mechanical checks; fail means reject and re-dispatch
src/relay.js       the relay engine: brief construction, log retrieval, JSON protocol parsing with salvage fallback
src/llmAdapter.js  OpenAI-compatible adapter (retry + timeout)
public/index.html  chat UI + backstage relay panel
TESTS.md           protocol conformance test suite (behavior probes + four-step scoring scripts)
benchmark.html     companion quiz (for humans; 10 questions, auto-graded)
```

## Protocol traps learned from real runs (see PROTOCOL.en.md §6, §8)

- Models write the brief as a "this-turn recap" → the protocol must emphasize cumulative compression
- Models cheat with placeholders like "(previous conclusions retained)" → must be banned at protocol level
- reply and brief share one JSON, so long answers hit the token ceiling → a truncation salvager is required
- Under token pressure models learn to procrastinate ("I'll get to that later") → anti-procrastination clauses are required

## Documentation policy

Docs are maintained bilingually and **must be updated in sync**: every content change lands in both the Chinese original (`*.md`) and the English version (`*.en.md`) in the same commit. Section anchors (`§`) are part of the contract — renumbering requires updating every reference.

## License

MIT
