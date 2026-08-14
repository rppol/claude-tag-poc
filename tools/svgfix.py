#!/usr/bin/env python3
"""Give each rendered SVG a real intrinsic size.

mermaid-cli emits width="100%" plus an inline max-width. That is fine inline,
but an <img> has no containing block to resolve a percentage against, so the
browser falls back to 300x150 and the diagram is clipped. Setting width/height
from the viewBox restores the aspect ratio; the page's CSS then scales it with
max-width:100% and height:auto.
"""
import pathlib, re, sys

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_site") / "diagrams"
fixed = 0
for f in sorted(out.glob("*.svg")):
    s = f.read_text()
    m = re.search(r'viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"', s)
    if not m:
        sys.exit(f"{f.name}: no viewBox — cannot size it, refusing to ship a clipped diagram")
    w, h = float(m.group(3)), float(m.group(4))
    head = re.search(r"<svg\b[^>]*>", s).group(0)
    new = head
    new = re.sub(r'\swidth="[^"]*"', "", new)
    new = re.sub(r'\sheight="[^"]*"', "", new)
    new = re.sub(r'\sstyle="[^"]*"', "", new)          # drops max-width
    new = new.replace("<svg", f'<svg width="{w:.0f}" height="{h:.0f}"', 1)
    f.write_text(s.replace(head, new, 1))
    print(f"  {f.name}  {w:.0f}x{h:.0f}")
    fixed += 1
print(f"svg: sized {fixed} diagrams")
