# Purpose Matrix

[中文](PURPOSES.md) | **English**

> The Theseus protocol serves six independently valid value tracks at once. This document defines each track, its proof metric, and its current evidence status. Multi-purposing is not six features — it is six readings of one protocol: the brief is simultaneously a cost control, an audit artifact, a transaction log, and a memory carrier. Design discipline: **any new feature must serve at least two tracks, or it goes into ROADMAP's "What we will not do".**

## 1. Track overview

| Track | One-line claim | Proof metric | Current status |
|---|---|---|---|
| **P1 Cost** | Bounded input cost in long sessions; the advantage grows with history | Cost double-ledger (ROADMAP v0.1.2) | Partially holds: wins long sessions, loses short ones |
| **P2 Stability** | Fresh context: turn 1 and turn N at the same quality | retention_rate (v0.1.4) + dual-track benchmark (v0.1.6) | Hypothesis, unproven |
| **P3 Audit** | Every handoff is a human-readable, reviewable artifact | Live panel (implemented) + per-baton telemetry (v0.1.2) | Implemented, telemetry pending |
| **P4 Transactions** | A failed baton never existed; decisions are append-only | Validator rejections and rollback events (v0.1.1, v0.4) | Defined in protocol, validator pending |
| **P5 Scheduling** | Each baton independently picks its model; cost/capability on demand | Routing table (v0.1.7) → cross-model relay (v0.5) | Long-term vision; toy preview |
| **P6 Persistence** | The brief chain = cross-session personal memory | Decision/profile retention after cross-session import (v0.1.3) | Prototype (brief schema); entry point pending |

Track IDs are the reference symbols: every ROADMAP rung is annotated with "Tracks served", pointing back to this table.

## 2. P1 Cost — bounded input that gets cheaper as history grows

**Mechanism**: relay input is constant per turn (one brief + one message); monolithic input grows linearly with history. The per-baton fixed overhead (output tokens for brief regeneration, salvage fallback calls) does not scale with history — that is the price of boundedness.

**Quantitative intuition** (mainstream frontier pricing, 90% prefix-cache hit assumed): the cost crossover sits around the ~10K-token mark; beyond it the advantage grows monotonically with history. Exact numbers float with price lists; v0.1.2's cost double-ledger gives live figures, and this document does not pin them down.

**Where it wins**: long sessions, local small models (no prefix-cache pricing), endpoints without cache discounts.

**Honest boundary**: short sessions (single-digit K tokens) do not favor relay — the fixed overhead has not yet been amortized by history length. The double-ledger shows wins and losses as they are; losing honestly is where this track's credibility comes from.

## 3. P2 Stability — a structural defense against context rot

**The problem**: long sessions get more expensive, dumber, and forgetful as context fills up (context rot). Attention dilution is an architectural phenomenon; a model's implicit compression (recurrent state, internal memory) has its own decay curve — just an unobservable one.

**The claim**: relay lets every baton work in fresh context — baton 1 and baton 500 see structurally identical model states. Protocol compression (the brief) also decays, but it is **observable and intervenable**: the decay probe (v0.1.4) measures decay; L2 packing (v0.1.5) intervenes. The essential difference between the protocol route and model-internal compression is not "no decay" — it is **controllable decay**.

**The proof**: the dual-track benchmark (v0.1.6) — same questions, two tracks, quantifying "the fresh-context quality advantage at turn N".

## 4. P3 Audit — what the model will never give you

A model's internal state is invisible and unreviewable. Theseus lands everything auditable on a human-readable substrate: the brief chain (a complete snapshot of every baton's input), log-lookup behavior, degradation and salvage markers, telemetry (token/latency/model dimensions from v0.1.2 on). Every handoff is a checkpoint: any turn's decisions trace back to that baton's complete input — not log analysis, but a protocol guarantee.

## 5. P4 Transactions — the protocol's immune system

A failed baton never existed (the brief still points at the last successful baton; rollback is recovery); the decision ledger is append-only, preventing later batons from re-proposing rejected options. Today these guarantees rest on prompt self-discipline; the v0.1.1 substrate validator turns the mechanizable parts into script-level determinism — a brief that fails validation is as if it had never existed. v0.4 baton-level transactions complete the commit/rollback semantics.

## 6. P5 Scheduling — model proliferation is the protocol's dividend

The model market is diversifying: some offer 1M windows, some 32K; some are cheap, some strong. For a monolithic architecture that is a compatibility burden; for the relay protocol it is scheduling space — chore batons on cheap models, critical batons on strong ones (v0.5), with bandwidth tiers (v0.1.5) letting one protocol assign different input tiers per recipient. The v0.1.7 routing table is the toy preview.

## 7. P6 Persistence — dynamic memory the model cannot absorb

Frontier models are pulling static-knowledge lookup, in-session state, and in-window retrieval back inside the architecture; but in-architecture memory is either frozen after training (lookup tables) or valid only within a session (recurrent state). User preferences, project state, and cross-session decisions are dynamic — they can only live outside the model. The brief chain is precisely their portable carrier: human-readable, model-agnostic, exportable (v0.1.3), versionable (v0.5).

## 8. Relation to model-architecture progress

The impact on the six tracks is asymmetric:

| Impact | Tracks | Reason |
|---|---|---|
| Unaffected | P3, P4, P6 | Audit, transactions, and dynamic memory structurally live outside the model |
| Appreciates | P2, P5 | No model strength eliminates the value of fresh context; proliferation widens scheduling space |
| Needs re-anchoring | P1 | Re-anchored from "saving tokens" to "bounded in long sessions" — see §2 |

## 9. Design discipline

1. Any new feature must serve ≥2 tracks, or it is not built. E.g., bandwidth tiers serve P1/P2/P5; the decay probe serves P2/P6
2. Every track's proof metric must land in the panel or the benchmark — tellable stories do not count
3. When tracks conflict, trade off in the order: protocol reliability > observability > cost
