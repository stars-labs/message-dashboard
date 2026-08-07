#!/usr/bin/env sh
# Regenerate the PNG icons from public/favicon.svg, which is the single source of
# truth for the mark. Run this after editing the SVG, then commit the PNGs.
#
# Requires librsvg:  brew install librsvg
set -e
cd "$(dirname "$0")/.."

# Fallback favicon for browsers that ignore SVG icons. Transparent corners.
rsvg-convert -w 32  -h 32  public/favicon.svg -o public/favicon-32.png

# iOS home screen. iOS ignores transparency and applies its own rounded mask, so
# render on the tile's own orange: the SVG's corner radius then disappears into the
# background and the result is full-bleed, as Apple expects.
rsvg-convert -w 180 -h 180 --background-color '#F97316' public/favicon.svg -o public/apple-touch-icon.png

echo "regenerated: public/favicon-32.png public/apple-touch-icon.png"
