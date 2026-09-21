# Direction · Two Ladders

[中文](ROADMAP.md) | **English**

> The final form of Theseus Relay is not a chat box but a **relay runtime**: stateless workers take batons under a protocol and complete long-horizon tasks on a stateful substrate. This document answers two questions — which value tracks the protocol serves at once (§1), and which rungs it grows through (§2 single chain, §3 hive). The two ladders are two maturity axes of the same protocol: **ladder one asks "what can one baton do", ladder two asks "how does a swarm of batons collaborate"**. The README describes the end-state form of each axis; the concrete path is here. Every rung stops at "minimally runnable".

## 1. The six value tracks

> Six readings of a single protocol — the brief is at once a cost control, an audit artifact, a transaction log and a memory carrier.

| Track | Claim in one line | Proof metric | Current state |
|---|---|---|---|
| **P1 Cost** | Input cost per long session stays bounded; the longer the history, the bigger the edge | cost double-ledger | Partly holds: long sessions win, short ones lose |
| **P2 Stability** | Fresh context: turn 1 and turn N are the same quality | retention_rate + dual-track benchmark | Hypothesis, unproven |
| **P3 Audit** | Every handoff is a human-readable, reviewable artifact | live panel + per-baton telemetry | Implemented, telemetry being completed |
| **P4 Transactions** | A failed baton never existed; decisions append-only | validator rejections and rollback events | Validator landed, baton-level transactions pending |
| **P5 Scheduling** | Each baton picks its own model; cost/capability matched on demand | routing table → cross-model relay | Long-range; a toy rehearsal exists |
| **P6 Persistence** | The brief chain = cross-session personal memory | decision/profile retention after a cross-session import | Embryonic; the entry point is unbuilt |

The track IDs are citation symbols: every rung below is annotated with the tracks it serves.

**Design discipline** (three rules, applying to every entry in this document):

1. Any new feature must serve ≥2 tracks, or it does not ship
2. Every track's proof metric must land in the panel or the benchmark — a tellable story does not count
3. When tracks conflict, resolve in the order "protocol reliability > observability > cost"

### Track notes

- **P1 Cost**: each relay turn has constant input (one brief + one driving input), while a monolith grows linearly with history. The per-baton fixed overhead (output tokens for brief regeneration, salvage fallback calls) does not scale with history — that is the price of buying boundedness. **Honest boundary**: short sessions (a few thousand tokens) are not better on relay; the fixed overhead has not yet been amortised. The double-ledger shows wins and losses as they are.
- **P2 Stability**: context rot is an architectural phenomenon — attention dilutes, and a model's implicit compression (recurrent state, internal memory) has its own decay curve that is simply unobservable. Protocol compression decays too, but it is observable and intervenable: the decay probe measures it, L2 packing intervenes. **The essential difference is not "no decay" but "controllable decay".**
- **P3 Audit**: a model's internal state is invisible and unreviewable. Theseus Relay lands everything auditable on a human-readable substrate: the brief chain is a complete snapshot of each baton's input. A handoff is a checkpoint — not log analysis, a protocol guarantee.
- **P4 Transactions**: a failed baton never existed (the brief still points at the last successful baton; rollback restores everything); the decision ledger is append-only, which stops later batons from re-proposing rejected options. The validator turns the mechanisable part of this into script-level determinism.
- **P5 Scheduling**: the model market is diversifying — window sizes, prices and capabilities all differ. For a monolithic architecture that is a compatibility burden; for a relay protocol it is scheduling space.
- **P6 Persistence**: user preferences, project state and cross-session decisions are dynamic and can only live outside the model; the brief chain is exactly a portable carrier: human-readable, model-agnostic, exportable, versionable.

**Relation to model architecture evolution** (asymmetric impact): P3 / P4 / P6 live structurally outside the model and are unaffected; P2 / P5 actually gain value — a stronger model still cannot eat the value of fresh context, and lineage divergence only widens the scheduling space; P1 needs re-anchoring — from "saving tokens" to "bounded over long sessions".

## 2. Ladder one · single chain: what one baton can do

> Serial semantics; every rung stops at "minimally runnable".

### v0.1 Conversation relay (implemented)

> Tracks served: P1 Cost · P3 Audit · P4 Transactions

- Structured brief + cumulative compression + anti-placeholder
- Log lookup (log-as-memory, bounded retrieval)
- JSON protocol + truncation salvage + anti-procrastination
- Backstage live view: every baton's input / output / retrieval fully auditable

**Verified properties**: bounded context (constant cost), baton-level fault isolation, identity continuity guaranteed by protocol.

### v0.1.1 Substrate validator (implemented)

> Tracks served: P4 Transactions · P3 Audit

The five mechanical checks of PROTOCOL §4 move into code: five sections present, no placeholders, within budget, decisions append-only, pointers valid. Fail → reject and re-dispatch (PROTOCOL §6).

**Why it comes before tool batons**: the field-tested traps — anti-placeholder, anti-procrastination — were previously enforced purely by prompt constraints (model self-discipline). The validator is the first "substrate is more reliable than the model" component: dirt cheap (pure regex + diff), yet it turns brief quality from a probability problem into a determinism problem — baton-level transactions, quality gates and protocol independence all build on its existence.

**Status**: `src/validate.js` (five pure-function checks) → `relay.js` reject-and-re-dispatch (once per baton; a second failure falls back to a summary call and marks `rejected`) → validation errors surfaced in the panel.

### v0.1.2 Telemetry and the cost double-ledger (implemented)

> Tracks served: P1 Cost · P3 Audit

- Per-baton telemetry persisted to session storage: input / output tokens, latency, model, log-lookup count, salvage / rejected events
- The panel gains a **cost double-ledger**: two cumulative curves per session — actual relay cost vs. simulated monolithic cost (current model pricing × full-history re-read, including prefix-cache read prices)
- Why it matters: P1 stops being an argument and becomes a live number on the panel. Short-session losses and long-session wins are both shown as-is — losing honestly is where this track's credibility comes from

**Passing criterion**: the panel can answer, in real time, "what would this session have cost monolithically by now".

### v0.1.3–v0.1.7 The measurement & multi-purpose layer (not built)

No hard dependency on tool batons — they can interleave. Each stops independently at "minimally runnable". **This layer is also the H3 self-improvement baton's only source of KPIs** — do not treat it as optional decoration.

| Rung | Content | Passing criterion |
|---|---|---|
| v0.1.3 Cross-session bootstrap | A new session can import the Decision + User Profile sections of a previous session's final brief as its initial brief; the panel exports the full brief chain as JSON | After closing the browser and bootstrapping a new session from the import, the model answers the previous session's settled decisions correctly |
| v0.1.4 Decay probe | Every 10 batons, an automatic recall spot-check: sample 5 factual questions from the substrate log, answer via an independent call, compare against the originals, emit `retention_rate` | Becomes a permanent panel metric and can separate "the brief never recorded it" from "the model didn't use it" |
| v0.1.5 Brief bandwidth tiers | Three tiers: L0 = 400-character pointer brief (small models / chore batons), L1 = 800-character full brief (current default), L2 = brief + substrate log excerpt pack; packed to the next baton's declared window budget | Within one session, different batons receive different tiers per routing rules, with no perceptible quality difference |
| v0.1.6 Dual-track benchmark | benchmark.html gains a protocol benchmark mode: the same questions run on two tracks (relay chain vs. monolithic long context), inserted at turns 30 / 60 / 90, auto-scored into curves | One click produces the dual-track quality-vs-turn curve |
| v0.1.7 Model routing table (toy) | The settings page allows rules ("batons with tool calls use model X, pure-chat batons use model Y"); the panel shows which model each baton actually used | A 50-baton session runs with two models mixed per rules, fully annotated on the panel |

> Tracks served: v0.1.3 P6 · P5; v0.1.4 P2 · P6; v0.1.5 P1 · P2 · P5; v0.1.6 P2 · P1; v0.1.7 P5 · P1.

**Two ordering constraints**: v0.1.5's L0 pointer form depends on the persistence rules (until then L0 degrades to a hard-compression tier); retrieval quality (F1, see §4) **landed on 2026-09-21**, so it no longer blocks v0.1.4 — the earlier rule was that F1 must precede v0.1.4, otherwise the decay probe cannot separate out the "retrieval gave nothing" failure mode.

### v0.2 Tool batons (= H0, implemented 2026-09-20)

> Tracks served: P4 Transactions (side-effect ledger) · P1 Cost (task-level budget and oscillation detection) · P2 Stability (bounded input)

- The ACT phase emits tool-call requests (file read/write, command execution, search)
- New fifth brief section, the **side-effect ledger**: every irreversible operation this baton performed, item by item; the next baton must know "what has already been changed in the world"
- Tool permissions granted per baton (read/write separation, allowlist for dangerous operations)
- **Deterministic quality gates (backpressure)**: output passes tests / lint / build first — zero tokens, zero bias, run every time; on failure, re-dispatch immediately, do not escalate to a review baton
- **Baton granularity**: in-baton ReAct loops are abolished in favour of PROTOCOL §2.1's static criterion — **does the next step depend on some call's return value**. The whole old "loop budget" set (6 tool round trips / 60% window / 90 s / dead-loop detection / wrap-up reserve) **is void accordingly**. Tool batons are therefore easier to write: no dynamic budget system that has to be calibrated empirically
- **Write targets and write partitions**: every write carries a `write_target`; concurrent batons must have disjoint write targets, checked statically by the substrate (a single chain has no concurrent writes, so the disjointness check waits for H1)
- **Task-level budget and oscillation detection**: baton-count cap, per-task cost cap (reusing v0.1.2 telemetry) — note these are now **task-level**, no longer per baton; decision oscillation (a rejected option re-proposed) is detected by the substrate diffing the decision ledger, with an alert (PROTOCOL §6)

**Key design**: the evidence of tool calls lands in the substrate; the intent of tool calls goes into the brief. The worker is stateless, but the world has state.

**Passing criterion**: a 20-step task runs to completion with no in-baton loop anywhere, and the panel shows each baton's calls and reason for handing off step by step; the "evidence lands in the substrate" rule must be verifiable — long tool output enters the brief as a summary plus a retrievable reference, with the full text only in the substrate, otherwise "bounded context" dies the moment tool batons arrive.

**Status**: single-chain runner `src/task.js` (`runChain`, one user message drives the whole chain) + return classification and ack aggregation `src/returns.js` + the minimal tool set `src/tools.js` (search_files / read_file / write_file; path guarding belongs to scripts, writes record their target, permissions granted per baton via whitelist) + brief extended to five sections (`src/validate.js`, the side-effect ledger). v0.3a landed in the same pass: output over 1000 characters persists in full to `data/artifacts/<sid>/` and the baton sees only a summary + a `->` pointer; task-level budget `maxBatonsPerTask=24` / `maxCostPerTaskUsd=0.5` stops the chain with a report on reaching the cap (substrate-generated, zero tokens), never throwing; the panel shows each baton's calls, return classification (ack / info) and handoff reason (reply / info-return / ack-aggregate / budget). `node --test` 51 checks green; keyless mock integration (`MOCK_CHAIN=1`) runs the full three-baton chain "write + search → read → answer", with the measured driving input at 517 characters vs. 5270 characters of raw output.

### v0.3a Substratization · evidence persisted, intent carried (prerequisite of H0, implemented)

> Tracks served: P1 Cost (long output stays out of context) · P6 Persistence (real state on disk)

- **Long tool output lands in the substrate; the brief keeps only "a summary + a retrievable reference"** — the only mandatory persistence capability for H0. The moment long tool output enters a brief, "bounded context" dies on the spot
- The brief gains "next intent" (PROTOCOL §2.1's intent packet): a batch of calls is emitted before its return values exist, so what gets written is "what comes next, and on what grounds"
- The persistence rule follows PROTOCOL §3 Invariant 4: anything persisted keeps only a one-line pointer in the brief

**Explicitly out of scope**: task boards, task cards and the static `write_target` disjointness check are not in this rung — a single chain has no concurrent writes, so a disjointness check **has nothing to check**. They belong to v0.3b / H1.

### v0.3b Substratization · task board and pointer briefs (prerequisite of H1, not built)

> Tracks served: P1 Cost (thinner briefs) · P6 Persistence (real state on disk, memory layering)

- The brief degrades from prose to pointers: state-file paths, task-list IDs, SSOT document locations; the length cap drops accordingly (e.g. 400 characters) — the thinner, the more stable, the cheaper to rebuild
- **Task board**: real state is organized as task-board documents, each task card carrying a `write_target`. It is the basis for splicing work, the input to the static "write targets are disjoint" check, and the artifact that H3's self-improvement baton optimizes
- **The persistence rule is the compression rule** (PROTOCOL §3 Invariant 4): persisted → keep a pointer, disposable at any time; not persisted → the only copy, never dropped. No on-the-spot judgment during compression
- **Memory layering**: project memory lives in each project's own folder (SSOT documents); knowledge reusable across projects is distilled into skills loaded on demand — projects stay naturally isolated and don't consume brief budget

**Why it sits at H1 rather than H0**: a single chain only grows the baton count linearly; fan-out is what makes it multiplicative. When a task runs into dozens of batons, cost and latency both explode unless the brief collapses into a pointer-style intent packet.

### v0.4 Review batons and baton-level transactions (granularity now stage-level, not built)

> Tracks served: P4 Transactions (baton-level transactions) · P2 Stability (structurally unbiased review)

- **Stage-level review**: once execution batons deliver a stage's output, one review baton re-checks it — not one per execution baton. Stage granularity = the granularity that keeps a review baton's input bounded
- The review baton's structural advantage: **it genuinely never saw the writing process** — no sunk cost, no ownership bias. This is a reviewer no single-agent architecture can build
- **Division of labor**: anything the deterministic quality gates can catch never reaches a review baton — LLM review only handles semantic questions: naming, design coherence, "is it what was asked for". Cheap deterministic checks first, expensive probabilistic review second
- Baton-level transactions: review fails → roll back to the previous brief and re-dispatch; the failed baton leaves no trace

### v0.5 Protocol independence (not built)

> Tracks served: P5 Scheduling (cross-model relay) · P6 Persistence (portable schema)

- Versioned brief schema (`brief_schema: 1`), validatable and migratable
- Baton implementations and substrate implementations decouple: any runner (CLI, service, another harness) that implements the same protocol can interoperate
- Endgame: **cross-model relay** as a cost-scheduling lever — chore batons on cheap models, critical batons on strong ones, with the protocol guaranteeing lossless handoffs

## 3. Ladder two · hive: how a swarm of batons collaborates (from 2026-09-20)

> Three decided rules + four milestones numbered H. **This section supersedes the scheduling of v0.2 and everything after it**; how the old entries are disposed of is in the table below.

### The root change: the driving signal

**Old: one user message = one baton.** The system is passive — when the user stops talking, the chain stops there. The whole project could therefore only demonstrate "how to swap people mid-chat", never "how a task runs itself". That is why it looked half-built for so long.

**New: any input event = one baton, tool returns included.** For the first time the system can roll forward without the user. The protocol-level definition is in PROTOCOL §2.1.

### Rule one: granularity — a set of mutually independent calls = one baton

- Criterion: **does the next action depend on some tool call's return value** (PROTOCOL §2.1). If yes, hand off; if no, emit the batch inside this baton
- Ack-type returns (write success/failure, exit codes, rows affected) are aggregated by the substrate into one line — **do not open a baton per acknowledgement**
- Every write must carry an identifiable `write_target`; concurrent batons must have disjoint write targets, **checked statically, conflict fails immediately** — a deterministic rule that belongs to the script layer

### Rule two: review granularity — stage-level, but a stage is not defined by taste

- One review baton follows each stage's output, not every execution baton (too expensive, and it binds rework signals too finely)
- **Stage granularity = the granularity that keeps a review baton's input bounded**: the artifact list must fit into one brief plus one packing budget. Otherwise the review baton's input grows into another long context, violating P2's bounded context head-on

### Rule three: self-improvement batons (with guardrails)

One kind of baton in the swarm produces no deliverable and only optimizes the allocation rules and the structure of the task board / document system; how much execution, review and planning is needed is apportioned by that baton itself. Three guardrails:

1. **Immutable core**: the protocol's four invariants (PROTOCOL §3), the substrate validator and baton-level transactional semantics — it may not change them directly, only propose an ADR for a human to confirm
2. **An improvement proposal must carry before/after metrics; without evidence, reject it** — the §4 validation idea lifted to the meta layer
3. **A hard quota cap** (start at 10–15% of total batons, calibrate empirically) — to stop the swarm degenerating into "all allocation batons, nobody working"

Its KPIs need no new construction: telemetry and the cost double-ledger (v0.1.2) plus the future retention probe (v0.1.4) are the source. **That is also why it sits at H3: before the metrics land, it can only spin.**

### The four milestones

| Stage | Content | Passing criterion | State |
|-------|---------|-------------------|-------|
| **H0** | Single-chain stepping: batch-baton semantics + the two kinds of return values (PROTOCOL §2.1) | A 20-step task completes, with no in-baton ReAct loop anywhere, and the panel shows every step | Implemented 2026-09-20 |
| **H1** | Fan-out and join: `write_target` + static write-partition checks + join / timeout / partial failure | Three-way parallel → D aggregates; conflicts are refused by the engine | Not built |
| **H2** | Stage-level review + a decision layer (placeheld by a rule stub, later swapped for a decision-only model returning a probability distribution) | One review per stage; every decision has acceptable latency and is 100% traceable | Not built |
| **H3** | Self-improvement batons (three guardrails) + self-sustaining operation | Seed one goal and it runs to done, with improvement proposals carrying their own before/after metrics | Not built |

### Disposition of the old entries

| Old entry | Disposition |
|-----------|-------------|
| v0.2 "loop budget" (6 round trips / 60% window / 90 s / dead-loop detection / wrap-up reserve) | **Void**. There is no in-baton loop any more, so the parameters have nothing to act on (PROTOCOL §2.1) |
| "What we will not do": "No parallel batons" | **Lifted**. Parallelism is the definition of a hive; write conflicts are instead constrained by a static check that batons' `write_target`s are disjoint (H1) |
| v0.3 Substratization | **Split in two**: v0.3a (long tool output persisted to the substrate + intent in the brief) is a **prerequisite of H0**; v0.3b (task board + pointer briefs + memory layering) is a **prerequisite of H1**. Core reason: a single chain only grows baton count linearly; fan-out is what makes it multiplicative |
| v0.4 Review batons | Granularity becomes **stage-level** (rule two); the review baton's advantage of "structurally never seeing the writing process" is unchanged |
| v0.5 Protocol independence | Unchanged, folded into H2 / H3 |
| R1 (shared-counter defect) | **Structurally dissolved by H0**: three kinds of calls no longer compete for one budget inside a baton |
| The "crossover at baton 35" | **Recalibrated**: about 25 batons for chat sessions under the post-R3/R4 rates (assumed shape in TESTS.md §D); the tool-chain scenario waits for H1 |
| The v0.1.3–v0.1.7 measurement layer | Unchanged, and with a new layer of meaning: it is the self-improvement baton's source of KPIs |

**GUI** is shelved for now; when the hive GUI is built it reuses existing pieces — the live panel (→ hive topology view), `pricing.js` (→ per-task cost accounting + the self-improvement baton's KPI source), `validate.js`'s five checks (→ a meta-layer validator for improvement proposals), session storage and retrieval (→ board retrieval and audit), and `relay.js`'s salvage / degradation pipeline (still applicable under concurrent batons).

## 4. Pending revisions

> Findings from a review of **shipped code**. Revisions are not new features and are therefore exempt from the "≥2 tracks" bar — they merely move promises already written down into code. R1 has been structurally dissolved by H0; R2 and R6 are fixed; **R3 and R4 are fixed** (cost rates), **R5 is fixed** (item-counting rates) and **F1 is fixed** (retrieval quality), 2026-09-21; R7 is narrowed to an empirically deferred R7(b).

| # | Finding | Nature | Tracks |
|---|---------|--------|--------|
| R7(b) | Whether the fallback should also retry once — decide once real-world rates for fallbacks and validator rejections are observed (R7's visibility and provenance labelling have landed) | Empirical | P4 · P3 |

**R3 and R4 shipped in one pass (2026-09-21)**: R3 bills the relay with the endpoint-reported `cached` at the cache rate; R4 moves the brief to the end of the system prompt, so all fixed content precedes it — the cacheable prefix is now a measured 1120 characters on the chat line and 829 on the tool line (previously the fixed content after the brief could never hit the cache). The tool line additionally fixes a real defect: `prev` was computed but never injected, so tool batons never saw the previous brief (PROTOCOL §1's core invariant); it is now injected at the end.

**R5 and R7 landed (2026-09-21)**: R5 changes item counting from "by line" to "items separated by semicolons on one line each count" — a model merging lines under budget pressure is no longer misread as items shrinking (a false rejection also eats the re-dispatch budget). R7's visibility (fallback results and validation errors on the panel) already existed from H0; this pass adds the substitute for the mechanical guarantee: **a fallback brief states its own provenance at the top** (`【简报来源·基底】`), so both the next baton and the panel can see the brief is unreliable. R7(b) — whether to also retry the fallback — still waits for field data.

**F1 is fixed (2026-09-21)**: all three rules live in the retrieval section of `src/relay.js` — line prefixes do not score; low-information tokens are filtered in two tiers (a static list plus a document-frequency gate, both thresholds exported as named constants); results are de-duplicated by prefix-stripped body before truncating to 8. The relaxation criterion is **whether the hits went empty**, not whether the tokens did — the looser the tier, the less it may kill a real hit. Quotas (2 lookups / 8 hits) and §5's semantics are untouched, and it **still introduces no vector database**. Why it precedes v0.1.4: the decay probe must separate "the brief never recorded it" from "the model didn't use it"; unreliable retrieval adds a third failure mode — "retrieval gave nothing" — that contaminates both.

**To be calibrated empirically** (not scheduled; decide once there is data): the per-baton log-lookup cap, the re-dispatch cap, the wrap-up reserve's share of the total budget, the task-level baton and cost caps, the self-improvement baton's quota share, the maximum artifact volume of a stage, and the **recalibration of the crossover for tool-chain scenarios**.

## 5. What we will not do

- No vector database: the retrieval need is "find that one thing someone said" — n-gram suffices; leave the complexity to the substrate
- ~~No parallel batons: relay is serial by semantics; parallelism belongs to another protocol~~ → **Lifted (2026-09-20)**: parallelism is the definition of a hive; write conflicts are instead constrained by a **static check** that batons' `write_target`s are disjoint
- No streaming output: emitting the complete JSON in one shot is the precondition for the salvager to work; we'd rather wait
- No behavioral constraints at the prompt layer (when the substrate validator can express them): rules live in the harness, not the prompt — models cheat, scripts don't
- **No decision model replacing the substrate validator**: the decision layer may only take on "finite-option judgments that scripts cannot express", and its output must be persisted to the substrate log; the commit condition of baton-level transactions remains a script, always
- No special-case code for a single track: any new feature must serve ≥2 tracks; single-track requests go to the backlog freezer
