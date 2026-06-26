#!/usr/bin/env bash
# Smoke-test the running openclaw gateway's claude-code hook + dispatch chain.
#
# After `openclaw gateway restart`, run this. Exits non-zero on any failure so
# it composes into a deploy script. Tests only what unit tests can't reach:
# real HTTP route, real plugin runtime, real per-session JSON state file.
#
# Does NOT touch real claude-code sessions — synthetic session_id is namespaced
# under `cc-plugin-smoke-*` so a sweep across the state dir is safe.

set -euo pipefail

PORT="${OPENCLAW_PORT:-18789}"
ENDPOINT="http://127.0.0.1:${PORT}/claude-code/hook"
STATE_DIR="${HOME}/.cache/claude-code-hooks"
SID="cc-plugin-smoke-$(date +%s)-$$"
STATE_FILE="${STATE_DIR}/${SID}.json"

cleanup() { rm -f "$STATE_FILE"; }
trap cleanup EXIT

echo "→ POST Stop hook ($SID)"
RESP=$(curl -fsS -X POST "$ENDPOINT" \
  -H 'content-type: application/json' \
  --max-time 5 \
  -d "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SID\",\"cwd\":\"/tmp\"}")
echo "  response: $RESP"
[[ "$RESP" == *'"ok":true'* ]] || { echo "FAIL: hook returned non-ok"; exit 1; }

# Plugin debounces flush by 250ms (src/store.ts:18). Wait a bit longer.
sleep 1

[[ -f "$STATE_FILE" ]] || { echo "FAIL: state file not written: $STATE_FILE"; exit 1; }
echo "→ state file written: $STATE_FILE"

STATE=$(python3 -c "import json,sys; print(json.load(open('$STATE_FILE'))['state'])")
[[ "$STATE" == "WAITING" ]] || { echo "FAIL: state=$STATE (want WAITING)"; exit 1; }
echo "  state=WAITING ✓"

echo "→ POST PreToolUse → expect WORKING transition"
curl -fsS -X POST "$ENDPOINT" -H 'content-type: application/json' --max-time 5 \
  -d "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"$SID\",\"tool_name\":\"Bash\"}" >/dev/null
sleep 1
STATE=$(python3 -c "import json,sys; print(json.load(open('$STATE_FILE'))['state'])")
[[ "$STATE" == "WORKING" ]] || { echo "FAIL: state=$STATE (want WORKING)"; exit 1; }
echo "  state=WORKING ✓"

echo "OK: hook → store → state-file chain healthy."
echo
echo "Note: this script can't observe whether the agent actually received the"
echo "wake. For that, restart gateway, send a real Stop hook, and watch the"
echo "configured target session for a system-event prompt within ~1s."
