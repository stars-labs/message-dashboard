# Icon sources

Build-time sources, deliberately **outside `public/`** — Vite copies `public/`
verbatim into `dist/`, so anything left there ships to production even when nothing
references it.

`icon-maskable.svg` is the full-bleed variant of `public/favicon.svg`. It exists
separately because the two have incompatible requirements: the launcher applies its
own mask, so the maskable one must have square corners, orange to all four edges, and
the mark confined to the centre circle of 80% diameter. See the comment inside the
file for the geometry.

Regenerate the PNGs after editing either SVG (`rsvg-convert` comes from `librsvg`):

```bash
cd sms-dashboard
rsvg-convert -w 192 -h 192 public/favicon.svg      -o public/icon-192.png
rsvg-convert -w 512 -h 512 public/favicon.svg      -o public/icon-512.png
rsvg-convert -w 512 -h 512 assets-src/icon-maskable.svg -o public/icon-maskable-512.png
```

`icon-maskable-512.png` should come out as RGB with no alpha channel — that is the
check that the orange really does reach every edge.
