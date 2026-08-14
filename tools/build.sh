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
# Previous version passed -E and -P together, which grep rejects outright; the
# error went to /dev/null and the pipeline's exit status came from `grep -v`,
# so the guard could never fail. It is now a plain -E over every built asset,
# with the grep's own status captured rather than a pipeline's.
# w3.org is excluded because xmlns="http://www.w3.org/2000/svg" is an XML
# namespace identifier, not a fetch — nothing resolves it over the network.
offsite=$(grep -rIoE 'https?://[a-zA-Z0-9.-]+|(^|[^:a-z])//[a-zA-Z0-9.-]+\.[a-z]' \
            --include='*.html' --include='*.css' --include='*.js' --include='*.svg' \
            "$OUT" 2>&1 | grep -vE 'github\.com|www\.w3\.org' || true)
if [ -n "$offsite" ]; then
  echo "FAIL: a runtime asset points off-site:"; echo "$offsite" | sed 's/^/  /' | sort -u | head -20
  exit 1
fi
echo "  no off-site references in $(find "$OUT" -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.svg' \) | wc -l | tr -d ' ') assets"

echo "✓ built $(find "$OUT" -type f | wc -l | tr -d ' ') files into $OUT/"
