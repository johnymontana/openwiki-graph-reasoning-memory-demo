# OpenWiki × Neo4j Reasoning Memory — Adversarial Review

**Date:** 2026-08-19 · **Subject:** `openwiki-graph-reasoning-memory-demo` @ `bda8f5a` (initial commit)
**Scope of review:** feasibility, integration scope, general usefulness, alternative integration patterns, and an adversarial pass over the code, schema, docs, and every upstream claim.

---

## Verdict

**Will this approach work? Yes — mechanically it already does, and this review could not break the core claims.** The full check suite passes locally (typecheck, 92 unit/integration tests, coverage gates, build, and E2E against a loopback OAuth + Streamable-HTTP MCP server). Every upstream citation in the docs was verified against the actual OpenWiki source at the pinned commit, the Neo4j Agent Memory code, the Aura Agent docs, and the LangGraph JS source — and all of them checked out, which is rare and materially raises confidence in this codebase.

The risks are structural, not mechanical:

1. **The capture seam is already broken against OpenWiki `main`.** The patch applies cleanly to the pinned v0.3.3 commit but fails against today's `main` (verified by `git apply --check`), and upstream merged a change (#660) that removes the `messages` stream mode for openai-compatible providers — which would silently empty this project's outcome capture. v0.3.3 is still the latest *release*, so nothing is broken for users today, but the first upstream release will strand the patch. The CI patch-check job cannot detect this because it only checks against the pinned commit.
2. **Recall has no repository scoping**, so the moment traces from a second repo are ingested, `find-reasoning-for-task` starts returning cross-repo noise and `Tool` reliability stats blur across projects. This is the single biggest gap between "works" and "useful."
3. **The value thesis — that recalled traces improve later runs — is unproven and unmeasured.** The write path is solid observability; the read path is a hypothesis with no eval harness behind it.

Bottom line: ship it as what it demonstrably is today — **graph-native observability for OpenWiki runs plus a working Aura Agent/MCP recall showcase** — and treat "memory makes future runs better" as the next experiment, not a current claim.

---

## How this review was conducted

- Read the entire repo (all source, tests, configs, scripts, patch, docs).
- Executed `npm ci && npm run check` (all layers green; ~85% statement coverage enforced) and `npm run demo` (translation, redaction, ordering verified by output).
- Fetched OpenWiki at the pinned commit `60aada6` and at `main` (`ea80ddc`, pushed today); ran `git apply --check` on the patch against both; diffed the three patched files.
- Three independent fact-checking passes against primary sources: OpenWiki source/releases/npm, `neo4j-labs/agent-memory` code + docs, Aura Agent docs (`neo4j/docs-aura`), `neo4j-cli` source, LangGraph JS source + docs, plus **empirical streaming/tracing experiments** on `@langchain/langgraph` 1.4.11 and `langsmith` 0.8.12 (namespace shapes, `tools`-mode payloads, env-only LangSmith export, OTel export paths).

---

## 1. Feasibility

### What demonstrably works

| Component | Status | Evidence |
| --- | --- | --- |
| Trace recorder (public + raw + plan paths) | Works | 476-line test suite; `npm run demo` output correct (redaction, plan-first ordering, scoped IDs) |
| Neo4j store (atomic, idempotent) | Works | Transaction-level tests; live Neo4j 5 test in CI; parameterized Cypher throughout |
| Reasoning-only schema boundary | Holds | Only 4 labels/3 relationship types referenced anywhere; enforced by a graph-type allowlist test |
| Aura Agent config + MCP client + token cache | Works | E2E test does the full `initialize → tools/list → tools/call` sequence against a loopback server; token cached through `expires_in` with a 30s window |
| Patch vs pinned OpenWiki | Applies cleanly | `git apply --check` against `60aada6` — pass |
| Patch vs OpenWiki `main` | **Fails** | `error: patch failed: src/agent/index.ts:133` against `ea80ddc` (2026-08-19) |

### The load-bearing assumptions, checked

Every claim below was verified against primary sources this week. This matters because the whole design rests on undocumented upstream internals.

| Claim in this repo | Verdict |
| --- | --- |
| `OpenWikiRunEvent` union shape (`text`/`tool_start`/`tool_end`/`debug`); `onEvent` in run options | **Confirmed** verbatim at `src/agent/types.ts:10-44` @ pin; `types.ts` is byte-identical on `main` |
| Public `tool_end` omits tool output and error body (lossy-fallback table) | **Confirmed** — upstream `parseToolStreamEvent` projects only `{id, name, status}` |
| `namespace.length > 1 ⇒ subgraph` classification | **Confirmed correct** — matches upstream's own parser *and* LangGraph semantics: for `messages`/`tools` chunks the namespace always carries a `node:taskId` segment at root (root = length 1, subgraph = length 2+), verified empirically on langgraph 1.4.11. Caveat: this rule is only valid for `messages`/`tools` modes — `updates`-family chunks use root = `[]`, first-level subgraph = length 1 |
| `tools` stream-mode payload contract (`on_tool_start/end/error`, `toolCallId`, `input`, `output`) | **Confirmed** — matches `StreamToolsOutput` in langgraph `pregel/types.ts`; recorder correctly prefers `output` over `result` |
| Repository-mode connector gate returns `[]` (and shouldn't be removed) | **Confirmed** at `src/connectors/tools.ts:24-34`, with an upstream comment marking it a deliberate security boundary (#444) — the docs' warning against removing it matches upstream intent |
| Custom-MCP connector: `${VAR}` header substitution, literal-credential rejection, `allowedTools` | **Confirmed** in `src/connectors/mcp-client.ts` (throws `"Header … must reference credentials with ${ENV_VAR}, not a literal value"`) |
| `_plan.md` lifecycle (created by prompt, auto-deleted on success and error) | **Confirmed** (`prompts/code.ts:239-243`, `utils.ts:225-244`) |
| agent-memory graph model parity (labels, `HAS_STEP {order}`, property names, JSON-string metadata, status vocabulary) | **Confirmed** against `graph/queries.py` — including that this repo correctly followed the *code* (`status` enum, `step_number`) where agent-memory's own `reasoning.adoc` is stale (`success: bool`, `sequence`) |
| Aura Agent: external-only MCP, endpoint shape, token exchange + audience, **15 token requests/hr/client**, EU (`europe-west1`) routing, `cypherTemplate` camelCase, read-only tools | **All confirmed** in `docs-aura` / `neo4j-cli` sources. Aura Agent is GA (Feb 2026); external agents billed **$0.35/agent-hour** per the GA announcement — worth restating in the README's cost warning |
| Every `neo4j-cli` command and flag used in `scripts/` | **Confirmed** against the CLI source (`aura agent create` flags, `--atomic`, `toon` format, credential subcommands) |
| OpenWiki uses a SQLite checkpointer | **Confirmed**, with a nuance: on-disk persistence only for `chat`; `init`/`update` use `:memory:` |

Two claims deserve small doc corrections:

- The pinned commit `60aada6` is **2 docs-only commits past the `v0.3.3` tag** (`355f4f6`), not the tag itself. Harmless, but "targets v0.3.3 at commit 60aada6" should say so.
- `trace_error_kind_idx` is created but no code path ever writes `error_kind`. It's schema parity with agent-memory v0.5 — fine, but say that in `cypher.ts`, or start populating it (the recorder already distinguishes error/cancelled outcomes).

### Where it breaks first

**The embedding surface, not the schema.** The `openwiki` npm package is bin-only — no `exports`, no `main` (verified at the pin and on `main`). So *both* capture paths — even the unpatched public `onEvent` — require a source checkout or fork. The README admits this, but it means the true integration cost is "maintain a fork," not "apply a small patch." Combined with the drift evidence (166 changed lines in the three patched files since the pin, stream-mode now conditional, active repo with same-day merges), the patch strategy has a short half-life. That's not fatal for a POC; it is the first thing that needs a strategy before anyone builds on this.

---

## 2. Scope

The reasoning-only boundary is the strongest design decision in the project. It is enforced three ways (code writes only 4 labels; a test allowlists graph types in the Cypher; docs provide verification queries), it sidesteps agent-memory's `setup_all()`/`triggered_by_message_id`/`user_identifier` expansion paths correctly, and it keeps the demo honest about not exfiltrating conversations. The no-hidden-chain-of-thought policy is coherently implemented (`thought` stays null except the explicitly observable `_plan.md`, marked `observable: true`).

Two scope choices deserve scrutiny:

1. **Full-text retrieval is a deliberate divergence, not parity.** Upstream agent-memory retrieval is **vector-only** (`task_embedding_idx`, `step_embedding_idx`; there is no full-text index anywhere in `queries.py`/`schema.py`). The README says "no vector index" is intentional to avoid an embedding dependency — reasonable for a POC — but the doc frames the model as agent-memory-compatible, and the retrieval layer is where compatibility actually ends. Worse, the write path actively *sets `task_embedding = null` on every upsert* (see M5), which would clobber embeddings if anyone backfills them with the real agent-memory tooling.
2. **The Aura Agent hop is doing double duty.** For the *preflight* (deterministic recall before a run), an LLM agent between the caller and three fixed Cypher templates adds cost ($0.35/agent-hour class), latency to `europe-west1`, token quota (15 exchanges/hr/client, cached per-process only), and nondeterminism — while the process already holds a Bolt driver that could run the same three templates directly. The Aura Agent earns its place as an *interactive/MCP-exposed* surface (personal-mode connector, ad-hoc questions); as a preflight dependency it's the heaviest possible implementation of `SELECT top-5 similar traces`. Worth splitting these two roles explicitly.

Also unstated in scope: there is no retention story (traces grow unboundedly; no TTL/cleanup command) and no multi-tenant/authorization layer (acknowledged in the docs — fine for POC, must be first-class before shared deployments).

---

## 3. General usefulness

Be precise about which of three value propositions this project is delivering, because they have very different maturity:

1. **Graph-native observability of OpenWiki runs** — *works today, real value.* Tool-reliability stats, failure-pattern queries, ordered trace inspection: this is genuinely useful telemetry, and the graph shape (trace→step→call→tool) supports questions a flat log can't (e.g., "which tool sequences precede failures across runs").
2. **A showcase of the Neo4j agent-memory model + Aura Agent + MCP stack** — *works today, effective demo.* The three-credential-domain walkthrough and the personal-mode connector config are the best end-to-end Aura Agent MCP documentation I've seen, including Neo4j's own.
3. **Memory that improves future runs** — *unproven.* Three specific reasons for skepticism:
   - **Relevance:** without repo scoping (H2), full-text match on task/outcome will surface traces from unrelated codebases whose "successful action sequences" (glob → read → write) are generic to the point of tautology.
   - **Signal density:** recall returns up to 5 traces × 20 steps with full JSON `arguments` *and* `result` bodies (bounded at ~4KB each) — potentially hundreds of KB for the Aura Agent's LLM to compress into guidance. The distilled *lesson* ("in this repo, `docs/` is generated — edit `docs-src/`") is worth more than the raw trajectory, and nothing in the pipeline produces lessons.
   - **No measurement:** there is no way to know if augmentation helps, hurts (prompt dilution is a real failure mode), or does nothing.

The strongest near-term usefulness case is narrow and plausible: **repeated `update` runs on the same repository**, where prior traces genuinely describe the same terrain. That's exactly the case repo scoping would unlock and an A/B harness could measure (same repo, N update runs with/without `augmentOpenWikiTaskWithReasoningMemory`, compare tool-call counts, duration, tokens, and diff quality). That experiment is cheap — the CLI pieces already exist — and its result should decide how much to invest in the recall path.

Notably, agent-memory v0.5 already has a `ConsolidationRun` concept upstream. A distillation job (batch: traces → per-repo "procedure/lessons" summaries, recall returns those) would both align with where agent-memory is going and fix the signal-density problem.

---

## 4. Findings

### High

**H1 — The capture seam will not survive upstream, and CI can't see it coming.**
The patch fails against OpenWiki `main` today (verified); upstream already changed the exact seam (conditional `["updates","tools"]` for openai-compatible providers, #660) and is merging daily. The `openwiki-patch` CI job fetches only the pinned commit, so it stays green forever regardless of drift — it verifies the patch file's integrity, not its viability.
*Fix:* (a) add an advisory (allowed-to-fail) CI job applying the patch to the latest release tag and to `main`, so drift is visible the day it happens; (b) pursue upstreaming (see P1) as the real remedy; (c) until then, document the fork-pin workflow (submodule + `npm pack`) as the supported install, since the package's lack of `exports` forces a source checkout anyway.

**H2 — No repository scoping poisons recall and stats the moment a second repo is ingested.**
`ReasoningTrace` has `session_id` (a per-run thread id) and a `metadata` JSON string — neither queryable/indexable for filtering. `find-reasoning-for-task` searches all traces globally; `Tool` stats merge across repos.
*Fix:* promote `repository` (and ideally `agent_version`/`model_id`) to first-class indexed properties on `ReasoningTrace`, add a `repository` parameter to the two trace-recall tools, and consider per-repo tool stats (`(:Tool)` global + per-repo counters on a relationship, or a scoped key). This is a small schema change now and a migration later.

**H3 — The value loop is open: no evaluation, no distillation.**
Covered in §3. *Fix:* the A/B harness first (one afternoon of scripting), distillation second. Until then, reposition README language from "reuse successful action sequences" to "records and exposes execution experience" — the current wording promises the unproven part.

### Medium

**M1 — `find-reasoning-for-task` applies the limit before the success filter.** (`config/aura-agent-tools.json:8`)
`db.index.fulltext.queryNodes(…, {limit: $limit}) YIELD … WHERE trace.success = true` — the top-`$limit` full-text hits are fetched *then* filtered, so if failed traces rank high you get fewer than `$limit` results even when successful matches exist just below the cutoff (and with small corpora, possibly zero).
*Fix:* over-fetch (e.g. `{limit: $limit * 5}` or a fixed 50), filter, then `LIMIT $limit`.

**M2 — Recall payload can be enormous.** (`config/aura-agent-tools.json:8`)
The task tool returns full `arguments` and `result` JSON strings (each up to ~4KB) for up to 20 steps × 5 traces. `recent-reasoning-traces` already does the right thing (omits bodies).
*Fix:* in the recall template, truncate (`left(call.result, 300)`) or drop bodies entirely — keep them for forensic queries over Bolt, not for LLM recall.

**M3 — The preflight adapter does not fail open, contradicting the project's own security model.** (`src/integration/memory-context.ts:32`)
README: "A memory-write or memory-read outage should not be allowed to corrupt an OpenWiki run; production wiring should fail open." The write path honors this (`ReasoningRunCapture` never throws into the run); the read path throws on any MCP/token/network failure, which in the documented wiring (augment task → pass to OpenWiki) means memory downtime blocks the run.
*Fix:* catch inside `augmentOpenWikiTaskWithReasoningMemory` (or add a `failOpen: true` option), return `{augmentedTask: task, memory: undefined, error}` with a warning, and put an explicit timeout budget (e.g. 10s) on the recall so a slow agent can't stall run startup either.

**M4 — Derived success defaults to `true` in the absence of evidence.** (`src/capture/openwiki-trace-recorder.ts:329`)
`finish()` without an explicit `success` returns `true` for a trace with zero tool calls, or when every observed call succeeded but the run failed outside the tool lifecycle. The docs warn about this, but the *default* silently writes `success: true` — and `find-reasoning-for-task` filters on `success = true`, so false positives flow directly into recall.
*Fix:* when `success` isn't supplied and can't be soundly derived, store `null` (the schema already allows it) rather than optimistically `true`; reserve derived-`true` for traces with ≥1 observed call, all successful.

**M5 — Every upsert nulls `task_embedding`/`embedding`, destroying the upstream retrieval path.** (`src/store/cypher.ts:23,43`)
Upstream agent-memory's *only* trace retrieval is vector search over `task_embedding`. If anyone backfills embeddings (with agent-memory's own tooling or a batch job), a single capture replay wipes them.
*Fix:* set to `null` under `ON CREATE` only, or `coalesce(rt.task_embedding, null)` semantics — i.e., never overwrite an existing value.

**M6 — The raw path's outcome capture depends on `messages` mode, which upstream has already made conditional.**
On unreleased `main`, openai-compatible providers stream `["updates","tools"]`; the recorder ignores `updates` chunks (gracefully — verified in code), so traces would persist with tool steps but no outcome, and full-text search loses half its corpus (`outcome` is one of two indexed fields).
*Fix:* note it in the integration guide now; when rebasing the patch, either handle `updates` chunks for final-message extraction or accept and document outcome-less traces for those providers.

### Low

- **L1 — Replay reconciliation:** MERGE-only writes mean re-ingesting a *shorter or renumbered* capture (e.g., after a late plan snapshot shifts step IDs) leaves stale `ReasoningStep` nodes and can leave two steps carrying the same `HAS_STEP.order`. Identical-capture replay is safe (tested); edited-capture replay isn't. Fix: delete the trace's steps/calls in the same transaction before rewriting, or document "same capture only."
- **L2 — Missing `toolCallId` degrades correlation:** LangGraph's `toolCallId` is optional; when absent the correlation key collapses to namespace+name, and concurrent same-name calls cancel each other (defensively — first is preserved as `cancelled`). Inside OpenWiki's ToolNode path IDs are present, so this is theoretical — one doc line suffices.
- **L3 — Lucene syntax injection:** `$query` goes raw into `db.index.fulltext.queryNodes`; task keywords like `auth: AND (login` throw parse errors → tool failure → recall failure. Escape special characters in the template or instruct the agent (system prompt) to pass plain keywords.
- **L4 — The patch `await`s `onRawStreamChunk` inside the hot streaming loop:** a consumer that does I/O per chunk stalls the agent and the UI. The demo's recorder is synchronous/in-memory (correct), but the seam's contract ("must return fast; buffer, don't write") should be stated in the patch/docs.
- **L5 — Redaction is best-effort in both directions:** the JWT-ish regex (`x.y.z`, 10+ chars/segment) false-positives on dotted identifiers (`authentication.middleware.configuration` → `[REDACTED]`), and keys ending in `token` (e.g. `nextPageToken`) are redacted — mild memory-quality loss; meanwhile high-entropy secrets without recognizable prefixes pass through. Fine for a POC; say "best-effort, not DLP" in the security section.
- **L6 — Per-process token cache + 15 exchanges/hr:** each `augment-task`/`query-memory` CLI invocation is a fresh process → fresh token exchange. Fifteen CLI calls in an hour hits the documented gateway limit. A mode-0600 on-disk token cache (or long-lived wrapper process) removes the ceiling. Related: the personal-mode connector's `${AURA_AGENT_MCP_ACCESS_TOKEN}` is static — token expiry mid-session needs the re-export documented (it is) or a refreshing wrapper.
- **L7 — Pinned `MCP-Protocol-Version: 2025-06-18`** and no re-auth on mid-session 401; acceptable now, revisit when Aura advances protocol versions.
- **L8 — No retention/cleanup:** add a `prune` CLI (by age/repo) before any long-running deployment.

### What held up under attack

Worth recording, because these are the parts I tried hardest to break: the idempotency scheme (caller trace ID + deterministic step IDs + namespace-scoped tool-call IDs satisfying the global uniqueness constraint) is correct including the interleaved-subagent case; the plan-snapshot renumbering correctly rewrites step IDs and `stepId` backrefs; Cypher is parameterized everywhere; the three credential domains never cross; the write path's fail-open contract is genuinely never-throw; the untrusted-memory envelope (cap + JSON-string encode + delimiter neutralization + explicit non-instruction framing) is state-of-practice for prompt-injection containment (residual risk is inherent, and acknowledged); the E2E test design (loopback OAuth + MCP server, child-process CLI) tests the real seams without cloud credentials; and the recorder is a faithful superset of upstream's own chunk parser rather than a parallel interpretation.

---

## 5. Alternative integration patterns

Ranked by how much they'd improve the project's position. These are complements, not rewrites — the store, schema, and adapter survive all of them.

**P1 — Upstream the seam (highest leverage).**
Two viable shapes, in order of preference:
- *(a) An `options.middleware` passthrough.* OpenWiki already passes an internal `deepagents` middleware array at `src/agent/index.ts:446`, and `createDeepAgent`/langchain 1.x middleware supports `wrapToolCall` (inputs *and* outputs/errors, no stream parsing at all). A one-line options passthrough is a far easier upstream sell than a raw-chunk hook. **Known limitation (verified):** custom middleware attaches to the main agent only — subagent-internal tool calls aren't wrapped unless middleware is added per-subagent spec — whereas the current raw-stream hook *does* see subagent tools. A hybrid (middleware for fidelity of results, `tools`-mode stream for subagent coverage) also works.
- *(b) The existing `onRawStreamChunk`/`onPlanSnapshot` hook as a PR.* It's small, fail-open, zero-cost when unused, and `types.ts` hasn't changed upstream — the contract-level change is trivially rebaseable even though the `index.ts` hunks aren't. The patch is exactly the kind of generic observability seam upstream might accept; until it's accepted, every week of delay grows the rebase.
Either way, the pinned-fork treadmill ends only when the seam is upstream. (Also worth checking: `deepagents` exposes a `streamTransformers` param in its published types — unexplored here, possibly relevant.)

**P2 — Zero-patch capture via LangSmith tracing (the no-fork fallback).**
Verified empirically: with `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY` (env only, zero code changes — and `langsmith` is already an OpenWiki dependency), a LangGraph run exports tool runs with **inputs, outputs, error messages, parent/child structure, and start/end times** — i.e., strictly more than the raw-stream hook captures, including subagent tools. An ETL (poll `client.runs.query()` — note `listRuns` is deprecated with a Jan 2027 removal date — filter `run_type: "tool"`, map to the existing `ReasoningTrace` shape) turns this into the same graph with **no fork, surviving every OpenWiki release**. Trade-offs: post-hoc rather than in-process; data transits LangSmith (self-hosted endpoint or the empirically-verified trick of pointing `LANGSMITH_ENDPOINT` at a small local `/runs/multipart` sink works, though the wire format is not a stability contract); `_plan.md` arrives only via `write_file` tool inputs rather than as a final snapshot; set `LANGCHAIN_CALLBACKS_BACKGROUND=false` for a short-lived CLI. Ruled out: OpenTelemetry — verified that LangChain **JS** callback runs are *not* exported as OTLP spans today (the langsmith OTel translator drops runs with no active span; `@langchain/core` has no OTel integration), so the OTel route currently requires third-party instrumentation (`@traceloop/…`, `@arizeai/openinference-…`, untested).

**P3 — Direct-Bolt recall for the preflight; keep the Aura Agent for interactive use.**
The preflight adapter needs deterministic top-K retrieval, and the process already has a Neo4j driver and the three Cypher templates. Running them directly removes the LLM-in-the-middle, OAuth dance, EU round-trip, token quota, and per-call agent cost from the *hot path* — and makes recall unit-testable. The Aura Agent remains the right surface for the personal-mode MCP connector and ad-hoc "ask the memory" queries. This one change makes M3's fail-open trivial (a driver call with a timeout) and cuts the demo's operational prerequisites in half for the common case.

**P4 — Evaluate the official `@neo4j-labs/agent-memory` TypeScript client before the hand-rolled store grows.**
It exists (npm, v0.4.1, with reasoning and MCP modules) and is nowhere mentioned in this repo. It targets the NAMS service rather than raw Bolt, so it may not fit the direct-AuraDB design — but the review question "why not the official TS client?" deserves an explicit answer in the docs, whichever way it lands. If NAMS is where agent-memory is heading (consolidation runs, read audits are already in v0.5), a POC that writes the same shapes via the sanctioned client would age better.

**P5 — Vector retrieval as the upgrade path (restores real agent-memory parity).**
Full-text on `task`/`outcome` won't match "document the auth architecture" to "explain login flow." Adding `task_embedding` + the upstream-named `task_embedding_idx` vector index (embedding computed at ingest, hybrid-scored with full-text) upgrades recall quality *and* makes the stored graph consumable by upstream agent-memory tooling — but only after fixing M5, which currently erases embeddings on every write.

**P6 — A Neo4j-backed LangGraph `BaseStore` (strategic, beyond this POC).**
Verified: LangGraph JS has the `BaseStore` long-term-memory interface (`get/put/search`, semantic search), official Postgres/Mongo/Redis/SQLite backends, **no Neo4j implementation anywhere**, and LangMem is Python-only. `createDeepAgent` accepts `store:`. A `Neo4jStore` would be the LangChain-native seam for memory across *every* LangGraph JS app — a much bigger prize than an OpenWiki-specific integration, and a natural home for the reasoning-memory model this POC already defined.

**Explicitly not recommended:** removing/bypassing OpenWiki's repository-mode connector gate (upstream marks it a security boundary, #444 — this repo's docs already say the same, correctly), and expanding the demo beyond the reasoning-only label set before multi-tenancy/authz exists.

---

## 6. If I were shipping this next — priority order

1. **Fail-open + timeout in the preflight adapter** (M3) — hours, removes the worst production foot-gun.
2. **Repository scoping** (H2) — small schema + tool-parameter change now, painful migration later.
3. **Recall query fixes** (M1 over-fetch-then-filter; M2 trim result bodies) — config-only, no code.
4. **Advisory drift CI + success-default fix + embedding-clobber fix** (H1 partial, M4, M5) — a day.
5. **The A/B experiment** (H3) — same repo, N `update` runs with/without augmentation; let the data set the roadmap.
6. **Open the upstream conversation** (P1) — the middleware-passthrough pitch, with the raw-hook patch as fallback; in parallel, spike the LangSmith ETL (P2) as the no-fork insurance policy.

---

## Appendix — primary evidence

- Local: `npm run check` (all green, Node 22), `npm run demo`, `git apply --check` vs `60aada6` (pass) and vs `main` `ea80ddc` (fail), `git diff --stat` pin→main on patched files (166 insertions), OpenWiki `package.json` at pin (bin-only, `deepagents@1.12.0` exact, `langsmith` present, sqlite checkpointer).
- OpenWiki upstream: [repo](https://github.com/langchain-ai/openwiki) (v0.3.3 latest release 2026-08-14; pinned commit = tag + 2 docs commits); `src/agent/types.ts`, `src/agent/index.ts` (stream loop, `parseAgentStreamChunk`, `parseToolStreamEvent`), `src/connectors/tools.ts` (#444 gate), `src/connectors/mcp-client.ts` (env-header enforcement), `prompts/code.ts` + `utils.ts` (`_plan.md`); post-pin commits incl. [#660](https://github.com/langchain-ai/openwiki) (`updates` stream mode for openai-compatible).
- Neo4j: [`neo4j-labs/agent-memory`](https://github.com/neo4j-labs/agent-memory) `graph/queries.py` + `schema.py` (model parity; vector-only retrieval; `setup_all()` breadth; stale `reasoning.adoc`); npm `@neo4j-labs/agent-memory` 0.4.1 (NAMS TS client); [Aura Agent docs](https://neo4j.com/docs/aura/aura-agent/) (external-only MCP, endpoint, M2M flow, 15/hr limit, `europe-west1`, GA + [$0.35/agent-hour](https://neo4j.com/blog/agentic-ai/neo4j-launches-aura-agent/)); [`neo4j-cli`](https://neo4j.sh) source (`aura agent create` flags, `additions.md` tool shapes); [`mcp-neo4j-cypher`](https://github.com/neo4j-contrib/mcp-neo4j) (read-only mode exists).
- LangGraph/LangChain JS (source + empirical runs on 1.4.11): chunk tuple shape; namespace semantics per mode (root `messages`/`tools` = length 1); `StreamToolsOutput` payload contract; deepagents 1.12.4 `middleware` param + main-agent-only caveat; LangSmith env-only tracing verified capturing tool inputs/outputs/errors/timings; `client.runs.query()`; OTel negative result for JS callback runs; `BaseStore` + official backends (no Neo4j); LangMem Python-only.

*Review conducted with full source access, test execution, and independent verification of every upstream claim against primary sources as of 2026-08-19.*
