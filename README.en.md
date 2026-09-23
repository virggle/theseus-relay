# Theseus Relay

> Every message is answered by a brand-new agent. It has never read the history — it only reads the *Work Brief* left by the previous baton.

[中文](README.md) | **English**

The interface looks continuous, but behind the scenes every agent lives for exactly one turn: it reads one brief, takes one batch of actions, writes a new brief and leaves the stage. What it puts to the test is whether **stateless workers + a stateful protocol** can actually hold — which is the whole reason for trading "one long conversation" for a relay of batons.

Protocol spec: [docs/PROTOCOL.en.md](docs/PROTOCOL.en.md). Direction and ladders: [docs/ROADMAP.en.md](docs/ROADMAP.en.md). Acceptance scripts: [TESTS.md](TESTS.md).

## Current state

Both paths — conversation and tools — are wired up; `npm start` runs it:

- **One baton, one action**: it either emits a batch of mutually independent tool calls or gives an answer, never both. The criterion is static — does the next step depend on some call's return value; if yes, hand off, if no, emit the batch inside this baton. There is no "think → act → observe" loop inside a baton.
- **One message = one chain**: your message drives a whole chain of batons (tool returns drive new batons) until an answer is given or the task-level budget is hit. Caps: 24 batons / $0.5 per task; hitting the cap exits by wrapping up and emits a report, never throwing.
- **Tools**: `search_files` / `read_file` / `write_file`, scoped to the session workspace `data/workspace/<sid>/`. Path guarding lives in scripts — escaping paths are refused outright; every write books its own `write_target`.
- **Context stays bounded**: each baton's input = one brief + one driving input. Tool output over 1000 characters persists in full to `data/artifacts/<sid>/` and the baton sees only a summary plus a `->` pointer — so "bounded context" does not break on tool batons.
- **Brief, six sections**: Progress / Decisions / Constraints / User profile / Open questions / Side effects. Cumulative compression (not a this-turn recap), decisions and constraints append-only, placeholders banned, lossy budget of 800 characters (discard priority: progress detail < open questions < profile < decisions & constraints).
- **Mechanical validation**: five pure-function checks; failure means reject and re-dispatch once, and a second failure falls back to a summary and marks `rejected` — the validator is the commit condition of baton-level transactions.
- **Log lookup**: the full log is visible only to the user; agents don't read it by default and may retrieve on demand when truly necessary (max 2 lookups per baton).
- **Auditable handoffs**: the backstage panel shows, baton by baton, the brief, the exact input it read, the calls it emitted with their return classification (ack / info), the handoff reason (`reply` / `info-return` / `ack-aggregate` / `budget`), degradation and salvage markers, and a cost double-ledger (actual relay spend vs. a simulated monolith on the same conversation).

`npm test` — 98 checks green (node:test, zero dependencies).

## The two forms it grows into

The current state is the shared starting point of both lines. They use one and the same protocol; the only difference is "what one baton can do" versus "how a swarm of batons collaborates".

**Form one · single-chain: every baton becomes a replaceable worker.** A baton reads one brief, emits one batch of calls, writes one intent; real state and long evidence all live in the substrate (on disk), the brief degrades to pointers, and so "what may I drop when compressing" stops depending on on-the-spot judgment. Review falls to a baton that has **never seen the writing process** — no sunk cost, no ownership bias, a reviewer no single-agent architecture can build. Deterministic checks (tests / lint / build) come first, LLM review second. The endpoint: every step is traceable, any baton can be swapped for a different model, and the protocol guarantees the handoff loses nothing.

**Form two · task-board hive: let the task roll by itself.** Real state is a task-board document, each card carrying a `write_target`; batons advance in parallel along that board, disjointness of write targets is checked statically by the substrate, a review baton re-checks at the end of each stage, and anomalies and dispatch go to a middle decision layer (it judges finite options only and returns a probability distribution; anything a script can express is never delegated to it). Endgame: a self-sustaining swarm — seed one goal and it runs to done; one kind of baton produces no deliverable and only optimizes the allocation rules and the structure of the task board / documents, bound by three guardrails (protocol invariants and the validator are not directly editable, every improvement proposal must carry before/after metrics, hard quota cap), with KPIs taken straight from the cost ledger and the decay metrics.

Design discipline: ① any new feature must serve at least two value tracks, or it doesn't ship — the six tracks and their proof metrics are in [docs/ROADMAP.en.md](docs/ROADMAP.en.md) §1; ② hive metaphors stay in the interface and the docs and never enter a prompt — what passes between agents is always a plain brief.

## Boundaries against kindred architectures

They all attack the same thing — long conversations getting more expensive, dumber and more forgetful as context fills up. They differ in memory carrier and driving signal:

| | Theseus Relay | Ralph Loop | Monolithic long context / compaction |
|---|---|---|---|
| Driving signal | Any input event = a handoff (user messages and tool returns alike) | The same PROMPT.md re-run until done | Context approaching the cap (passive trigger) |
| Memory carrier | Brief (a linguistic compression, lossy, quality guaranteed by protocol) | Disk (git / plan.md / code, lossless) | In-session summary (implicit, no quality guarantee) |
| Information loss | Explicit: lossy budget + discard priority | Implicit: disk assumed lossless | Implicit: compaction as a side effect |
| Fault isolation | Baton-level (a failed baton never existed) | Iteration-level (start over + git rollback) | None |
| Quality assurance | Mechanical validator + deterministic quality gates + review batons | backpressure (tests / gates) | None |
| Reviewer | Structurally unbiased (never saw the writing process) | No independent reviewer | None |

What was borrowed from Ralph is **where discipline is placed**: rules in the harness rather than the prompt, state on disk rather than in the model, every failure mode observable. The one remaining divergence — whether state lands on disk or in a linguistic compression — also converged once substratization landed.

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
src/task.js        single-chain runner: one user message drives the whole chain, task-level budget and wrap-up
src/relay.js       the baton engine: brief construction, log retrieval, JSON protocol parsing with salvage fallback
src/returns.js     return classification (ack / info) and acknowledgement aggregation
src/tools.js       minimal tool set (search_files / read_file / write_file) + path guarding
src/validate.js    substrate validator: five mechanical checks; fail means reject and re-dispatch
src/briefchain.js  brief-chain export and cross-session import (v0.1.3): Decisions + User profile only, not one log line
src/retention.js   decay probe (v0.1.4): a recall spot-check every 10 batons, mechanically scored, three-way attribution, spend booked separately
src/pricing.js     model pricing and the cost double-ledger: relay actual vs. simulated monolith
src/llmAdapter.js  OpenAI-compatible adapter (retry + timeout)
public/index.html  chat UI + backstage relay panel
TESTS.md           protocol conformance test suite (behavior probes + four-step scoring scripts + automation)
benchmark.html     companion quiz (for humans; 10 questions, auto-graded)
```

## Protocol traps learned from real runs (see PROTOCOL.en.md §6, §8)

- Models write the brief as a "this-turn recap" → the protocol must emphasize cumulative compression
- Models cheat with placeholders like "(previous conclusions retained)" → must be banned at protocol level
- reply and brief share one JSON, so long answers hit the token ceiling → a truncation salvager is required
- Under token pressure models learn to procrastinate ("I'll get to that later") → anti-procrastination clauses are required

## Documentation policy

Four documents (`README` / `docs/PROTOCOL` / `docs/ROADMAP` / `TESTS`) live in the repo; the first three are maintained in both languages and **must be updated in sync**: every content change lands in the Chinese version and the English version in the same commit. `TESTS.md` is Chinese-only for now. Section anchors (`§`) are part of the contract — renumbering requires updating every reference.

## License

MIT
