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
cp docs/index.html docs/style.css docs/sim.js "$OUT/"

echo "→ checking nothing is fetched at runtime"
if grep -rInE 'https?://(?!github\.com)' "$OUT"/*.html "$OUT"/*.css "$OUT"/*.js -P 2>/dev/null | grep -v 'github.com/rppol'; then
  echo "FAIL: a runtime asset still points off-site"; exit 1
fi
echo "✓ built $(find "$OUT" -type f | wc -l | tr -d ' ') files into $OUT/"
