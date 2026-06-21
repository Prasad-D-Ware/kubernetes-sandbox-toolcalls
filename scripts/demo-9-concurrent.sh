#!/usr/bin/env bash
# Fire 9 concurrent /chat requests, each forcing a tool call. With 8 pods, the 9th
# must queue and then either acquire a freed pod or fail with sandbox_capacity_timeout.
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
MSG='run the shell command: ls'

echo ">> sending 9 concurrent tool-calling chat requests to $BASE/chat"
pids=()
for i in $(seq 1 9); do
  (
    code=$(curl -s -o "/tmp/pi-demo-$i.json" -w "%{http_code}" \
      -X POST "$BASE/chat" \
      -H 'content-type: application/json' \
      -d "{\"sessionId\":\"demo-$i\",\"message\":\"$MSG\"}")
    echo "request $i -> HTTP $code :: $(head -c 200 /tmp/pi-demo-$i.json)"
  ) &
  pids+=($!)
done

for pid in "${pids[@]}"; do wait "$pid"; done
echo ">> done. Inspect pool state with:  curl -s $BASE/pods | jq"
