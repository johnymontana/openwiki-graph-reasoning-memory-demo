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

: "${AURA_AGENT_ID:?Set AURA_AGENT_ID to the existing Aura Agent id.}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
tools_json="$(jq -c . "${repo_dir}/config/aura-agent-tools.json")"
system_prompt="$(<"${repo_dir}/config/aura-agent-system-prompt.txt")"

# PATCH semantics: only the tool definitions and system prompt are replaced.
# Run this after every edit to config/aura-agent-tools.json or the prompt;
# the deployed agent does not track the repository files.
neo4j-cli aura agent update "${AURA_AGENT_ID}" \
  --tools "${tools_json}" \
  --system-prompt "${system_prompt}" \
  --rw \
  --format json
