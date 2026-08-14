#!/usr/bin/env python3
"""Self-host the webfonts at build time.

The runtime page must not reach a third party for anything. This fetches the
Google Fonts stylesheet once, downloads each woff2 next to it, and rewrites the
CSS to point at local files. Run in CI, never in the browser.
"""
import pathlib, re, sys, urllib.request

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_site")
CSS = ("https://fonts.googleapis.com/css2"
       "?family=Bricolage+Grotesque:wght@400;500;600;700"
       "&family=IBM+Plex+Mono:wght@400;500;600&display=swap")
# A modern UA is what makes Google serve woff2 rather than ttf.
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"}

(OUT / "fonts").mkdir(parents=True, exist_ok=True)
css = urllib.request.urlopen(urllib.request.Request(CSS, headers=UA), timeout=60).read().decode()

urls = sorted(set(re.findall(r"url\((https://[^)]+\.woff2)\)", css)))
if not urls:
    sys.exit("no woff2 URLs in the stylesheet — refusing to ship a page with no fonts")

for u in urls:
    name = u.rsplit("/", 1)[-1]
    if not name.endswith(".woff2"):
        name += ".woff2"
    dest = OUT / "fonts" / name
    if not dest.exists():
        dest.write_bytes(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read())
    # A short or non-woff2 file renders as a silent fallback font rather than an
    # error, so check it here where the build can still fail loudly.
    blob = dest.read_bytes()
    if len(blob) < 1000 or blob[:4] != b"wOF2":
        sys.exit(f"{name}: {len(blob)} bytes, magic {blob[:4]!r} — not a usable woff2")
    css = css.replace(u, f"fonts/{name}")

(OUT / "fonts.css").write_text(
    "/* Generated at build time by tools/fonts.py. Do not edit. */\n" + css)
print(f"fonts: {len(urls)} files, {sum(f.stat().st_size for f in (OUT/'fonts').iterdir())//1024} KB")
