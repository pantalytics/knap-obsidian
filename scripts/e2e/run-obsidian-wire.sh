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

# Chromium on Linux reads NSS, not the system store. On the agent box the
# admin harness's init (scripts/dev/obsidian/init/20-trust-ca.sh) has already
# installed certutil and created the store, but that init only runs when the
# box mounts its own proxy CA, so on a bare runner (CI) neither exists yet.
# Install and create what is missing, and fail loudly rather than let an
# untrusted CA read as a broken websocket three assertions later.
docker exec "$CONTAINER" sh -c '
	set -e
	if ! command -v certutil >/dev/null 2>&1; then
		apt-get update -qq >/dev/null 2>&1
		apt-get install -y -qq --no-install-recommends libnss3-tools >/dev/null 2>&1
	fi
	mkdir -p /config/.pki/nssdb
	if [ ! -f /config/.pki/nssdb/cert9.db ]; then
		certutil -d sql:/config/.pki/nssdb -N --empty-password >/dev/null 2>&1
	fi
	certutil -d sql:/config/.pki/nssdb -A -t "C,," -n knap-e2e-ca -i /tmp/knap-ca.crt
' || { echo "could not trust the e2e CA in the app's NSS store" >&2; exit 2; }

# --- the same note, carried by each mode in turn ---------------------------- #
# Whole vault is the default and one folder is the option, so both have to move
# the same bytes. Projects/from-disk.md is inside either share.
drive() {
	sed -e "s|__TLS_PORT__|$TLS_PORT|g" -e "s|__FOLDER_GUID__|$2|g" \
		-e "s|__PHASE__|$1|g" -e "s|__SCOPE__|$3|g" \
		"$ROOT/scripts/e2e/obsidian-wire.e2e.js"
}
unwrap() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read()); v=json.loads(v) if isinstance(v,str) else v; print(json.dumps(v))'; }
newdoc() {
	curl -fsS -X POST "http://127.0.0.1:$RELAY_PORT/doc/new" -H 'Content-Type: application/json' \
		-d "{\"docId\":\"$1\"}" --max-time 8 >/dev/null
}

run_scope() {
	local scope="$1" folder_guid="$2"
	newdoc "$folder_guid"

	local setup push read land doc_guid
	setup="$("$HARNESS" eval "$(drive setup "$folder_guid" "$scope")" | tail -1 | unwrap)"
	doc_guid="$(printf '%s' "$setup" | python3 -c 'import json,sys; print(json.load(sys.stdin)["docGuid"])')"
	newdoc "$doc_guid"

	push="$("$HARNESS" eval "$(drive push "$folder_guid" "$scope")" | tail -1 | unwrap)"

	cd "$ROOT"
	read="$(node scripts/e2e/obsidian-wire-readback.mjs "ws://127.0.0.1:$RELAY_PORT" "$doc_guid" read | tail -1)"
	node scripts/e2e/obsidian-wire-readback.mjs "ws://127.0.0.1:$RELAY_PORT" "$doc_guid" \
		write "$REMOTE_LINE" >/dev/null

	land="$("$HARNESS" eval "$(drive land "$folder_guid" "$scope")" | tail -1 | unwrap)"

	printf '%s\n%s\n%s\n%s\n' "$setup" "$push" "$read" "$land" > "$WORK/$scope.json"
	echo "  $scope: pushed, read back, and landed"
}

REMOTE_LINE=$'\nDeze regel is van een ander apparaat.\n'

echo "relay, tls proxy and trust are up; driving Obsidian..."
run_scope vault "00000000-0000-4000-8000-00000000f001"
run_scope folder "00000000-0000-4000-8000-00000000f0a2"

python3 - "$WORK/vault.json" "$WORK/folder.json" <<'PYEOF'
import json, sys

remote = "Deze regel is van een ander apparaat."
failures = []
summary = {}

for path in sys.argv[1:3]:
    with open(path) as fh:
        setup, push, read, land = (json.loads(line) for line in fh if line.strip())
    scope = setup.get("scope", "?")

    def bad(msg):
        failures.append(f"[{scope}] {msg}")

    if setup.get("relayId") != "relay-onprem":
        bad("the share was not relay backed, so the push path never reads the file")
    if setup.get("scope") == "folder" and setup.get("sharePath") != "Projects":
        bad(f"the folder share was rooted at {setup.get('sharePath')!r}")
    if not push.get("docConnected"):
        bad("the plugin's document never held an open socket")
    if not str(push.get("docUrl", "")).startswith("wss://"):
        bad(f"the plugin did not connect over wss, url was {push.get('docUrl')}")
    if push.get("inCrdt") != push.get("expected"):
        bad("the file's bytes did not reach the CRDT")
    if read.get("text") != push.get("expected"):
        bad("the other device did not receive the file's bytes off the relay")
    if remote not in land.get("inCrdt", ""):
        bad("what the other device wrote did not reach the plugin")
    if remote not in land.get("onDisk", ""):
        bad("what the other device wrote never landed in the vault file")
    if not land.get("onDisk", "").startswith("# uit de vault"):
        bad("the original note body did not survive the round trip")

    summary[scope] = {
        "sharePath": setup.get("sharePath"),
        "bytesBefore": setup.get("bytesOnDisk"),
        "bytesAfter": len(land.get("onDisk", "")),
    }

print(json.dumps(summary))

if failures:
    print("\nFAIL")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("\nOK: a note goes disk -> CRDT -> relay -> another device and back, in both modes")
PYEOF
