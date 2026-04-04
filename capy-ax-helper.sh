#!/bin/bash
# capy-ax-helper.sh v2 - Simplified daemon communication
# Relies on pre-started daemon (launched via Terminal.app at boot)
RESULT="/tmp/capy-ax-result.json"
TRIGGER="/tmp/capy-ax-trigger"
DONE="/tmp/capy-ax-result.done"
PID_FILE="/tmp/capy-ax-daemon.pid"

# Check daemon is alive
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    : # daemon alive
else
    echo '{"error": "AX daemon not running. Start it first."}'
    exit 1
fi

# Send command
rm -f "$RESULT" "$DONE"
echo "$@" > "$TRIGGER"

# Wait for result (up to 8s)
for i in $(seq 1 80); do
    if [ -f "$DONE" ]; then
        rm -f "$DONE"
        cat "$RESULT"
        exit 0
    fi
    sleep 0.1
done

echo '{"error": "AX query timed out (8s)"}'
exit 1
