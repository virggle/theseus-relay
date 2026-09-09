# Evolution Path · From Chatbox to Harness

[中文](ROADMAP.md) | **English**

> The final form of Theseus Relay is not a chat box but a **relay runtime**: stateless workers take batons under a protocol and complete long-horizon tasks on a stateful substrate. This document is the ladder — each rung stops at "minimally runnable".

## v0.1 Conversation relay (current, implemented)

- Structured brief + cumulative compression + anti-placeholder
- Log lookup (log-as-memory, bounded retrieval)
- JSON protocol + truncation salvage + anti-procrastination
- Backstage live view: every baton's input/output/retrieval fully auditable

**Verified properties**: bounded context (constant cost), baton-level fault isolation, identity continuity guaranteed by protocol.

## v0.1.1 Substrate validator (next minimal increment)

Move the five mechanical checks of PROTOCOL §4 from paper into code: four sections present, no placeholders, within budget, decisions append-only, pointers valid. Fail → reject and re-dispatch (§6).

Why it comes before tool batons: **the field-tested traps — anti-placeholder, anti-procrastination — are currently enforced purely by prompt constraints (model self-discipline)**. The validator is the first "substrate is more reliable than the model" component: dirt cheap (pure regex + diff), yet it turns brief quality from a probability problem into a determinism problem — baton-level transactions, quality gates, and protocol independence all build on its existence.

## v0.2 Tool batons

- The ACT phase may attach tools (file read/write, command execution, search)
- New fifth brief section: the **side-effect ledger** — every irreversible operation this baton performed, item by item; the next baton must know "what has already been changed in the world" before taking over
- Tool permissions granted per baton (read/write separation, allowlist for dangerous operations)
- **Deterministic quality gates (backpressure)**: output passes tests / lint / build first — zero tokens, zero bias, run every time; on failure, re-dispatch immediately, do not escalate to a review baton
- **Budget and oscillation detection**: baton-count cap, per-task cost cap; decision oscillation (a rejected option re-proposed) is detected by the substrate diffing the decision ledger, with an alert (PROTOCOL §6)

Key design: **the evidence of tool calls lands in the substrate; the intent of tool calls goes into the brief.** The worker is stateless, but the world has state.

## v0.3 Substratization

- The brief degrades from prose to pointers: state-file paths, task-list IDs, SSOT document locations
- All real state lives on disk; the brief records only "pointers + why + next step"
- **The persistence rule is the compression rule** (PROTOCOL §3 Invariant 4): persisted → the brief keeps a pointer, disposable at any time; not persisted → the only copy, never dropped. No on-the-spot judgment during compression
- **Memory layering**: project memory lives in each project's own folder (SSOT documents); knowledge reusable across projects is distilled into skills loaded on demand — projects stay naturally isolated and don't consume brief budget
- The brief's length cap drops accordingly (e.g. 400 characters) — the thinner, the more stable, the cheaper to rebuild

Passing criterion: when swapping the model on a baton makes no difference to output quality, this rung is done.

## v0.4 Review batons and baton-level transactions

- Execution batons / review batons alternate: execution produces; review re-checks carrying only the brief + a list of artifacts
- The review baton's structural advantage: **it genuinely never saw the writing process** — no sunk cost, no ownership bias. This is a reviewer no single-agent architecture can build
- **Division of labor**: anything the deterministic quality gates (v0.2) can catch never reaches a review baton — LLM review only handles semantic questions: naming, design coherence, "is it what was asked for". Cheap deterministic checks first, expensive probabilistic review second
- Baton-level transactions: review fails → roll back to the previous brief and re-dispatch; the failed baton leaves no trace

## v0.5 Protocol independence

- Versioned brief schema (`brief_schema: 1`), validatable and migratable
- Baton implementations and substrate implementations decouple: any runner (CLI, service, another harness) that implements the same protocol can interoperate
- Endgame: **cross-model relay** as a cost-scheduling lever — chore batons on cheap models, critical batons on strong ones, with the protocol guaranteeing lossless handoffs

## What we will not do

- No vector database: the retrieval need is "find that one thing someone said" — n-gram suffices; leave the complexity to the substrate
- No parallel batons: relay is serial by semantics; parallelism belongs to another protocol
- No streaming output: emitting the complete JSON in one shot is the precondition for the salvager to work; we'd rather wait
- No behavioral constraints at the prompt layer (when the substrate validator can express them): rules live in the harness, not the prompt — models cheat, scripts don't
