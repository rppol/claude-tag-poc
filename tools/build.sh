#!/usr/bin/env bash
# Build the static site. Everything expensive happens here, so the runtime page
# fetches nothing and runs no diagram library.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=_site
rm -rf "$OUT"; mkdir -p "$OUT/diagrams"

echo "→ rendering diagrams"
for f in docs/diagrams/*.mmd; do
  n=$(basename "$f" .mmd)
  npx -y @mermaid-js/mermaid-cli@11 -i "$f" -o "$OUT/diagrams/$n.svg" \
      -c tools/mermaid.json -p tools/puppeteer.json -b transparent --quiet
  echo "  $n.svg  $(wc -c < "$OUT/diagrams/$n.svg" | tr -d ' ') bytes"
done

echo "→ sizing diagrams"
python3 tools/svgfix.py "$OUT"

echo "→ self-hosting fonts"
# macOS python.org builds ship without a populated CA bundle. No-op on CI images.
if [ -z "${SSL_CERT_FILE:-}" ] && python3 -c 'import certifi' 2>/dev/null; then
  export SSL_CERT_FILE="$(python3 -c 'import certifi;print(certifi.where())')"
fi
python3 tools/fonts.py "$OUT"

echo "→ copying static files"
# GLOB, not a list of names. The previous version named sim.js explicitly, so
# adding a script would have shipped a page with a ReferenceError — and the
# off-site guard could not catch it, because a missing file is not an off-site
# reference. The assertion below is the check that would have caught it.
cp docs/index.html docs/style.css docs/*.js "$OUT/"

echo "→ checking every script and diagram actually shipped"
missing=""
for f in docs/*.js; do
  [ -f "$OUT/$(basename "$f")" ] || missing="$missing $(basename "$f")"
done
for ref in $(grep -o 'diagrams/[a-z_]*\.svg' docs/index.html | sort -u); do
  [ -f "$OUT/$ref" ] || missing="$missing $ref"
done
if [ -n "$missing" ]; then echo "FAIL: referenced but not built:$missing"; exit 1; fi
# And the other direction: a diagram nobody references is a diagram nobody
# maintains. Three stale ones were drawing a roster that had been deleted.
for f in docs/diagrams/*.mmd; do
  n=$(basename "$f" .mmd)
  grep -q "diagrams/$n.svg" docs/index.html || { echo "FAIL: diagrams/$n.mmd is referenced by nothing"; exit 1; }
done
for s in docs/*.js; do
  grep -q "$(basename "$s")" docs/index.html || { echo "FAIL: $(basename "$s") is loaded by nothing"; exit 1; }
done
echo "  $(ls docs/*.js | wc -l | tr -d ' ') scripts, $(ls docs/diagrams/*.mmd | wc -l | tr -d ' ') diagrams, all referenced and all built"

echo "→ checking nothing is fetched at runtime"
tools/guard.sh "$OUT" || exit 1

echo "✓ built $(find "$OUT" -type f | wc -l | tr -d ' ') files into $OUT/"
