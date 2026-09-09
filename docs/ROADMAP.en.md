# Evolution Path · From Chatbox to Harness

[中文](ROADMAP.md) | **English**

> The final form of Theseus Relay is not a chat box but a **relay runtime**: stateless workers take batons under a protocol and complete long-horizon tasks on a stateful substrate. This document is the ladder — each rung stops at "minimally runnable", and is annotated with the value tracks it serves (P1–P6, defined in [PURPOSES.en.md](PURPOSES.en.md)).

## v0.1 Conversation relay (current, implemented)

> Tracks served: P1 Cost (bounded input) · P3 Audit (live panel) · P4 Transactions (baton-level fault isolation)

- Structured brief + cumulative compression + anti-placeholder
- Log lookup (log-as-memory, bounded retrieval)
- JSON protocol + truncation salvage + anti-procrastination
- Backstage live view: every baton's input/output/retrieval fully auditable

**Verified properties**: bounded context (constant cost), baton-level fault isolation, identity continuity guaranteed by protocol.

## v0.1.1 Substrate validator (next minimal increment)

> Tracks served: P4 Transactions · P3 Audit

Move the five mechanical checks of PROTOCOL §4 from paper into code: four sections present, no placeholders, within budget, decisions append-only, pointers valid. Fail → reject and re-dispatch (§6).

Why it comes before tool batons: **the field-tested traps — anti-placeholder, anti-procrastination — are currently enforced purely by prompt constraints (model self-discipline)**. The validator is the first "substrate is more reliable than the model" component: dirt cheap (pure regex + diff), yet it turns brief quality from a probability problem into a determinism problem — baton-level transactions, quality gates, and protocol independence all build on its existence.

> **v0.1.2–v0.1.7 form the measurement & multi-purpose layer**: no hard dependency on v0.2 tool batons — they can interleave. Each stops independently at "minimally runnable". The only ordering constraint: v0.1.5's L0 pointer form depends on v0.3's persistence rules; until then L0 degrades to a hard-compression tier.

## v0.1.2 Telemetry and the cost double-ledger

> Tracks served: P1 Cost · P3 Audit

- Per-baton telemetry persisted to session storage: input/output tokens, latency, model, log-lookup count, salvage/rejected events
- The panel gains a **cost double-ledger**: two cumulative curves per session — actual relay cost vs. simulated monolithic cost (current model pricing × full-history re-read, including prefix-cache read prices)
- Why it matters: P1 stops being an argument and becomes a live number on the panel. Short-session losses and long-session wins both shown as-is — losing honestly is where this track's credibility comes from

Passing criterion: the panel can answer, in real time, "what would this session have cost monolithically by now".

## v0.1.3 Cross-session bootstrap

> Tracks served: P6 Persistence · P5 Scheduling

- A new session can import the Decision + User Profile sections of a previous session's final brief as its initial brief
- The panel supports exporting the full brief chain as JSON — human-readable, model-agnostic
- Why it matters: the brief chain graduates from an in-session artifact to a cross-session memory carrier. Beyond schema versioning (v0.5), this is the minimal experiment that proves briefs are portable

Passing criterion: after closing the browser and bootstrapping a new session from the exported chain, the model answers the previous session's settled decisions correctly.

## v0.1.4 Decay probe

> Tracks served: P2 Stability · P6 Persistence

- Every 10 batons, run an automatic recall spot-check: sample 5 factual questions from the substrate log, answer via an independent call, compare against the originals, emit `retention_rate`
- Why it matters: turns the honest list's "long-horizon decay is unmeasured" (PROTOCOL §8) into an observable metric; it also doubles as the trigger sensor for L2 packing (v0.1.5) — when retention_rate drops below threshold, the next baton auto-upgrades its tier

Passing criterion: retention_rate is a permanent panel metric and can distinguish two failure modes — "the brief never recorded it" vs. "the model didn't use it".

## v0.1.5 Brief bandwidth tiers

> Tracks served: P1 Cost · P2 Stability · P5 Scheduling

- Briefs come in three tiers: **L0** = 400-character pointer brief (small models / chore batons); **L1** = 800-character full brief (current default); **L2** = brief + substrate log excerpt pack (quality mode for large-context models)
- The substrate assembles each baton's input according to the next model's declared context budget; log lookup upgrades from "2 probes per baton" to "packing to budget"
- L0's pointer form depends on v0.3's persistence rules (persisted → disposable at any time); until then L0 degrades to a hard-compression tier
- Why it matters: model capability differences stop being a threat and become a scheduling dimension — one protocol, multiple bandwidths, assigned per recipient

Passing criterion: within one session, different batons receive different tiers per routing rules, with no perceptible quality difference.

## v0.1.6 Dual-track benchmark

> Tracks served: P2 Stability · P1 Cost

- benchmark.html gains a **protocol benchmark mode**: the same questions run on two tracks — (a) relay chain, (b) monolithic long context — inserted at turns 30/60/90, auto-scored into curves
- Why it matters: P2's core evidence generator. Once "the fresh-context quality advantage at turn N" is quantified, it is a differentiator monolithic architectures cannot offer; the same runs yield same-scenario cost deltas that feed P1's double-ledger

Passing criterion: one click produces the dual-track quality-vs-turn curve.

## v0.1.7 Model routing table (toy)

> Tracks served: P5 Scheduling · P1 Cost

- The settings page allows rules such as "batons with tool calls use model X, pure-chat batons use model Y"; the panel shows which model each baton actually used
- Why it matters: a rehearsal for v0.5 cross-model relay — first prove in the chat scenario that "swapping models per baton is quality-neutral" (the precondition experiment for v0.3's passing criterion), then talk cost scheduling

Passing criterion: a 50-baton session runs with two models mixed per rules, fully annotated on the panel.

## v0.2 Tool batons

> Tracks served: P4 Transactions (side-effect ledger) · P1 Cost (budget and oscillation detection)

- The ACT phase may attach tools (file read/write, command execution, search)
- New fifth brief section: the **side-effect ledger** — every irreversible operation this baton performed, item by item; the next baton must know "what has already been changed in the world" before taking over
- Tool permissions granted per baton (read/write separation, allowlist for dangerous operations)
- **Deterministic quality gates (backpressure)**: output passes tests / lint / build first — zero tokens, zero bias, run every time; on failure, re-dispatch immediately, do not escalate to a review baton
- **Budget and oscillation detection**: baton-count cap, per-task cost cap; decision oscillation (a rejected option re-proposed) is detected by the substrate diffing the decision ledger, with an alert (PROTOCOL §6)

Key design: **the evidence of tool calls lands in the substrate; the intent of tool calls goes into the brief.** The worker is stateless, but the world has state.

## v0.3 Substratization

> Tracks served: P1 Cost (thinner briefs) · P6 Persistence (real state on disk, memory layering)

- The brief degrades from prose to pointers: state-file paths, task-list IDs, SSOT document locations
- All real state lives on disk; the brief records only "pointers + why + next step"
- **The persistence rule is the compression rule** (PROTOCOL §3 Invariant 4): persisted → the brief keeps a pointer, disposable at any time; not persisted → the only copy, never dropped. No on-the-spot judgment during compression
- **Memory layering**: project memory lives in each project's own folder (SSOT documents); knowledge reusable across projects is distilled into skills loaded on demand — projects stay naturally isolated and don't consume brief budget
- The brief's length cap drops accordingly (e.g. 400 characters) — the thinner, the more stable, the cheaper to rebuild

Passing criterion: when swapping the model on a baton makes no difference to output quality, this rung is done.

## v0.4 Review batons and baton-level transactions

> Tracks served: P4 Transactions (baton-level transactions) · P2 Stability (structurally unbiased review)

- Execution batons / review batons alternate: execution produces; review re-checks carrying only the brief + a list of artifacts
- The review baton's structural advantage: **it genuinely never saw the writing process** — no sunk cost, no ownership bias. This is a reviewer no single-agent architecture can build
- **Division of labor**: anything the deterministic quality gates (v0.2) can catch never reaches a review baton — LLM review only handles semantic questions: naming, design coherence, "is it what was asked for". Cheap deterministic checks first, expensive probabilistic review second
- Baton-level transactions: review fails → roll back to the previous brief and re-dispatch; the failed baton leaves no trace

## v0.5 Protocol independence

> Tracks served: P5 Scheduling (cross-model relay) · P6 Persistence (portable schema)

- Versioned brief schema (`brief_schema: 1`), validatable and migratable
- Baton implementations and substrate implementations decouple: any runner (CLI, service, another harness) that implements the same protocol can interoperate
- Endgame: **cross-model relay** as a cost-scheduling lever — chore batons on cheap models, critical batons on strong ones, with the protocol guaranteeing lossless handoffs

## What we will not do

- No vector database: the retrieval need is "find that one thing someone said" — n-gram suffices; leave the complexity to the substrate
- No parallel batons: relay is serial by semantics; parallelism belongs to another protocol
- No streaming output: emitting the complete JSON in one shot is the precondition for the salvager to work; we'd rather wait
- No behavioral constraints at the prompt layer (when the substrate validator can express them): rules live in the harness, not the prompt — models cheat, scripts don't
- No special-case code for a single track: any new feature must serve ≥2 tracks (PURPOSES §9); single-track requests go to the backlog freezer
