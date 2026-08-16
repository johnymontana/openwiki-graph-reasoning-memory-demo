#!/usr/bin/env bash
set -euo pipefail

if ! command -v neo4j-cli >/dev/null 2>&1; then
  echo "neo4j-cli is required. Install it from https://neo4j.sh/" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
query_args=(query --atomic --rw --format json)

if [[ -n "${NEO4J_CREDENTIAL:-}" ]]; then
  query_args+=(--credential "${NEO4J_CREDENTIAL}")
fi

neo4j-cli "${query_args[@]}" < "${repo_dir}/cypher/reasoning-schema.cypher"

schema_args=(query :schema --format toon)
if [[ -n "${NEO4J_CREDENTIAL:-}" ]]; then
  schema_args+=(--credential "${NEO4J_CREDENTIAL}")
fi
neo4j-cli "${schema_args[@]}"
