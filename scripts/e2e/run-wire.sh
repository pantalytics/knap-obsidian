#!/usr/bin/env bash
#
# Start a throwaway y-sweet relay and run the wire end to end against it.
#
# y-sweet is the relay server this stack runs, so this is the real transport
# rather than a stand-in. The binary is fetched from npm the first time and
# cached under .cache/y-sweet.
#
# Exit codes: 0 pass, 1 an assertion failed, 2 the environment was not ready.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${KNAP_RELAY_PORT:-8099}"
CACHE="$ROOT/.cache/y-sweet"
BIN="$CACHE/node_modules/y-sweet/bin/y-sweet"

if [ ! -x "$BIN" ]; then
	echo "fetching y-sweet..."
	mkdir -p "$CACHE"
	( cd "$CACHE" && npm init -y >/dev/null 2>&1 && npm i y-sweet@0.9.1 >/dev/null 2>&1 )
fi
if [ ! -x "$BIN" ]; then
	echo "could not install y-sweet" >&2
	exit 2
fi

STORE="$(mktemp -d)"
"$BIN" serve --port "$PORT" --host 127.0.0.1 "$STORE" >"$STORE/relay.log" 2>&1 &
RELAY_PID=$!
cleanup() {
	kill "$RELAY_PID" 2>/dev/null || true
	rm -rf "$STORE"
}
trap cleanup EXIT

for _ in $(seq 1 40); do
	if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/ready" 2>/dev/null; then
		break
	fi
	sleep 0.25
done

cd "$ROOT"
node scripts/e2e/wire.e2e.mjs "ws://127.0.0.1:$PORT"
# The same relay, a second question: what a member joining a vault it did not
# create receives, and whether the share will write all of it (#90).
node scripts/e2e/join.e2e.mjs "ws://127.0.0.1:$PORT"
