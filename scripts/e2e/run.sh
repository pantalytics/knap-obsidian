#!/usr/bin/env bash
#
# Run the scope end to end against a real Obsidian and assert on the result.
#
# Needs the Obsidian harness from the admin repo, which starts a real app in a
# container and lets you run an expression inside it with no screen:
#
#   cd ../knap-mcp-admin && scripts/dev/obsidian/obsidian.sh up
#   cd ../knap-mcp-admin && scripts/dev/obsidian/obsidian.sh plugin /tmp/knap-plugin
#
# The vault it drives needs a Projects/ folder with something nested under
# Projects/Deep/, which scripts/e2e/seed.js creates.
#
# There is no relay in this loop. This proves the scope model end to end, not
# sync end to end.
set -euo pipefail

HARNESS="${KNAP_OBSIDIAN_HARNESS:-../knap-mcp-admin/scripts/dev/obsidian/obsidian.sh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -x "$HARNESS" ]; then
	echo "harness not found at $HARNESS" >&2
	echo "set KNAP_OBSIDIAN_HARNESS to the admin repo's obsidian.sh" >&2
	exit 2
fi

raw="$("$HARNESS" eval "$(cat "$HERE/scope.e2e.js")" | tail -1)"
echo "$raw"

python3 - "$raw" <<'PY'
import json, sys

result = json.loads(json.loads(sys.argv[1]) if sys.argv[1].startswith('"') else sys.argv[1])

failures = []
def want(label, got, expected):
    if got != expected:
        failures.append(f"{label}: expected {expected!r}, got {got!r}")

v = result["vault"]
want("vault takes top level notes", v["hasTopLevel"], True)
want("vault takes nested notes", v["hasNested"], True)
want("vault leaks the config directory", v["leaksConfigDir"], False)
want("vault leaks a dot path", v["leaksDotPath"], False)

f = result["folder"]
want("folder stays in its subtree", f["onlySubtree"], True)
want("folder takes nested notes", f["hasNested"], True)
want("folder leaks a dot path", f["leaksDotPath"], False)

want("folder then vault", result["folderThenVault"], "refused")
want("vault then folder", result["vaultThenFolder"], "refused")

g = result["writeGuard"]
want("write into the config directory", g["configDir"], "refused")
want("write through a traversal", g["traversal"], "refused")
want("write to a dot path", g["dotPath"], "refused")
want("an ordinary write", g["ordinary"], "wrote")

d = result["disk"]
want("the ordinary write landed on disk", d["ordinaryLanded"], True)
want("the config directory is untouched on disk", d["configDirUntouched"], True)
want("the dot path is untouched on disk", d["dotPathUntouched"], True)

if failures:
    print("\nFAIL")
    for line in failures:
        print("  " + line)
    sys.exit(1)
print("\nOK: scope model holds end to end, %d notes in the vault share" % v["total"])
PY
