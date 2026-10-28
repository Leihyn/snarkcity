#!/usr/bin/env python3
# Builds the SnarkCity wordmark and favicon as plain SVG paths from Big Shoulders
# Display ExtraBold (SIL OFL), so the files need no font. The I of CITY is drawn
# as a lit window: amber, split by one mullion halfway up.
#   python3 make.py path/to/BigShouldersDisplay-ExtraBold.ttf
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

CHALK, NIGHT, AMBER = "#EEE8DA", "#0F1420", "#F2B33D"
TRACK = 40  # extra space between letters, font units
import os
MULLION = float(os.environ.get("MULLION", "0.5"))  # share of the height above the mullion

font = TTFont(sys.argv[1])
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
upm = font["head"].unitsPerEm
cap = font["OS/2"].sCapHeight

def glyph(ch):
    name = cmap[ord(ch)]
    pen = SVGPathPen(gs); gs[name].draw(pen)
    b = BoundsPen(gs); gs[name].draw(b)
    return pen.getCommands(), hmtx[name][0], b.bounds

def window(x0, x1, colour):
    # The I as a window: its stem, cut by one mullion.
    w = x1 - x0; bar = max(18, round(cap * 0.05)); top = cap * (1 - MULLION)  # y is up here
    return (f'<path fill="{colour}" d="M{x0} 0H{x1}V{top - bar / 2:.0f}H{x0}Z'
            f'M{x0} {top + bar / 2:.0f}H{x1}V{cap}H{x0}Z" transform="translate(0 0)"/>')

def wordmark(ink):
    x, parts = 0, []
    for i, ch in enumerate("SNARKCITY"):
        d, adv, (bx0, _, bx1, _) = glyph(ch)
        if ch == "I" and i == 6:
            parts.append(f'<g transform="translate({x} 0)">{window(round(bx0), round(bx1), AMBER)}</g>')
        else:
            parts.append(f'<path transform="translate({x} 0)" fill="{ink}" d="{d}"/>')
        x += adv + TRACK
    width = x - TRACK
    pad = 0
    body = "".join(parts)
    # Font units have y up; flip into SVG space.
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-cap - pad} {width} {cap + 2 * pad}" '
            f'width="{width / 4:.0f}" height="{cap / 4:.0f}"><title>SnarkCity</title>'
            f'<g transform="scale(1 -1)">{body}</g></svg>')

def favicon():
    # The lit window alone on a night tile, wide enough to hold at 16 px.
    _, _, (bx0, _, bx1, _) = glyph("I")
    size = cap * 1.25; w = size * 0.36
    x0, y0 = (size - w) / 2, (size - cap) / 2
    bar = max(18, round(cap * 0.05)) * 1.6
    upper, lower = cap * MULLION - bar / 2, cap * (1 - MULLION) - bar / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size:.0f} {size:.0f}">'
            f'<rect width="{size:.0f}" height="{size:.0f}" rx="{size * 0.2:.0f}" fill="{NIGHT}"/>'
            f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{upper:.0f}" fill="{AMBER}"/>'
            f'<rect x="{x0:.0f}" y="{y0 + upper + bar:.0f}" width="{w:.0f}" height="{lower:.0f}" fill="{AMBER}"/></svg>')

open("wordmark-on-dark.svg", "w").write(wordmark(CHALK))
open("wordmark-on-light.svg", "w").write(wordmark(NIGHT))
open("favicon.svg", "w").write(favicon())
print("cap", cap, "upm", upm)
