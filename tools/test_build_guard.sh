#!/usr/bin/env bash
# The guard that claims to block off-site assets must itself be verified.
# Plant a canary in a copy of the build output and assert the guard rejects it.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -d _site ] || { echo "run tools/build.sh first"; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp -R _site "$TMP/_site"

check() {  # $1 = label, $2 = expected exit (0 clean / 1 caught)
  local out rc
  out=$(grep -rIoE 'https?://[a-zA-Z0-9.-]+|(^|[^:a-z])//[a-zA-Z0-9.-]+\.[a-z]' \
          --include='*.html' --include='*.css' --include='*.js' --include='*.svg' \
          "$TMP/_site" 2>&1 | grep -vE 'github\.com|www\.w3\.org' || true)
  [ -n "$out" ] && rc=1 || rc=0
  if [ "$rc" = "$2" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (expected $2, got $rc)"; exit 1; fi
}

check "clean build passes" 0
echo '<script src="https://evil.example/x.js"></script>' >> "$TMP/_site/index.html"
check "https CDN caught" 1
git checkout-index -a -f --prefix="$TMP/reset/" 2>/dev/null || true
cp _site/index.html "$TMP/_site/index.html"
check "restored build passes again" 0
echo 'body{background:url(//cdn.example/x.png)}' >> "$TMP/_site/style.css"
check "protocol-relative caught" 1
cp _site/style.css "$TMP/_site/style.css"
check "restored again" 0
echo "guard verified"
