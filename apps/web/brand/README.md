# The mark

`icon-source.png` is the artwork, cropped and flattened, at 981×981. Everything
in `../public/icon-*.png` is a scaled copy of it.

## How it was made

The original render is 1254×1254 with a transparent field and the mark sitting
off-centre in it. Two steps, in this order:

1. **Crop to the artwork, square, without distorting it.** The mark's bounding
   box is 981×707 — wider than tall — so the square is 981×981 centred on it.
   That leaves the mark touching the left and right edges with 137px above and
   below, which is as large as it can be inside a square without stretching.
2. **Composite onto white.** The mark is mostly dark blue, and on transparency
   it disappears into a dark browser tab. Flattening first also avoids the dark
   fringe that alpha-aware downscaling leaves around edges drawn against
   nothing.

Scaling to 16, 32, 180, 192 and 512 is a plain resample of the result.

## Regenerating

Nothing in the build does this: the icons are committed, because a build step
that needs an image toolchain is a build step that breaks on somebody's
machine. To change the mark, redo the two steps above and replace the files.
