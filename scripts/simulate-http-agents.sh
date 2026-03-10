#!/usr/bin/env bash
# simulate-http-agents.sh — Spawn simulated agents via the HTTP bridge
# Curls the local HTTP bridge server directly, same as Kiro hooks would.
#
# Usage: bash scripts/simulate-http-agents.sh [num_agents] [duration_seconds]
#   Defaults: 2 agents, 30 seconds
#
# Prerequisites: The Pixel Agents extension must be running with the HTTP bridge
# active. Check that ~/.pixel-agents/kiro-port exists.

set -eo pipefail

NUM_AGENTS="${1:-2}"
DURATION="${2:-30}"
PORT_FILE="$HOME/.pixel-agents/kiro-port"

if [[ ! -f "$PORT_FILE" ]]; then
  echo "❌ Port file not found at $PORT_FILE"
  echo "   Make sure the Pixel Agents extension is running with the HTTP bridge enabled."
  exit 1
fi

PORT=$(cat "$PORT_FILE")
if [[ -z "$PORT" ]]; then
  echo "❌ Port file is empty"
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
echo "🌐 HTTP bridge at $BASE"

# Kiro tool names (what hooks actually send)
TOOLS=(
  "readFile"
  "editCode"
  "fsWrite"
  "executeBash"
  "grepSearch"
  "listDirectory"
  "readCode"
  "strReplace"
  "readMultipleFiles"
  "fileSearch"
  "getDiagnostics"
  "deleteFile"
)

post() {
  curl -sf -m 2 -X POST -H 'Content-Type: application/json' -d "$2" "$BASE$1" 2>/dev/null || true
}

run_agent() {
  local agent_num="$1"
  local end_time=$((SECONDS + DURATION))
  local tool_idx=0
  local num_tools=${#TOOLS[@]}

  echo "[Agent $agent_num] Starting prompt..."
  post "/prompt-start" '{}'
  sleep 1

  while [[ $SECONDS -lt $end_time ]]; do
    local idx=$(( (tool_idx + agent_num * 3) % num_tools ))
    local tool_name="${TOOLS[$idx]}"

    # tool-start → get toolId back
    local response
    response=$(curl -sf -m 2 -X POST -H 'Content-Type: application/json' \
      -d "{\"tool\":\"$tool_name\"}" "$BASE/tool-start" 2>/dev/null || echo '{}')

    # Extract toolId from response (simple grep — no jq dependency)
    local tool_id
    tool_id=$(echo "$response" | grep -o '"toolId":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [[ -n "$tool_id" ]]; then
      echo "[Agent $agent_num] Tool: $tool_name → $tool_id"

      # Simulate execution (1-3s)
      sleep $(( (RANDOM % 3) + 1 ))

      # tool-done
      post "/tool-done" "{\"toolId\":\"$tool_id\"}"
    fi

    # Brief pause between tools
    sleep 1
    tool_idx=$((tool_idx + 1))
  done

  # Agent stop
  echo "[Agent $agent_num] Stopping..."
  post "/agent-stop" '{}'
  echo "[Agent $agent_num] Done ($tool_idx tools executed)"
}

echo "🎮 Spawning $NUM_AGENTS HTTP-simulated agents for ${DURATION}s..."
echo ""

PIDS=()
for i in $(seq 1 "$NUM_AGENTS"); do
  run_agent "$i" &
  PIDS+=($!)
  sleep 2
done

echo ""
echo "Agents running. Press Ctrl+C to stop early, or wait ${DURATION}s."
echo ""

cleanup() {
  echo ""
  echo "Stopping agents..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Send agent-stop for cleanup
  for i in $(seq 1 "$NUM_AGENTS"); do
    post "/agent-stop" '{}'
  done
  echo "Done."
}
trap cleanup INT

for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done

echo ""
echo "✅ All agents finished. Check the Pixel Agents panel!"
