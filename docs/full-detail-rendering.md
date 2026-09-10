# Full detail during motion

The previous renderer used the 1:50m atlas while flying, dragging or zooming,
then switched to the existing 1:10m atlas after motion stopped. This change uses
the 1:10m atlas throughout. Its source geometry and preprocessing are unchanged;
the coarser atlases remain useful for existing label anchors and hit testing.
All atlas downloads start together, and the globe waits for full detail before
becoming interactive. There is no animation-detail state or delayed swap.

Simply removing the switch reduced the exploratory 6×-throttled mobile result
from 15.94 to 5.66 FPS. The additional rendering work below makes retaining full
detail practical.

## FPS results and remaining limitation

| Workload | Previous adaptive-detail FPS | Full-detail FPS | Change |
| --- | ---: | ---: | ---: |
| Desktop globe | 16.10 | 22.76 | +41.4% |
| Mobile globe | 17.25 | 30.04 | +74.2% |
| Mobile globe, 100 answers | 13.44 | 24.13 | +79.5% |
| Mobile Mercator | 7.96 | 18.14 | +127.9% |

These averages exceed the original 30% target while retaining full display detail.
They do **not** demonstrate equal or better FPS on every route. Wide globe views
still expose many more visible vertices than the old animation atlas. The
USA → Australia flight remains slower; the animation simplification still has a
performance benefit in that case. This change deliberately prioritizes full detail
throughout and should not be described as a universal performance win.

| USA → Australia | Previous FPS | Full-detail FPS | Change |
| --- | ---: | ---: | ---: |
| Desktop globe | 19.09 | 7.43 | -61.1% |
| Mobile globe | 20.72 | 14.08 | -32.0% |
| Mobile globe, 100 answers | 16.49 | 10.26 | -37.8% |

Desktop United Kingdom → USA also remains slightly slower (see the route table
below). Other measured mobile routes improve. Benchmark JSON now reports each
route separately, as well as the overall average.

| Route | Desktop before → after FPS | Mobile before → after FPS |
| --- | ---: | ---: |
| GBR → USA | 14.43 → 13.42 | 15.44 → 21.97 |
| USA → AUS | 19.09 → 7.43 | 20.72 → 14.08 |
| AUS → JPN | 18.59 → 20.39 | 19.88 → 29.62 |
| JPN → BRB | 16.18 → 39.58 | 16.87 → 45.36 |
| BRB → FRA | 14.59 → 36.47 | 15.92 → 41.69 |
| FRA → GBR | 13.82 → 20.20 | 14.72 → 27.97 |

## How the renderer avoids unnecessary work

For the globe, immutable coordinate chains have a hierarchy of conservative
spherical bounds. A chain can be skipped only if its entire convex cap is behind
the globe or outside the viewport plus 128 CSS pixels. The original vertices
remain stored. The temporary drawing stream joins the hidden chain's endpoints;
that connecting geodesic also lies wholly inside the same hidden cap. Every
potentially visible edge continues through D3 with its original coordinates and
projection precision. Uncertain bounds and complements keep the original path.
A minor ring that collapses wholly into a proven invisible cap can be omitted.
This preserves visible boundaries and polygon winding.

A final rectangular clip 64 CSS pixels beyond the viewport keeps invisible
coordinates out of the SVG rasteriser. This pass is omitted when the whole globe
already fits inside that rectangle. It is deliberately inside the 128-pixel
guard used by the bounds tree, and well outside the widest stroke. The full-detail
reference build applies this same final clip without skipping coordinate chains.
When the entire globe rim is outside the padded viewport, cap bounds can also
exclude chains crossing the horizon: any changed horizon-clipping arcs remain
offscreen. The screen tests otherwise require a cap wholly on the front side.
Label centroids and plane anchors use the original, untrimmed geometry.

A dedicated line/polygon SVG writer avoids D3's generic tagged-template loop.
It preserves D3's coordinate order, commands, and three-decimal rounding, and is
covered by the whole-path comparisons. Point and sphere geometries keep D3's
original writer.

Flat-map projections have fixed orientation: flights, dragging, and zooming only
change scale and translation. Their full geometry is projected once at maximum
zoom precision and reused with an SVG matrix transform. Strokes do not scale.
All source vertices are retained; smaller zooms have finer curve sampling than
the previous renderer. Projection changes and resizing rebuild the cache. Labels
and flight paths continue using their existing screen-coordinate renderer.

## Verification

The visible-edge verifier compares against D3 projecting every coordinate with
the same final clip. It covers all three atlases, tiny-country fallbacks, dense
holes and duplicate rings, complements, 24 rotations, and three scales from
zoomed-out to close-up. Visible segments are clipped to the screen, normalized
for order/direction, and compared to six decimal places. Duplicate zero-length
edges have no visible extent and are ignored.

All 55,440 geometry cases passed, covering 3,305,530 visible edges. The existing
whole-path and centroid suite also passes (55,872 paths, 55,224 label-centroid
cases, and 110,448 viewport-exclusion checks).

Browser checks compare labels, plane, styles, and flight paths exactly, and
independently compare the visible segments of every static map path after its
SVG transform. Pixel comparisons render the captured component DOM and original
stylesheet afresh, with the original size and device pixel ratio. Each
independently captured reference/result pair is rasterized together to remove
animation/scroll paint history and reduce cross-run rasterization variability.
They use a fixed software rasteriser; FPS
measurements use Chromium's normal rendering configuration. The pixel comparison
requires exact interior pixels whenever render inputs differ. Chromium can
occasionally rasterize byte-identical complete component HTML and CSS differently;
those cases are counted separately and cannot excuse any changed geometry or style.

The complete browser suite checks 150 states, 22,762 visible paths, and 66
reference/result snapshot pairs, including the zoomed-out overview, mobile with
100 answers, route skips, dragging, zooming, label changes, and projection switches.
All 66 pairs were pixel-identical in the final run: zero border noise, zero
changed-input interior differences, and zero identical-input raster exceptions.
The headed Playwright CLI smoke check also verified immediate answer acceptance
and zooming in the production build.

The flat-map check compares the actual cached SVG and matrix against a fresh D3
projection for intermediate and completed flights in Mercator and Equal Earth,
including a viewport resize that invalidates the cache. It checked 1,414,816 projected points with a maximum difference of 0.000000707
CSS pixels, and confirmed that strokes use `non-scaling-stroke`.

## Reproduce

Use a separate production build of commit `6ed59e0` as `BASELINE_DIST` for the
previous adaptive-detail renderer. Build the current checkout normally.

```sh
npm run build
node scripts/build-full-detail-reference.mjs
node scripts/verify-visible-geometry.mjs
node scripts/verify-hemisphere-path.mjs
node scripts/verify-flat-geometry.mjs
FRESH_RASTER=1 SOFTWARE_RASTER=1 CLIPPED_PATHS=1 IGNORE_OFFSCREEN_LABELS=1 \
  VISUAL_OUTPUT=output/playwright/full-detail-final-visual \
  node scripts/verify-globe-rendering.mjs \
  output/playwright/full-detail-reference-project/dist dist

node scripts/benchmark-flights.mjs BASELINE_DIST full-detail-baseline-desktop 6 3
node scripts/benchmark-flights.mjs dist full-detail-final-desktop 6 3
node scripts/benchmark-flights.mjs dist full-detail-final-mobile 6 3 mobile
node scripts/benchmark-flights.mjs BASELINE_DIST full-detail-baseline-mobile 6 3 mobile
SOLVED_COUNT=100 node scripts/benchmark-flights.mjs BASELINE_DIST full-detail-baseline-solved 6 3 mobile
SOLVED_COUNT=100 node scripts/benchmark-flights.mjs dist full-detail-final-solved 6 3 mobile
QUERY='?projection=mercator' node scripts/benchmark-flights.mjs BASELINE_DIST full-detail-baseline-mercator 6 3 mobile
QUERY='?projection=mercator' node scripts/benchmark-flights.mjs dist full-detail-final-mercator 6 3 mobile
```

Run benchmarks sequentially, separately from visual and geometry checks. These
are production builds in Playwright Chromium with 6× CPU throttling on an Apple
M4, not measurements on a physical phone. Desktop uses 1280 × 1000 at pixel ratio
1; mobile uses 390 × 844 at pixel ratio 2 with touch emulation. Each final result
uses 18 measured 1,700 ms flights after two warm-up flights. The 100-answer case
uses actual input events with countries spread across the country list.

The benchmark's existing debug flight helper resets the displayed route to the
measured leg. The 100-answer workload therefore measures populated country fills
and labels, rather than 100 accumulated flight trails. Flight duration, camera
motion, and trail rendering are unchanged by this optimization.
