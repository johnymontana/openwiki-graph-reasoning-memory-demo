Here's the full path from where things stand right now to a finished evaluation report. Two things are already done and need no action: the fork at ../openwiki is built with the hooks in dist/, and the demo's test suite is green. Everything below is configuration and live runs.

One decision to make up front: use your AuraDB instance for everything, not the local Neo4j on 7687. The Aura Agent can only attach to an Aura instance, and recall only works if the traces you ingest live in the same database the agent queries. (The local instance is still useful for npm run test:integration:neo4j if you want, but keep the demo's .env pointed at Aura.)

Part A — Environment and free sanity checks (no model cost)

1. Create .env (there isn't one yet):

cd ~/github/johnymontana/openwiki-graph-reasoning-memory-demo
cp .env.example .env

2. Fill in the AuraDB connection (the write path):

dotenv
NEO4J_URI=neo4j+s://<your-instance>.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=...
NEO4J_DATABASE=neo4j

3. Fill in the model provider. This is the one gotcha specific to your machine: your OpenWiki credentials live in ~/.openwiki/.env (OpenAI-based), but the runner gives each child an isolated HOME, so that file is invisible to runs. The provider must be in the demo's .env:

- Option 1 (runner default, cheapest): add ANTHROPIC_API_KEY=... and you're done — runs use claude-haiku-4-5.
- Option 2 (reuse your OpenAI setup): copy these from ~/.openwiki/.env into the demo .env: OPENWIKI_PROVIDER=..., OPENAI_API_KEY=..., OPENWIKI_MODEL_ID=.... One check: if your OPENWIKI_PROVIDER is literally openai-compatible (not openai), also add OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES=true, otherwise OpenWiki streams updates instead of messages and traces lose their outcome text.

OPENWIKI_DIR needs nothing — the default ../openwiki matches your layout.

4. Create the schema (constraints, the new trace_repository_idx, and the full-text index):

npm run schema

5. Free pipeline checks:

npm run demo     # translates the fixture, no DB — sanity only
npm run ingest   # writes the example trace to AuraDB

ingest matters beyond sanity: it gives the Aura Agent something to find in step B4 before you've spent a single model token.

Part B — Aura Agent + MCP (required for --augment and evaluate)

1. If you've never created the agent — in Aura Console make sure Generative AI assistance and Aura Agent are enabled at the org level and tool authentication at the project level, then:

# one-time neo4j-cli setup if not already registered:
neo4j-cli credential aura-client add --name openwiki-aura --client-id <ID> --client-secret <SECRET> --rw
neo4j-cli aura workspace use <ORG_ID>/<PROJECT_ID> --rw

export AURA_DBID=<your Aura instance id>
./scripts/create-aura-agent.sh        # note the returned agent id

2. If the agent already exists, you MUST update it — the tool templates changed today (repository parameter, over-fetch-then-filter, truncated bodies) and the deployed agent doesn't track this repo:

export AURA_AGENT_ID=<agent id>
./scripts/update-aura-agent.sh

Skipping this is the silent-failure mode: recall would still "work" but with the old unscoped, unbounded queries.

3. MCP credentials: Aura Console → Account settings → Client credentials → Aura Agent & MCP → create one scoped to the agent, then in .env:

dotenv
AURA_AGENT_MCP_URL=https://mcp.neo4j.io/agent?project_id=<PROJECT_ID>&agent_id=<AGENT_ID>
AURA_AGENT_MCP_CLIENT_ID=...
AURA_AGENT_MCP_CLIENT_SECRET=...

4. Verify the whole recall path with zero OpenWiki cost (this exercises token exchange → MCP → agent → scoped Cypher → the fixture trace you ingested):

npm run mint-token
npm run query-memory -- 'Recall successful traces for repository github.com/example/demo-repo about documenting architecture'

You should get an answer referencing the example trace. (Each CLI invocation mints one token — the gateway allows 15/hour — so don't loop these; the eval itself shares a single exchange.)

Part C — First real run, then the eval

1. Smoke run first (isolates model/provider problems before the eval multiplies them ×5). Costs one real run — minutes and cents on haiku:

npm run run -- --repo /path/to/some-small-repo --command init

Expect exit 0 and a summary like steps: N, tool calls: M, success: true … persisted to Neo4j: yes. If it fails, the child's full log is at captures/<traceId>-work/child.log.

2. Optional augmented smoke — confirms recall reaches a live run:

npm run run -- --repo /path/to/same-repo --command update --task 'Refresh the architecture overview' --augment

Look for the Recalled reasoning memory over MCP in <N>ms (<chars> chars) line.

3. Mini eval (3 runs: 1 seed + 1 baseline + 1 augmented) — the preflight checks fork, Neo4j, and the MCP endpoint before any spend:

npm run evaluate -- --repo /path/to/target-repo --trials 1 --seed-runs 1

It prints a run id when done. If you omit --repo it targets this demo repo itself, which is the checked-in default.

4. The report:

npm run report -- --run-id <printed-id>
npm run report -- --run-id <printed-id> --out eval-report.md   # keep a copy

5. Full eval once the mini one looks sane (5 runs by default):

npm run evaluate -- --trials 2 --seed-runs 1

Reading the results: the arm table compares baseline vs augmented on duration (mean ± sd / median), steps, tool calls, failures, and wiki output; recall overhead shows what augmentation itself cost. Trials tagged recall failed: yes ran without the intervention and are already excluded from the augmented aggregates. Everything is also mirrored locally under eval-runs/<runId>/ (results.json, per-trial journals, child logs, capture logs — the capture logs replay with npm run demo -- <file>). Take the report's methodology note seriously: at N=2 you're looking for direction and mechanism (e.g., fewer exploration tool calls in the augmented arm), not significance — raise --trials if you see a signal worth confirming.

Quick troubleshooting map: "OpenWiki fork not found / not built" → OPENWIKI_DIR or pnpm install && pnpm build in the fork · "ANTHROPIC_API_KEY is required" → Part A step 3 · 401 from mcp.neo4j.io → wrong credential type (must be Aura Agent & MCP, not an Aura API credential) · recall returns nothing → agent not updated (B2) or traces in a different database than the agent's (the AuraDB-for-everything rule) · run exits 1 with error_kind: timeout → raise --timeout-minutes.
