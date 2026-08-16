#!/usr/bin/env bash
# The guard that claims to block off-site assets and network calls must itself
# be verified. Plant canaries in a copy of the build output and assert each is
# caught. It calls tools/guard.sh — the same script build.sh runs — because the
# previous version reimplemented the greps and could never fail.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -d _site ] || { echo "run tools/build.sh first"; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp -R _site "$TMP/_site"

check() {  # $1 = label, $2 = expected exit (0 clean / 1 caught)
  tools/guard.sh "$TMP/_site" >/dev/null 2>&1; local rc=$?
  if [ "$rc" = "$2" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (expected $2, got $rc)"; exit 1; fi
}

check "clean build passes" 0

echo '<script src="https://evil.example/x.js"></script>' >> "$TMP/_site/index.html"
check "https CDN caught" 1
cp _site/index.html "$TMP/_site/index.html"; check "restored" 0

echo 'body{background:url(//cdn.example/x.png)}' >> "$TMP/_site/style.css"
check "protocol-relative caught" 1
cp _site/style.css "$TMP/_site/style.css"; check "restored" 0

# The check that matters most: a URL is inert, a call is not.
echo 'fetch("/api/x").then(r=>r.json());' >> "$TMP/_site/sim.js"
check "a fetch() call caught" 1
cp _site/sim.js "$TMP/_site/sim.js"; check "restored" 0

echo 'const s=new WebSocket("wss://x.example");' >> "$TMP/_site/sim.js"
check "a WebSocket caught" 1
cp _site/sim.js "$TMP/_site/sim.js"; check "restored" 0

echo "guard verified"
