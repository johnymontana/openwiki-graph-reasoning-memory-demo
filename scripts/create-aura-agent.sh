#!/usr/bin/env bash
set -euo pipefail

if ! command -v neo4j-cli >/dev/null 2>&1; then
  echo "neo4j-cli is required. Install it from https://neo4j.sh/" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to compact the Aura Agent tool configuration." >&2
  exit 1
fi

: "${AURA_DBID:?Set AURA_DBID to the target AuraDB instance id.}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
tools_json="$(jq -c . "${repo_dir}/config/aura-agent-tools.json")"
system_prompt="$(<"${repo_dir}/config/aura-agent-system-prompt.txt")"

neo4j-cli aura agent create \
  --name "openwiki-reasoning-memory" \
  --description "Read-only retrieval over successful and failed OpenWiki execution traces." \
  --dbid "${AURA_DBID}" \
  --tools "${tools_json}" \
  --system-prompt "${system_prompt}" \
  --is-private=false \
  --is-mcp-enabled=true \
  --enabled=true \
  --rw \
  --format json

