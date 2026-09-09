# Relay Protocol v0.1

[中文](PROTOCOL.md) | **English**

> The heart of Theseus Relay is not the chat UI — it is this protocol: **stateless workers + a stateful protocol**. Any model, any runner that implements it can join the relay. This document is the thread that leads "from chatbox to harness".

## 1. Participants

| Role | Lifecycle | What it sees |
|------|-----------|--------------|
| **Batons** | One user message is one lifetime; destroyed after answering | ① The previous baton's *Brief* ② The user's current message ③ (bounded) retrieved history fragments |
| **Substrate** | Immortal | The complete log, all historical briefs, the retrieval index |
| **User** | God's-eye view | Full log + backstage panel (every baton's input/output/retrieval fully auditable) |

**Core invariant: the Brief is the only transmission medium between batons.** Whatever the brief loses is lost for real — all engineering effort in this system serves one goal: let what should survive survive, and let what should die die quickly.

## 2. Turn Contract

A turn must complete three things in order. None may be skipped:

```
1. READ   Take in the brief + the user's message (this is the baton's entire world)
2. ACT    Answer the user (may first run one bounded retrieval: {"action":"read_log","query":"…"})
3. WRITE  Output the updated brief (cumulative compression, not a this-turn recap)
```

The wire format is a single JSON: `{"reply": "...", "handoff": "..."}`. When model output is corrupted the substrate salvages it (see §6), but the contract with the model is always: emit the complete thing in one shot.

## 3. Brief Schema

A fixed four-section structure; every generation must output all of it:

```
## Progress       compressed context of everything so far + this generation's new progress
## Decisions      settled conclusions, rejected options and why — append-only
## User profile   communication style, background, what they care about — merged update
## Open questions resolved ones cleared out, new ones added
```

### Four hard invariants

1. **Cumulative compression**: the brief = a compressed retention of whatever in the previous brief is still relevant + this generation's additions. It is never a "this-turn recap".
2. **No meta-comments**: "(previous conclusions retained)", "same as above", "omitted" are protocol-level violations — the substrate cannot see the previous brief, so a placeholder is information destruction. Decisions and profile must be written out item by item in full; verbatim repetition of the previous brief is acceptable.
3. **Lossy budget**: hard cap on total length (currently 800 characters), with discard priority: `progress detail < open questions < user profile < decisions & constraints`. **Decisions are the most sacred section** — they are the protocol's immune system (they stop later batons from re-proposing rejected options).
4. **Persist first, pointers are disposable**: disposability is determined by "is it persisted to the substrate" — **not by on-the-spot judgment**. Anything already persisted appears in the brief as a one-line pointer and may be dropped at any time (the substrate can restore it; losing it costs nothing). Anything not persisted is the only copy and must stay in the brief. This implies an obligation on every WRITE: **new decisions/constraints that matter must be persisted first, then compressed.**

Invariant 4 is the bridge from prose briefs to pointer briefs (ROADMAP v0.3): it turns "what may I drop when compressing" from an on-the-spot model judgment (a source of variance) into a mechanically executable rule — persisted, feel free to drop; not persisted, never drop.

## 4. Substrate Validation (the mechanical layer)

Prompt constraints are the first line of defense, not the only one. The substrate mechanically validates every incoming brief and **rejects it on failure** (it goes through the §6 salvage pipeline for rewriting):

| Check | How it's decided |
|-------|------------------|
| Four sections present | Heading structure match |
| No placeholders | Meta-comment regex ("same as above", "omitted", "previous conclusions retained", etc.) |
| Within budget | Total length ≤ current cap |
| Decisions append-only | Diff against the previous brief: item counts in Decisions and User profile must not decrease |
| Pointers valid | Persistence pointers produced under Invariant 4 must reference substrate paths that actually exist |

Principle: **any rule that can live in the substrate does not stay in the prompt.** Models cheat (§8's field-tested traps are all documented model cheating); scripts don't. The validator is also the commit condition of baton-level transactions — a brief that fails validation effectively never existed.

## 5. External Memory Retrieval (Log-as-Memory)

The full log never automatically enters any baton's context. A baton may retrieve on demand via the log-lookup action:

- At most 2 lookups per baton, at most 8 hits per lookup (plain n-gram scoring suffices; no vector store needed)
- Retrieval results arrive as a "system injection" that states plainly: *these are fragments only — you still cannot see the full record*
- Semantics: **the log is an archive, not working memory**. Retrieval is a searchlight, not the lights coming on

## 6. Failure Semantics

| Failure | Substrate behavior |
|---------|-------------------|
| JSON broken but reply is salvageable | Salvage the body, mark `salvaged`, rebuild the brief via a separate summarization call |
| JSON entirely unparseable | Treat the whole output as reply, rebuild the brief via a separate summarization call |
| reply + brief truncated by length | maxTokens must cover reply + brief combined; truncation is the salvager's fallback |
| Model procrastinates ("I'll get to that later") | Banned at prompt level: reply and brief must both be completed this turn |
| Brief fails §4 mechanical validation | Reject, mark `rejected`, re-dispatch once with the validation errors attached; if it fails again, fall back to a separate summarization call |
| Decision oscillation (a rejected option re-proposed) | Detectable by diffing the decision ledger history: same option rejected then re-proposed → alert, and inject the original rejection rationale into the next baton |
| Whole baton fails | That baton never existed — the brief still points to the last successful baton. **Baton-level transactional semantics hold by construction** |

## 7. Why this is the seed of a harness

The current implementation is "conversation relay", but the protocol already contains every element of a harness, missing only five extension points:

1. **Substrate validator (v0.1.1)**: the five checks of §4 move from paper into code — the smallest possible increment, yet the foundation of all mechanical trust that follows
2. **Tool batons (v0.2)**: the ACT phase may call tools, and a **side-effect ledger** must be written into the brief ("which irreversible operations this baton performed") — the precondition for stateless workers to do real work safely
3. **Substratization (v0.3)**: the brief degrades from prose to **pointers** (state-file paths, task-list IDs); real state lives on disk. The thinner the brief, the more stable the system. Invariant 4 is its protocol-level basis
4. **Deterministic quality gates (v0.2+)**: tool-baton output passes deterministic checks first (tests, lint, build — zero tokens, zero bias, run every time); LLM review only handles the semantics the gates can't reach. The order is not negotiable: **cheap deterministic checks before expensive probabilistic review**
5. **Review batons (v0.4)**: execution batons and review batons alternate. A review baton's review is genuinely unbiased — it structurally never saw the writing process, which no single-agent architecture can offer

A further implication: once the brief schema is versioned, **batons can relay across models and vendors** (baton A does chores on a cheap model, critical batons switch to a strong one) — cost scheduling becomes a protocol-layer concern.

## 8. Known limits (the honest list)

- Brief compression variance is high: different batons judge "what matters" differently; long-horizon information decay is unavoidable (this is a feature and a bug)
- Long-horizon decay is unmeasured: periodically run a recall spot-check of "substrate ground truth vs. current brief", turning decay from a confession into an observable metric (to be built → scheduled as ROADMAP v0.1.4 decay probe)
- Chinese 2-gram retrieval is low-fidelity: fine for a demo, not for production
- 2–3 LLM calls per baton (answer + salvage fallback) — more expensive than a single continuous-agent conversation. What you buy is bounded context and auditability
- The "2 lookups per baton" quota was once misread by a model as requiring user approval — tool semantics must be nailed down in the prompt
