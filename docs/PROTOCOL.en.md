# Relay Protocol v0.1

[中文](PROTOCOL.md) | **English**

> The heart of Theseus Relay is not the chat UI — it is this protocol: **stateless workers + a stateful protocol**. Any model, any runner that implements it can join the relay. This document is the thread that leads "from chatbox to harness".

## 1. Participants

| Role | Lifecycle | What it sees |
|------|-----------|--------------|
| **Batons** | One handoff is one lifetime: destroyed after emitting "a set of tool calls + a brief" | ① The previous baton's *Brief* ② This baton's driving input (a user message **or** the previous tool call's return value) ③ (bounded) retrieved history fragments |
| **Substrate** | Immortal | The complete log, all historical briefs, the task board and the retrieval index |
| **User** | God's-eye view | Full log + backstage panel (every baton's input/output/retrieval fully auditable) |

**Core invariant: the Brief is the only transmission medium between batons.** Whatever the brief loses is lost for real — all engineering effort in this system serves one goal: let what should survive survive, and let what should die die quickly.

## 2. Turn Contract

A turn must complete three things in order. None may be skipped:

```
1. READ   Take in the brief + this baton's driving input (this is the baton's entire world)
2. ACT    Emit a set of tool-call requests {"calls":[{tool,args},…]}, or degrade to a reply {"reply":"…"} in the chat scenario (v0.1's bounded retrieval {"action":"read_log","query":"…"} belongs to the calls semantics)
3. WRITE  Output the updated brief: cumulative compression + next intent, not a this-turn recap
```

The wire format is a single JSON: tool batons use `{"calls":[…], "handoff": "…"}` (see §2.2), chat batons use `{"reply": "...", "handoff": "..."}`. When model output is corrupted the substrate salvages it (see §6), but the contract with the model is always: emit the complete thing in one shot.

## 2.1 Baton boundaries: information-driven (rewritten 2026-09-20)

ACT produces only two things: **a set of tool-call requests** and **a brief**. A single baton may emit several calls at once; whether to hand off between calls has one criterion only:

> **Does the next action depend on some tool call's return value?** If yes → stop here, write the brief, and hand off; a fresh baton takes the stage carrying the return value. If no → emit the whole batch inside this baton; do not open a baton per call.

This replaces v0.1's criterion ("was the context rebuilt from zero") and, with it, the in-baton ReAct loop — there are no more repeated "think → act → observe" round trips inside one baton. The new criterion needs no runtime measurement: it is **static**. Look at whether the calls depend on each other and you know whether to stop.

**A whole set of governance parameters becomes void** (all v0.1): the in-baton loop cap (6 tool round trips), the context budget (60% of the model window), the per-baton wall clock (90 s), dead-loop detection, and the "work allowance + wrap-up reserve" split. No in-baton loop means no need for quantities that had to be calibrated empirically.

### Two kinds of return values

| Kind | Examples | What the substrate does |
|------|----------|-------------------------|
| **Ack-type** | Write success/failure, exit codes, rows affected | Aggregate into one line of the next brief, e.g. "3 writes: 2 ok, 1 EACCES" — **do not open a baton per acknowledgement** |
| **Info-type** | Search hits, file contents, error details | This is "new information": it triggers the handoff, and the next baton carries it |

### Two hard clauses that follow

1. **Write-target declaration**: every write must have an identifiable target (statically derivable from the tool signature, or declared explicitly as `write_target` on the task card). When several batons run concurrently, their write targets must be disjoint; the substrate checks this **statically** and a detected conflict fails immediately. This check is deterministic and **belongs to the script layer** — not to a decision model, and certainly not to a generative LLM (see §7 for the hierarchy).
2. **The only loop left inside a baton**: the substrate's validator re-dispatch (§4 / §6) is mechanical repair, not a ReAct loop, so this section does not constrain it — but it still needs a cap (see ROADMAP §4, pending revisions).

### The brief's semantics shift

Once a baton no longer spans tool calls, it no longer carries "what I did over these dozen steps" but **what comes next, why, and on what evidence**. The brief thus moves from "compressed history" toward an **intent packet**: history belongs to the task board and the substrate, while the brief keeps only "pointers + intent + the decision ledger". The four invariants of §3 are unchanged, and matter more than ever — **anything that exists only inside a brief dies the moment the baton hands over.**

### How this section evolved

v0.1's criterion was "was the context zeroed": it allowed in-baton ReAct loops bounded by the four parameters above, and that promise never fully landed in v0.1. Switching to the static information-dependency criterion does not tune those four parameters — it removes the need for them, and defects of that class disappear from the code rather than being fixed.

## 2.2 Tool-Baton Contract (H0)

The tool baton is the §2 turn contract made concrete for task scenarios. The ACT wire format:

```
{"calls":[{"tool":"search_files","args":{"dir":"docs","pattern":"budget"}}, …], "handoff":"…"}
```

One baton, one action: **either emit a batch of calls, or give an answer** — never both. `calls` and `reply` are mutually exclusive — there is no "call first, get the result, then answer" round trip inside a baton.

### Minimal tool set (H0)

| Tool | Signature | Return kind |
|------|-----------|-------------|
| `search_files` | `{dir, pattern}` (substring match, case-insensitive) | Info-type: list of hit lines |
| `read_file` | `{path, offset?, limit?}` (by line, first 100 by default) | Info-type: file content |
| `write_file` | `{path, content}` | Ack-type: success/failure |

Paths are always relative to this session's **workspace** (`data/workspace/<sid>/`); absolute paths and escaping paths (`..`, drive letters) are rejected by the substrate — path guarding belongs to scripts, not prompts.

### Permissions and side effects

- **Permissions granted per baton**: the substrate passes in a whitelist of tools this baton may use (all three open by default in H0); an out-of-scope call is not executed and returns a denial acknowledgement (ack-type, aggregated into the next baton).
- **Write targets must be identifiable**: the `path` of `write_file` **is** the `write_target`, statically derivable from the tool signature, and is booked item by item by the substrate (the single-chain form of §2.1 hard clause 1; the concurrency disjointness check waits for H1).
- **Side-effect ledger**: the fifth brief section "Side effects" lists this baton's irreversible operations item by item, or "none". The **actual** write record held by the substrate is injected into the next baton alongside the return values, cross-checking the baton's own declaration.

### Long outputs persist to the substrate (v0.3a)

When a tool output exceeds the threshold (currently 1000 characters), the substrate persists the full text as an artifact (`data/artifacts/<sid>/…`) and the baton sees only a **summary + a `->` pointer**. Thus "bounded context" does not break on tool batons: no baton's context contains the raw text of a long tool output. Pointer validity is guarded by the §4 validator. A baton that needs details re-reads them with `read_file` in segments — that retrieval is itself an info-type return and triggers a handoff as usual.

### Handoff reasons (auditable)

When each baton on the chain leaves the stage, the substrate records a mechanically decidable handoff reason: `reply` (an answer was given, chain ends) | `info-return` (an info-type return drives a new baton) | `ack-aggregate` (aggregated acknowledgements handed over) | `budget` (task-level budget reached, wrapping up). The panel shows calls, return classifications and handoff reasons step by step — this is where P3 audit lands on the chain.

## 3. Brief Schema

A fixed five-section structure; every generation must output all of it:

```
## Progress       compressed context of everything so far + this generation's new progress
## Decisions      settled conclusions, rejected options and why — append-only
## User profile   communication style, background, what they care about — merged update
## Open questions resolved ones cleared out, new ones added (incl. next intent: what to do + on what evidence)
## Side effects   this baton's irreversible operations, item by item; "none" if empty (§2.2)
```

### Four hard invariants

1. **Cumulative compression**: the brief = a compressed retention of whatever in the previous brief is still relevant + this generation's additions. It is never a "this-turn recap".
2. **No meta-comments**: "(previous conclusions retained)", "same as above", "omitted" are protocol-level violations — the substrate cannot see the previous brief, so a placeholder is information destruction. Decisions and profile must be written out item by item in full; verbatim repetition of the previous brief is acceptable.
3. **Lossy budget**: hard cap on total length (currently 800 characters), with discard priority: `progress detail < open questions < user profile < decisions & constraints`. **Decisions are the most sacred section** — they are the protocol's immune system (they stop later batons from re-proposing rejected options).
4. **Persist first, pointers are disposable**: disposability is determined by "is it persisted to the substrate" — **not by on-the-spot judgment**. Anything already persisted appears in the brief as a one-line pointer and may be dropped at any time (the substrate can restore it; losing it costs nothing). Anything not persisted is the only copy and must stay in the brief. This implies an obligation on every WRITE: **new decisions/constraints that matter must be persisted first, then compressed.**

Invariant 4 is the bridge from prose briefs to pointer briefs (ROADMAP v0.3): it turns "what may I drop when compressing" from an on-the-spot model judgment (a source of variance) into a mechanically executable rule — persisted, feel free to drop; not persisted, never drop.

**Intent-packet addendum (2026-09-20)**: after §2.1, the brief must also carry "intent not yet redeemed" — a batch of calls is emitted before its return values exist, so what gets written here is "what comes next, and on what grounds". Intent is not yet a decision: it goes into "Open questions" first, and is promoted into "Decisions" only once it is redeemed and settled.

## 4. Substrate Validation (the mechanical layer)

Prompt constraints are the first line of defense, not the only one. The substrate mechanically validates every incoming brief and **rejects it on failure** (it goes through the §6 salvage pipeline for rewriting):

| Check | How it's decided |
|-------|------------------|
| Five sections present | Heading structure match (Progress / Decisions / User profile / Open questions / Side effects) |
| No placeholders | Meta-comment regex ("same as above", "omitted", "previous conclusions retained", etc.) |
| Within budget | Total length ≤ current cap |
| Decisions append-only | Diff against the previous brief: item counts in Decisions and User profile must not decrease |
| Pointers valid | Persistence pointers produced under Invariant 4 must reference substrate paths that actually exist |

**Implemented (v0.1.1)**: `src/validate.js` turns the five checks above into the pure function `validateHandoff(brief, { prevHandoff, exists })` — no IO except the pointer check — returning `{ ok, errors[], checks }`. Two definitions are fixed here: length = non-whitespace character count ≤ 800; pointer syntax = `-> relative/path` (currently a conditional check: no pointer in the brief means pass; it becomes active once v0.3 persistence rules land).

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

## 7. The decision layer and its rank

The high-frequency judgments between batons (how many batons to dispatch, whether an error means retry or re-dispatch, whether results are complete) do not need generated text. This layer sits between two extremes:

- **Anything expressible as a deterministic rule must stay in scripts** — for instance, whether batons' `write_target`s intersect (§2.1 hard clause 1)
- **Real content generation still belongs to LLMs**
- The middle band of "finite options + non-determinism" belongs to **decision-specialized models that return only a probability distribution over candidates**, placeheld by a rule stub at first and swapped in later

Two disciplines: **it must not replace §4's substrate validator** (that is the commit condition of baton-level transactions and must always remain a script); **every decision's output, probabilities included, must be persisted to the substrate log** — which makes this layer serve both P1 Cost and P3 Audit.

A further implication: once the brief schema is versioned, **batons can relay across models and vendors** (baton A does chores on a cheap model, critical batons switch to a strong one) — cost scheduling becomes a protocol-layer concern. The staged path is in ROADMAP ladder two.

## 8. Known limits (the honest list)

- Brief compression variance is high: different batons judge "what matters" differently; long-horizon information decay is unavoidable (this is a feature and a bug)
- Long-horizon decay is unmeasured: periodically run a recall spot-check of "substrate ground truth vs. current brief", turning decay from a confession into an observable metric (to be built → scheduled as ROADMAP v0.1.4 decay probe)
- Baton count and fixed overhead grow together: with the granularity now "a set of mutually independent calls = one baton", the same task splits into more batons, and each pays the fixed cost of "read a brief + write a brief". **The crossover figure pinned by this §8 and by TESTS.md §D was calibrated under the old granularity; it is void — do not cite it until recalibrated** (recalibration is scheduled after H1 in ROADMAP ladder two)
- Chinese 2-gram retrieval is low-fidelity: fine for a demo, not for production
- 2–3 LLM calls per baton (answer + salvage fallback) — more expensive than a single continuous-agent conversation. What you buy is bounded context and auditability (since v0.1.2 this is no longer a confession: the panel shows the simulated monolithic spend live — short sessions really are more expensive). That rate carries two pending revisions, see R3 / R4 in ROADMAP §4
- The "2 lookups per baton" quota was once misread by a model as requiring user approval — tool semantics must be nailed down in the prompt
- Concurrent batons cannot perceive each other: their write targets must be statically disjoint (§2.1), but races of the "the world I read has expired" kind (another baton concurrently modified the same region) still have no protocol-level answer — left to H1 for empirical work
