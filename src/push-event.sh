#!/bin/bash
# push-event.sh — send a Spectator WireEvent to the running relay
# Usage: push-event.sh <kind> <payload_json> [actor_type] [actor_name]
#   actor_type: "agent" (default) or "human"
#   actor_name: defaults to "Castor" for agent, "Da" for human
SPECTATOR_URL="${SPECTATOR_URL:-http://localhost:8787}"

kind="$1"
payload="$2"
actor_type="${3:-agent}"
actor_name="$4"
session_id="${SESSION_ID:-castor-live}"

if [ -z "$kind" ] || [ -z "$payload" ]; then
  echo "Usage: push-event.sh <kind> <payload_json> [actor_type] [actor_name]"
  echo ""
  echo "Kinds: session.meta, user.message, message.delta, message.complete,"
  echo "       tool.start, tool.progress, tool.complete, approval.request,"
  echo "       approval.decision, clarify.request, status"
  exit 1
fi

if [ "$actor_type" = "human" ]; then
  [ -z "$actor_name" ] && actor_name="Da"
  actor_id="operator"
else
  [ -z "$actor_name" ] && actor_name="Castor"
  actor_id="agent"
fi

ts=$(date +%s)000
id="${ts}-${RANDOM}"

event=$(cat <<END
{
  "id": "$id",
  "ts": $ts,
  "sessionId": "$session_id",
  "seq": 0,
  "actor": {"type": "$actor_type", "id": "$actor_id", "name": "$actor_name"},
  "kind": "$kind",
  "payload": $payload
}
END
)

curl -s -X POST "$SPECTATOR_URL/ingest" \
  -H "Content-Type: application/json" \
  -d "$event"
echo ""
