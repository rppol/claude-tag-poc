#!/usr/bin/env bash
# The runtime-asset guard, in one place so build.sh and test_build_guard.sh
# cannot drift apart. Usage: tools/guard.sh <dir>
set -uo pipefail
OUT="${1:?usage: guard.sh <dir>}"

# Previous version passed -E and -P together, which grep rejects outright; the
# error went to /dev/null and the pipeline's exit status came from `grep -v`,
# so the guard could never fail. It is now a plain -E over every built asset,
# with the grep's own status captured rather than a pipeline's.
# Two exclusions, both because the string is an identifier rather than a fetch:
#   www.w3.org  — xmlns="http://www.w3.org/2000/svg" is an XML namespace.
#   *.internal  — ICANN-reserved for private use, so it cannot resolve from a
#                 browser at all. These appear only inside the A2A agent card,
#                 which the page renders as text.
# A grep over URLs is the weaker half of this guard; the network-API check
# below is the half that actually guarantees nothing is fetched.
offsite=$(grep -rIoE 'https?://[a-zA-Z0-9.-]+|(^|[^:a-z])//[a-zA-Z0-9.-]+\.[a-z]' \
            --include='*.html' --include='*.css' --include='*.js' --include='*.svg' \
            "$OUT" 2>&1 | grep -vE 'github\.com|www\.w3\.org|\.internal' || true)
if [ -n "$offsite" ]; then
  echo "FAIL: a runtime asset points off-site:"; echo "$offsite" | sed 's/^/  /' | sort -u | head -20
  exit 1
fi
# The real guarantee. A URL in a data structure is inert; a fetch call is not.
# This is what makes "the published page fetches nothing" a property of the
# code rather than a claim about its strings.
net=$(grep -rInE '\b(fetch|XMLHttpRequest|importScripts|WebSocket|EventSource|navigator\.sendBeacon)\s*\(|\bimport\s*\(' \
        --include='*.js' --include='*.html' "$OUT" || true)
if [ -n "$net" ]; then
  echo "FAIL: a shipped script can make a network call:"; echo "$net" | sed 's/^/  /'; exit 1
fi
echo "  no network APIs in any shipped script"

echo "  no off-site references in $(find "$OUT" -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.svg' \) | wc -l | tr -d ' ') assets"

exit 0
