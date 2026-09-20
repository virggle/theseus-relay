# Evolution Path · From Chatbox to Harness

[中文](ROADMAP.md) | **English**

> The final form of Theseus Relay is not a chat box but a **relay runtime**: stateless workers take batons under a protocol and complete long-horizon tasks on a stateful substrate. This document is the ladder — each rung stops at "minimally runnable", and is annotated with the value tracks it serves (P1–P6, defined in [PURPOSES.en.md](PURPOSES.en.md)).

## Direction reset: from conversation relay to a hive (2026-09-20)

> Three decided rules + four milestones numbered H. **This section supersedes the scheduling of v0.2 and everything after it**; how the old entries are disposed of is in the table at the end of this section.

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

1. **Immutable core**: the protocol's four invariants (PROTOCOL §3), the substrate validator, and baton-level transactional semantics — it may not change them directly, only propose an ADR for a human to confirm
2. **An improvement proposal must carry before/after metrics; without evidence, reject it** — the §4 validation idea lifted to the meta layer
3. **A hard quota cap** (start at 10–15% of total batons, calibrate empirically) — to stop the swarm degenerating into "all allocation batons, nobody working"

Its KPIs need no new construction: telemetry and the cost double-ledger (v0.1.2) plus the future retention probe (v0.1.4) are the source. **That is also why it sits at H3: before the metrics land, it can only spin.**

### The four milestones

| Stage | Content | Passing criterion |
|-------|---------|-------------------|
| **H0** | Single-chain stepping: batch-baton semantics + the two kinds of return values (PROTOCOL §2.1) | A 20-step task completes, with no in-baton ReAct loop anywhere, and the panel shows every step |
| **H1** | Fan-out and join: `write_target` + static write-partition checks + join / timeout / partial failure | Three-way parallel → D aggregates; conflicts are refused by the engine |
| **H2** | Stage-level review + a decision layer (placeheld by a rule stub, later swapped for a decision-only model returning a probability distribution) | One review per stage; every decision has acceptable latency and is 100% traceable |
| **H3** | Self-improvement batons (three guardrails) + self-sustaining operation | Seed one goal and it runs to done, with improvement proposals carrying their own before/after metrics |

### Disposition of the old entries

| Old entry | Disposition |
|-----------|-------------|
| v0.2 "loop budget" (6 round trips / 60% window / 90 s / dead-loop detection / wrap-up reserve) | **Void**. There is no in-baton loop any more, so the parameters have nothing to act on (PROTOCOL §2.1) |
| "What we will not do": "No parallel batons" | **Lifted**. Parallelism is the definition of a hive; write conflicts are instead constrained by a static check that batons' `write_target`s are disjoint (H1) |
| v0.3 Substratization | **Split in two**: v0.3a (long tool output persisted to the substrate + intent in the brief) is a **prerequisite of H0**; v0.3b (task board + pointer briefs + memory layering) is a **prerequisite of H1**. Core reason: a single chain only grows baton count linearly; fan-out is what makes it multiplicative |
| v0.4 Review batons | Granularity becomes **stage-level** (rule two); the review baton's advantage of "structurally never seeing the writing process" is unchanged |
| v0.5 Protocol independence | Unchanged, folded into H2 / H3 |
| R1 (shared-counter defect) | **Structurally dissolved by H0**: three kinds of calls no longer compete for one budget inside a baton; until H0 lands it remains a real defect in the v0.1 code |
| The "crossover at baton 35" | **Void** (calibrated under the old granularity); recalibrate after H1; do not cite it before that |
| The v0.1.3–v0.1.7 measurement layer | Unchanged, and with a new layer of meaning: it is the self-improvement baton's source of KPIs |

## v0.1 Conversation relay (current, implemented)

> Tracks served: P1 Cost (bounded input) · P3 Audit (live panel) · P4 Transactions (baton-level fault isolation)

- Structured brief + cumulative compression + anti-placeholder
- Log lookup (log-as-memory, bounded retrieval)
- JSON protocol + truncation salvage + anti-procrastination
- Backstage live view: every baton's input/output/retrieval fully auditable

**Verified properties**: bounded context (constant cost), baton-level fault isolation, identity continuity guaranteed by protocol.

## v0.1.1 Substrate validator (implemented)

> Tracks served: P4 Transactions · P3 Audit

Move the five mechanical checks of PROTOCOL §4 from paper into code: four sections present, no placeholders, within budget, decisions append-only, pointers valid. Fail → reject and re-dispatch (§6).

Why it comes before tool batons: **the field-tested traps — anti-placeholder, anti-procrastination — are currently enforced purely by prompt constraints (model self-discipline)**. The validator is the first "substrate is more reliable than the model" component: dirt cheap (pure regex + diff), yet it turns brief quality from a probability problem into a determinism problem — baton-level transactions, quality gates, and protocol independence all build on its existence.

**Status**: shipped — `src/validate.js` (five pure-function checks) → `relay.js` reject-and-re-dispatch (once per baton; a second failure falls back to a summary call and marks `rejected`) → validation errors surfaced in the panel → `npm test` (node:test, 13 cases). For the key-less drill see TESTS.md §C.

**Pending revisions** (details in "Revisions and prerequisites" at the end): R5 counts items per line and can false-reject; R7 records fallback briefs without blocking them.

> **v0.1.2–v0.1.7 form the measurement & multi-purpose layer**: no hard dependency on v0.2 tool batons — they can interleave. Each stops independently at "minimally runnable". Ordering constraints live in one place: the §Execution order of "Revisions and prerequisites" at the end. Two of them are counter-intuitive: v0.1.5's L0 pointer form depends on v0.3's persistence rules (until then L0 degrades to a hard-compression tier); and retrieval quality (F1) must land before v0.1.4 — otherwise the decay probe cannot separate out the "retrieval gave nothing" failure mode. **Addendum (2026-09-20)**: the measurement layer is also the H3 self-improvement baton's only source of KPIs — do not treat it as optional decoration.

## v0.1.2 Telemetry and the cost double-ledger

> Tracks served: P1 Cost · P3 Audit

- Per-baton telemetry persisted to session storage: input/output tokens, latency, model, log-lookup count, salvage/rejected events
- The panel gains a **cost double-ledger**: two cumulative curves per session — actual relay cost vs. simulated monolithic cost (current model pricing × full-history re-read, including prefix-cache read prices)
- Why it matters: P1 stops being an argument and becomes a live number on the panel. Short-session losses and long-session wins both shown as-is — losing honestly is where this track's credibility comes from

Passing criterion: the panel can answer, in real time, "what would this session have cost monolithically by now".

**Status**: shipped — `src/pricing.js` (price table + monolithic baseline + token estimation) → per-baton telemetry in `relay.js` (tokens, latency, model, log-lookup count, salvage/rejected/re-dispatch) → `cost` series returned by `/api/state` and `/api/turn` → "cost double-ledger" card with dual curves in the backstage panel. `tests/cost.test.js` re-derives the arithmetic by hand and pins down one fact: **under the current rates, a two-baton session is more expensive on relay; the crossover sits around baton 35** — and the panel shows the loss as readily as the win. (**Note 2026-09-20**: that number was calibrated under the old granularity and is void after the granularity change; do not cite it as a conclusion until recalibrated.)

**Pending revisions** (details at the end): R3 — the ledger collects `cached` but never bills with it, systematically overstating relay cost; R4 — the brief sits between fixed blocks, so 449 characters of fixed content can never hit the prefix cache. Both belong to this rung's rates; they must ship in one pass, then the crossover is recomputed.

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

## v0.2 Tool batons (= H0, implemented 2026-09-20)

> Tracks served: P4 Transactions (side-effect ledger) · P1 Cost (task-level budget and oscillation detection) · P2 Stability (bounded input)

- The ACT phase emits tool-call requests (file read/write, command execution, search)
- New fifth brief section: the **side-effect ledger** — every irreversible operation this baton performed, item by item; the next baton must know "what has already been changed in the world" before taking over
- Tool permissions granted per baton (read/write separation, allowlist for dangerous operations)
- **Deterministic quality gates (backpressure)**: output passes tests / lint / build first — zero tokens, zero bias, run every time; on failure, re-dispatch immediately, do not escalate to a review baton
- **Baton granularity (rewritten 2026-09-20)**: in-baton ReAct loops are abolished in favour of PROTOCOL §2.1's static criterion — **does the next step depend on some call's return value**. The whole old "loop budget" set (6 tool round trips / 60% window / 90 s / dead-loop detection / wrap-up reserve) **is void accordingly**. Tool batons are therefore easier to write: no dynamic budget system that has to be calibrated empirically
- **Write targets and write partitions**: every write carries a `write_target`; concurrent batons must have disjoint write targets, checked statically by the substrate. This is the only new guardrail in this rung
- **Task-level budget and oscillation detection**: baton-count cap, per-task cost cap (reusing v0.1.2 telemetry) — note these are now **task-level**, no longer per baton; decision oscillation (a rejected option re-proposed) is detected by the substrate diffing the decision ledger, with an alert (PROTOCOL §6)

Key design: **the evidence of tool calls lands in the substrate; the intent of tool calls goes into the brief.** The worker is stateless, but the world has state.

Passing criterion: a 20-step task runs to completion with no in-baton loop anywhere, and the panel shows each baton's calls and reason for handing off step by step; the "evidence lands in the substrate" rule above must be verifiable — long tool output enters the brief as a summary plus a retrievable reference, with the full text only in the substrate, otherwise "bounded context" dies the moment tool batons arrive.

**Implemented (H0, 2026-09-20)**: single-chain runner `src/task.js` (`runChain`, one user message drives the whole chain) + return classification and ack aggregation `src/returns.js` + the minimal tool set `src/tools.js` (search_files / read_file / write_file; path guarding belongs to scripts, writes record their target, permissions granted per baton via whitelist) + brief extended to five sections (`src/validate.js`, the side-effect ledger). v0.3a landed in the same pass: output over 1000 chars persists in full to `data/artifacts/<sid>/`, and the baton sees only a summary + a `->` pointer; task-level budget `maxBatonsPerTask=12` / `maxCostPerTaskUsd=0.5` stops the chain with a report on reaching the cap (substrate-generated, zero tokens), never throwing; the panel shows each baton's calls, return classification (ack/info) and handoff reason (reply / info-return / ack-aggregate / budget). `node --test` 51 checks all green; keyless mock integration (`MOCK_CHAIN=1`) runs the full three-baton chain "write+search → read → answer", with the measured driving input at 517 chars vs 5270 chars of raw output.

## v0.3a Substratization · evidence persisted, intent carried (prerequisite of H0)

> Tracks served: P1 Cost (long output stays out of context) · P6 Persistence (real state on disk)

- **Long tool output lands in the substrate; the brief keeps only "a summary + a retrievable reference"** — the only mandatory persistence capability for H0, and the landing of v0.2's "evidence lands in the substrate" criterion. The moment long tool output enters a brief, "bounded context" dies on the spot
- The brief gains "next intent" (§2.1's intent packet): a batch of calls is emitted before its return values exist, so what gets written is "what comes next, and on what grounds"
- The persistence rule follows PROTOCOL §3 Invariant 4: anything persisted keeps only a one-line pointer in the brief

**Explicitly out of scope (corrected 2026-09-20)**: task boards, task cards, and the static `write_target` disjointness check are not in this rung — a single chain has no concurrent writes, so a disjointness check **has nothing to check**. They belong to v0.3b / H1.

Passing criterion: a 20-step task completes without any baton's context containing the raw text of long tool output — only references.

## v0.3b Substratization · task board and pointer briefs (prerequisite of H1)

> Tracks served: P1 Cost (thinner briefs) · P6 Persistence (real state on disk, memory layering)

- The brief degrades from prose to pointers: state-file paths, task-list IDs, SSOT document locations; the length cap drops accordingly (e.g. 400 characters) — the thinner, the more stable, the cheaper to rebuild
- **Task board**: real state is organized as task-board documents, each task card carrying a `write_target`. It is the basis for splicing work, the input to the static "write targets are disjoint" check, and the artifact that H3's self-improvement baton optimizes
- **The persistence rule is the compression rule** (PROTOCOL §3 Invariant 4): persisted → keep a pointer, disposable at any time; not persisted → the only copy, never dropped. No on-the-spot judgment during compression
- **Memory layering**: project memory lives in each project's own folder (SSOT documents); knowledge reusable across projects is distilled into skills loaded on demand — projects stay naturally isolated and don't consume brief budget

**Why it sits at H1 rather than H0 (corrected 2026-09-20)**: a single chain only grows the baton count linearly; fan-out is what makes it multiplicative. When a task runs into dozens of batons, cost and latency both explode unless the brief collapses into a pointer-style intent packet — so this is a prerequisite of H1, not of H0.

Passing criterion: when swapping the model on a baton makes no difference to output quality, this rung is done.

## v0.4 Review batons and baton-level transactions (granularity now stage-level)

> Tracks served: P4 Transactions (baton-level transactions) · P2 Stability (structurally unbiased review)

- **Stage-level review**: once execution batons deliver a stage's output, one review baton re-checks it — not one per execution baton (rule two). Stage granularity = the granularity that keeps a review baton's input bounded
- The review baton's structural advantage: **it genuinely never saw the writing process** — no sunk cost, no ownership bias. This is a reviewer no single-agent architecture can build
- **Division of labor**: anything the deterministic quality gates (v0.2) can catch never reaches a review baton — LLM review only handles semantic questions: naming, design coherence, "is it what was asked for". Cheap deterministic checks first, expensive probabilistic review second
- Baton-level transactions: review fails → roll back to the previous brief and re-dispatch; the failed baton leaves no trace

## v0.5 Protocol independence

> Tracks served: P5 Scheduling (cross-model relay) · P6 Persistence (portable schema)

- Versioned brief schema (`brief_schema: 1`), validatable and migratable
- Baton implementations and substrate implementations decouple: any runner (CLI, service, another harness) that implements the same protocol can interoperate
- Endgame: **cross-model relay** as a cost-scheduling lever — chore batons on cheap models, critical batons on strong ones, with the protocol guaranteeing lossless handoffs

## Revisions and prerequisites (2026-09-12 code review)

> This section records a review of **shipped code** (v0.1–v0.1.2): which findings are commitments already written down but not yet met (revisions, `R*`), and which must be inserted **ahead of** already-scheduled rungs (prerequisites, `F*`). Revisions are not new features and are therefore exempt from the "≥2 tracks" bar in "What we will not do" at the end — they merely move existing promises into code.

| # | Finding | Nature | Tracks | Lands |
|---|---------|--------|--------|-------|
| R1 | Log lookup, validator re-dispatch and answering share one `for (i<3)` counter: 2 lookups + 1 rejection exhausts the budget and throws, discarding a reply already produced | Defect | P4 · P3 · P6 | v0.1 · **structurally dissolved by H0** |
| R2 | An over-budget `read_log` fails its guard and falls into the salvage branch, so the user sees raw JSON | Defect | P4 · P2 | v0.1 |
| R3 | Telemetry collects `usage.cached` but the cost ledger never bills with it, while the monolithic side gets the full cache rate — the rates favour the monolith one-sidedly, making the crossover conservative | Rates | P1 | v0.1.2 |
| R4 | The brief sits between fixed blocks: only 537 characters are cacheable prefix, leaving 449 characters of fixed content permanently uncacheable | Implementation | P1 · P5 | v0.1.2 |
| R5 | The "decisions append-only" check counts items by **line**: under budget pressure a model merges lines, is falsely rejected, and the re-dispatch eats R1's budget | Rates | P4 · P1 | v0.1.1 |
| R6 | The `result.salvaged` field read by `server.js` is never returned by `relay.js`, so this audit flag is permanently false | Defect | P3 | v0.1 |
| R7 | Fallback briefs record `validation` without blocking, so an invalid brief can enter the next baton through the back door, while PROTOCOL §4 promises a mechanical guarantee | Rates | P4 · P3 | v0.1.1 |
| F1 | Retrieval quality trio: low-information-token filtering, excluding log line prefixes from scoring, and de-duplicating retrieval results | Prerequisite | P2 · P6 | before v0.1.4 |

### Why R1 comes first

R1 is not merely "one turn lost". It throws **before** `runTurn` returns, while both the log and batons writes happen after it (the `/api/turn` branch in `server.js`) — so a single trigger opens three holes at once: the reply is discarded, **the user's message never enters the log** (the archive defined by PROTOCOL §5 and P6's memory substrate), and the panel never sees that the turn happened. The error message also misreports a validator rejection as "log lookup limit exceeded". Until R1 is fixed, every metric — the v0.1.2 ledger, the v0.1.4 decay probe, the v0.1.6 benchmark — can be polluted by silently swallowed turns. Hence it precedes all measurement work.

### Why R3 and R4 ship together

Both act on the v0.1.2 cost rates. R3 gives the relay the cache discount it can actually earn (using the endpoint-reported `cached` value, not an assumption); R4 raises the cacheable fixed portion from 537 to 1016 characters — measured: fixed content totals 1016 characters (537 before the brief, 449 after), the per-baton system prompt is 1786 characters, so reordering saves roughly 19% of input-side cost, and it is a pure reordering touching no protocol text. Shipping them separately would leave "crossover at baton 35" — a number pinned by TESTS.md §D — existing under two different rates, so both go in one pass, the crossover is recomputed, and the pinned test value follows. **Addendum 2026-09-20**: the real rate change comes from the granularity shift (PROTOCOL §2.1), so the sensible order is to recalibrate granularity first and then ship R3 / R4 — otherwise the crossover gets recalibrated twice.

### Why F1 precedes v0.1.4

v0.1.4's passing criterion requires the decay probe to separate "the brief never recorded it" from "the model didn't use it". Unreliable retrieval adds a third failure mode — "retrieval gave nothing" — which contaminates both (today `searchLog` is bare 2-gram scoring, and every log line carries a `【Baton N · user】` prefix, so querying "user preferences" makes `user`/`assistant` match every line and ranking collapses). v0.1.5's packing-to-budget depends on it even more directly: packing presupposes that retrieved results can be judged for relevance. F1 uses a stop-word list plus prefix exclusion, and **still introduces no vector database**, consistent with the first line of "What we will not do".

### Already covered by the existing plan — unchanged

- Moving long tool output out of context → v0.2's "evidence lands in the substrate, intent goes into the brief"; this round only adds a verifiable criterion to v0.2, leaving the design untouched
- Pointer briefs and memory layering → **v0.3b**, unchanged (2026-09-20: it is a prerequisite of H1, not of H0; H0 only needs v0.3a's evidence persistence)
- "No vector database" → unchanged; F1 is implemented inside that boundary

### Execution order

| Batch | Contents | Why here |
|-------|----------|----------|
| 1 | R1 (per the wrap-up semantics), R2, R6 | Stop the bleeding: no metric is trustworthy until these are fixed. All three are small and touch no protocol text |
| 2 | R3, R4 | Same v0.1.2 rates — must land in one pass with the crossover recomputed and TESTS.md §D's pinned value updated |
| 3 | R5, R7(a) visibility | Tighten the validator's rates. R5 sits on the same causal chain as R1 (false rejection → re-dispatch → budget consumed), and only pays off fully once R1 is fixed |
| — | v0.1.3 cross-session bootstrap (as planned) | Depends on none of the above; can run in parallel with batches 1–3 |
| 4 | F1 retrieval quality | Must land before v0.1.4 |
| — | R7(b), budget-threshold calibration | Measurement items, kept out of the batches: decide once there is data |
| — | v0.1.4 → v0.1.5 → v0.1.6 → v0.1.7 → v0.2 (as planned) | **2026-09-20**: v0.2 is rewritten per the new granularity as H0; v0.3 is split in two — **v0.3a (evidence persistence) is promoted to a prerequisite of H0, v0.3b (task board / pointer briefs) is a prerequisite of H1**; everything after follows the four milestones in "Direction reset" |

### Decided (2026-09-12)

**① R1 adopts "wrap-up budget" semantics.** Following the common practice of other tools with hard quotas: *before* hitting the limit, wrap up the work in hand — produce a complete reply plus an updated brief, and leave a hook in the brief's "Progress / Open questions" sections so the next baton can pick it up — and **slightly overrunning the budget in order to finish the wrap-up is allowed**. This is the same thing PROTOCOL §2.1 already states: "hitting the cap is not discarding: first persist what matters per Invariant 4 and write the progress into the brief; the next baton continues from the brief." **So R1 needs no protocol change — it is §2.1's promise never having landed in v0.1.** §2.1 describes the cap as "2 log lookups + 1 re-dispatch", but in the code those three call types share a **single** counter, so 2+1 can never happen at once, and exhausting the budget throws instead of wrapping up.

Two implementation consequences:

- The budget splits into a **work allowance + a wrap-up reserve**; the reserve must not be consumed by normal working rounds (otherwise there is never budget left for the wrap-up).
- **Corollary (to confirm at implementation time)**: once wrap-up semantics land, the throw path largely disappears; for genuinely failed batons (the model repeatedly returning unparsable output), **the user's message still goes into the log** — the user really did say it, and the archive should not have holes. What is not recorded is the baton's output (reply / handoff unchanged). This removes the conflict between §5's archive promise and §6's "a failed baton never existed" (which refers to outputs).

**② R7 splits in two.** (a) Visibility — the fallback result and its `validation` errors must be visible on the panel — depends on no data and ships with batch 3; (b) whether the fallback should also retry once waits until real-world rates for fallbacks and validator rejections are observed.

**③ F1 boundary confirmed.** Both the stop-word list and log-prefix exclusion sit inside the safe zone of "no vector database"; F1 is implemented within that boundary.

### Decided (2026-09-20, direction reset)

The three decided rules (granularity / stage-level review / self-improvement batons) and their consequences are fully defined in the "Direction reset" section at the top. Two conclusions relevant here: **R1 is structurally dissolved by H0** (not fixed — it ceases to exist); and **the "crossover at baton 35" is to be recalibrated after H1**, until which the pinned value in TESTS.md §D is a stale rate.

### Remaining, to be calibrated empirically

Out of scope for this round's decisions; settle once real session data exists: the per-baton log-lookup cap, the re-dispatch cap, **the wrap-up reserve's share of the total budget** (i.e. how much overrun is tolerated), and R7(b). **Added 2026-09-20**: the task-level baton cap, the per-task cost cap, **the self-improvement baton's quota share** (start at 10–15%), and the maximum artifact volume of a stage (the concrete bound behind "a review baton's input stays bounded" in rule two).

## What we will not do

- No vector database: the retrieval need is "find that one thing someone said" — n-gram suffices; leave the complexity to the substrate
- ~~No parallel batons: relay is serial by semantics; parallelism belongs to another protocol~~ → **Lifted (2026-09-20)**: parallelism is the definition of a hive; write conflicts are instead constrained by a **static check** that batons' `write_target`s are disjoint ("Direction reset", H1)
- No streaming output: emitting the complete JSON in one shot is the precondition for the salvager to work; we'd rather wait
- No behavioral constraints at the prompt layer (when the substrate validator can express them): rules live in the harness, not the prompt — models cheat, scripts don't
- **No decision model replacing the substrate validator** (added 2026-09-20): the decision layer may only take on "finite-option judgments that scripts cannot express", and its output must be persisted to the substrate log; the commit condition of baton-level transactions remains a script, always
- No special-case code for a single track: any new feature must serve ≥2 tracks (PURPOSES §9); single-track requests go to the backlog freezer
