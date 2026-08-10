#!/usr/bin/env bash
#
# The half the other two end to ends could not reach: Obsidian itself talking
# to a relay, over the plugin's own transport, both directions.
#
# The obstacle, and why this script is more than a `node` invocation. Obsidian's
# renderer runs on an app:// origin that Chromium treats as a secure context, so
# it refuses a plaintext ws:// even to localhost. Measured: the connection never
# reaches the server, and the page's CSP is not the cause, it only sets
# style-src. So the relay has to be reached over wss, with a certificate the
# app's own NSS store trusts. That is what this sets up:
#
#   y-sweet on the host          the relay, plain ws on :8099
#   a TLS proxy in the container 127.0.0.1:8443, forwards to the host
#   a CA in the app's NSS store  so wss://localhost:8443 is trusted
#
# The container's NSS store is the same one scripts/dev/obsidian/init/20-trust-ca.sh
# in the admin repo already maintains, and certutil is there because of it.
#
# Exit codes: 0 pass, 1 an assertion failed, 2 the environment was not ready.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="${KNAP_OBSIDIAN_HARNESS:-$ROOT/../knap-mcp-admin/scripts/dev/obsidian/obsidian.sh}"
CONTAINER="${KNAP_OBSIDIAN_CONTAINER:-knap-obsidian}"
RELAY_PORT="${KNAP_RELAY_PORT:-8099}"
TLS_PORT="${KNAP_TLS_PORT:-8443}"
BIN="$ROOT/.cache/y-sweet/node_modules/y-sweet/bin/y-sweet"
DOC_GUID="2c619536-2c2d-4b14-a2c5-5fe2c60b566b"
FOLDER_GUID="00000000-0000-4000-8000-00000000f001"

for need in docker curl openssl node; do
	command -v "$need" >/dev/null || { echo "missing $need" >&2; exit 2; }
done
[ -x "$HARNESS" ] || { echo "harness not found at $HARNESS" >&2; exit 2; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "container $CONTAINER is not there; run the harness's 'up' first" >&2; exit 2; }
[ -x "$BIN" ] || { echo "y-sweet not cached; run scripts/e2e/run-wire.sh once" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
	kill "${RELAY_PID:-}" 2>/dev/null || true
	docker exec "$CONTAINER" sh -c 'pkill -f /tmp/knap-tls-proxy.py' 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

# --- the relay, on the host so a second participant can reach it plainly ---- #
"$BIN" serve --port "$RELAY_PORT" --host 0.0.0.0 "$WORK/store" >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 40); do
	curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$RELAY_PORT/ready" 2>/dev/null && break
	sleep 0.25
done

# --- a certificate the app will trust -------------------------------------- #
openssl req -x509 -newkey rsa:2048 -keyout "$WORK/ca.key" -out "$WORK/ca.crt" -days 2 -nodes \
	-subj "/CN=knap-e2e-ca" 2>/dev/null
openssl req -newkey rsa:2048 -keyout "$WORK/srv.key" -out "$WORK/srv.csr" -nodes \
	-subj "/CN=localhost" 2>/dev/null
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > "$WORK/ext.cnf"
openssl x509 -req -in "$WORK/srv.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial \
	-out "$WORK/srv.crt" -days 2 -extfile "$WORK/ext.cnf" 2>/dev/null
cat "$WORK/srv.crt" "$WORK/srv.key" > "$WORK/srv.pem"

cat > "$WORK/proxy.py" <<'PYEOF'
import asyncio, ssl, sys
CERT, PORT, UPHOST, UPPORT = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
async def pipe(r, w):
    try:
        while True:
            b = await r.read(65536)
            if not b: break
            w.write(b); await w.drain()
    except Exception: pass
    finally:
        try: w.close()
        except Exception: pass
async def handle(cr, cw):
    try: ur, uw = await asyncio.open_connection(UPHOST, UPPORT)
    except Exception: cw.close(); return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
async def main():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(CERT)
    s = await asyncio.start_server(handle, "127.0.0.1", PORT, ssl=ctx)
    print("ready", flush=True)
    async with s: await s.serve_forever()
asyncio.run(main())
PYEOF

GATEWAY="$(docker inspect "$CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' | head -1)"
docker cp "$WORK/srv.pem" "$CONTAINER:/tmp/knap-tls.pem" >/dev/null
docker cp "$WORK/ca.crt" "$CONTAINER:/tmp/knap-ca.crt" >/dev/null
docker cp "$WORK/proxy.py" "$CONTAINER:/tmp/knap-tls-proxy.py" >/dev/null
docker exec "$CONTAINER" sh -c \
	"(nohup python3 /tmp/knap-tls-proxy.py /tmp/knap-tls.pem $TLS_PORT $GATEWAY $RELAY_PORT >/tmp/knap-tls.log 2>&1 &); sleep 2" >/dev/null

# Chromium on Linux reads NSS, not the system store, and only at startup.
docker exec "$CONTAINER" sh -c \
	'certutil -d sql:/config/.pki/nssdb -A -t "C,," -n knap-e2e-ca -i /tmp/knap-ca.crt' >/dev/null 2>&1 || true

# --- the relay documents the plugin will ask for ---------------------------- #
for id in "$FOLDER_GUID" "$DOC_GUID"; do
	curl -fsS -X POST "http://127.0.0.1:$RELAY_PORT/doc/new" \
		-H 'Content-Type: application/json' -d "{\"docId\":\"$id\"}" --max-time 8 >/dev/null
done

echo "relay, tls proxy and trust are up; driving Obsidian..."
RESULT="$("$HARNESS" eval "$(sed -e "s|__TLS_PORT__|$TLS_PORT|g" -e "s|__FOLDER_GUID__|$FOLDER_GUID|g" \
	"$ROOT/scripts/e2e/obsidian-wire.e2e.js")" | tail -1)"
echo "$RESULT"

cd "$ROOT"
node scripts/e2e/obsidian-wire-readback.mjs "ws://127.0.0.1:$RELAY_PORT" "$DOC_GUID" "$RESULT"
