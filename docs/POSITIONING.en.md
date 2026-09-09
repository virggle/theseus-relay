# Positioning · Boundaries Against Kindred Architectures

[中文](POSITIONING.md) | **English**

> Theseus Relay was not invented in a vacuum. It and several known schools attack different facets of the same problem — **context rot**: long sessions grow more expensive, dumber, and more forgetful as the context window fills. This document states clearly where we each stand, and what we borrowed from whom.

## One-line positioning

**Ralph Loop solves "the task doesn't fit in one go"; Theseus solves "the conversation goes stale as it goes long".** The core wager is the same — fresh context + externalized state > one ever-bloating session — but the philosophy of the memory carrier is opposite: Ralph says "disk is state"; Theseus says "the linguistic compression is state". After v0.3 substratization, the two converge on "disk is state".

## Comparison table

| Dimension | Theseus Relay | Ralph Loop (Huntley, 2025-07) | Claude Code `/compact` | Multi-agent handoff (Swarm-style) | LangGraph checkpointer |
|-----------|--------------|-------------------------------|------------------------|----------------------------------|------------------------|
| Driving signal | Each user message = one baton (conversation-driven) | The same PROMPT.md re-run until done (task-driven) | Context nearing the ceiling (passive trigger) | Division of labor (topology-driven) | Graph node execution (flow-driven) |
| Memory carrier | The brief (linguistic compression, lossy, quality guaranteed by protocol) | Disk (git / plan.md / the code itself, lossless) | In-session summary (implicit, no quality guarantee) | Raw context or free text | Graph state (structured, flat) |
| Transmission protocol | Structured schema + mechanical validation + append-only | None; conventionally-agreed files | None | No schema; free semantics | No semantic layering |
| Information-loss model | Explicit: lossy budget + discard priority | Implicit: disk assumed lossless | Implicit: compaction is a side effect | Undefined | Undefined |
| Fault isolation | Baton-level transactional semantics (a failed baton never existed) | Iteration-level (rerun; git rollback) | None | Agent-level (weak) | Node-level |
| Quality assurance | Mechanical validator + deterministic quality gates + review baton | Backpressure (tests / quality gates) | None | The orchestrator | Node retry |
| Reviewer | Structurally unbiased (never saw the writing process) | No independent reviewer | None | Orchestrator is biased | None |

## Each one's real contribution

- **Ralph Loop**: proved the brute-force viability of "a bare loop + disk state". The thing worth copying is not the loop but **where the discipline is placed** — rules live in the harness, not the prompt; state lives on disk, not in the model; failure modes (iteration / cost / time caps) are all observable.
- **`/compact`-style compaction**: defined the problem (context rots) but treats compression as a side effect. Theseus's increment: **promote compaction from side effect to a first-class protocol citizen** — schema, an append-only decision ledger, anti-placeholder rules, mechanical validation, all aimed at taming compression-quality variance.
- **Multi-agent handoff**: passes raw context or free text, with no strong semantics of "the previous baton is dead; only a compression survives". Theseus's invariant "the brief is the only transmission medium" is far stricter.
- **LangGraph checkpointer**: shares the externalized-state idea (stateless executor, persistent state), but all state is created equal. Theseus makes the sacrifice order explicit when discarding (progress < open questions < profile < decisions) and grants the decision ledger "most sacred" status — it is the protocol's immune system.

## What we took from Ralph (already landed in the protocol / roadmap)

1. **Deterministic backpressure** (ROADMAP v0.2): quality gates (tests/lint/build) before the LLM review baton. Zero tokens, zero bias, run every time.
2. **Rules sink into the substrate** (PROTOCOL §4 validator): anti-placeholder demoted from prompt level to script level — Decisions/Profile item counts must not decrease; the substrate can diff and reject.
3. **Separation of invariants from mutable state** (Ralph's PROMPT.md never participates in compression): protocol rules and persisted decisions stay out of the lossy compression stream; the brief carries only pointers + increments.
4. **Observable failure modes** (ROADMAP v0.2 budget & oscillation detection): baton/cost caps + decision-oscillation detection — the same option rejected then re-proposed is the relay equivalent of Ralph's loop spinning, and can be mechanically alerted on.

## What Ralph cannot give; we must build ourselves

- **The brief-schema validator**: Ralph has no transmission protocol and therefore no validation problem. Our validator is the commit condition of baton-level transactions.
- **A compression-quality metric**: periodically spot-check recall of "substrate ground truth vs. current brief", turning long-horizon decay from a confession into an observable metric. This is the inherent tax of the prose-memory route over the disk route — Ralph never pays it, so there is no homework to copy.

## Relationship in one line

Ralph is the brute-force aesthetics of "keep the loop running"; Theseus is the protocol engineering of "lose nothing in every handoff". The latter is harder — and precisely because it's hard, if it works, cross-model cost scheduling (v0.5) is a capability no bare loop can offer.
