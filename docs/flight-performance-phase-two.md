# Second flight-rendering optimisation

This pass measures improvement **over the first performance PR commit**,
`76317d0f873eb8f0955790d2a60986e914054ccb`. The target is a further 50% increase
in flight FPS, preserving visual fidelity.

| Workload | First-pass baseline FPS | Final FPS | Further improvement |
| --- | ---: | ---: | ---: |
| Desktop | 10.34 | 16.84 | **62.8%** |
| Mobile | 11.16 | 17.06 | **52.9%** |
| Mobile, 100 countries answered | 8.55 | 13.26 | **55.1%** |

All three workloads exceed the additional 50% target. Across the three complete
route repetitions, final FPS ranges were 16.63–17.01, 17.02–17.09, and 13.14–13.36
respectively. Baseline ranges were 10.32–10.36, 11.11–11.22, and 8.26–8.76.

Measurements use production builds in Playwright Chromium 145.0.7632.6 on an
Apple M4 with **6× CPU throttling**. Desktop is 1280 × 1000 at pixel ratio 1;
mobile is 390 × 844 at pixel ratio 2 with mobile/touch emulation. These are
CPU-constrained browser measurements, not physical-phone measurements.

Each build and workload runs three repetitions of GBR → USA → AUS → JPN → BRB →
FRA → GBR (18 flights), after two warm-up flights. Flights keep their original
1,700 ms duration. FPS is total sampled rAF frames divided by total sampled
frame time. The 100-answer workload enters evenly distributed country names
through the actual input handler. Benchmarks run sequentially without concurrent
profiling or visual tests. The desktop and default-mobile baselines were measured
before the final build; the 100-answer case measured the final build first.
Earlier exploratory measurements are excluded from the results table.

## Rendering changes

`src/hemisphere-path.ts` prepares conservative spherical bounds for immutable
polygons and border lines. Shapes proved entirely behind the globe need no
projection. Shapes proved entirely in front can bypass horizon clipping.
Anything intersecting the horizon, too large to bound safely, or representing
the complement of a small polygon continues through D3's original clipper.
The bounds include the great-circle edges and polygon interiors, not just the
vertices.

The renderer snapshots the original projection's stream rather than copying
rotation values through degrees and radians. This preserves the original
floating-point coordinates. The fast path also preserves D3's handling of
duplicate vertices and degenerate rings. Geometry bounds are prepared once
when an atlas loads and shared across frames.

Label centroids are computed only when their complete bounds can reach the map.
The exclusion test includes generous text, flag, and shadow padding; uncertain
and horizon cases remain on the original path. The plane always computes its
full anchors, even for off-screen country labels. Off-screen flags are preloaded
at the original visibility threshold, preserving their image-request lead time.

Country fills and their primary labels share the same projected points within a
frame. D3's original centroid accumulator and SVG path builder receive those
points together, avoiding a second projection without changing either output.
Unchanged solved-country fill and outline attributes are also cached per element.

All map path strings retain their original geometry and precision. There is no
viewport cropping of visible paths, additional simplification, reduced pixel
density, shortened animation, or hidden visible detail. Flat projections retain
their existing renderer.

## Validation

The geometry verifier compares against the installed D3 implementation across
24 rotations (including poles, near-horizon cases, and seeded random rotations)
and scales of 150, 600, and 5000. It exercises all three generated atlases,
the normalized tiny-country fallback shapes, polygon holes and complements,
duplicate vertices, empty geometry, and stream transitions between lines, points,
and the sphere. **55,872 paths and 55,224 label-centroid cases matched D3 exactly.**
All **110,448 viewport-exclusion checks** passed, including 24,339 culled cases.

The browser verifier compares every map path and every visible label/plane
attribute exactly. It ignores only labels whose measured DOM bounds, expanded
to include shadows, lie entirely outside the map. **150 SVG states matched and
all 66 screenshot comparisons were pixel-identical**, requiring no tolerance.
The original small card-border noise allowance remains available; interior
pixels must always match exactly.

Coverage includes desktop, mobile with flags/capitals, mobile with 100 answers,
the zoomed-out overview, route skips, Mercator, Equal Earth, intermediate flight
positions, landings, zooming, dragging, label-setting changes, and switching
projections in both directions. The verifier explicitly settles page scrolling
before sampling screenshots: earlier zoom-control captures showed raster
differences despite identical SVG until this capture timing was fixed. The final
complete run passed without relaxing the comparison. `npm run build` passes,
and the browser checks and benchmarks report no application errors.

## Reproduce

Build the baseline commit in a separate checkout and use its `dist` directory
as `BASELINE_DIST` below. Build the current checkout with `npm run build`.
Run FPS measurements sequentially, separately from geometry and screenshot tests.

```sh
node scripts/benchmark-flights.mjs BASELINE_DIST phase-two-baseline-desktop 6 3
node scripts/benchmark-flights.mjs dist phase-two-final-desktop 6 3
node scripts/benchmark-flights.mjs BASELINE_DIST phase-two-baseline-mobile 6 3 mobile
node scripts/benchmark-flights.mjs dist phase-two-final-mobile 6 3 mobile
SOLVED_COUNT=100 node scripts/benchmark-flights.mjs dist phase-two-final-100-solved 6 3 mobile
SOLVED_COUNT=100 node scripts/benchmark-flights.mjs BASELINE_DIST phase-two-final-baseline-100-solved 6 3 mobile

node scripts/verify-hemisphere-path.mjs
IGNORE_OFFSCREEN_LABELS=1 VISUAL_OUTPUT=output/playwright/phase-two-visual \
  node scripts/verify-globe-rendering.mjs BASELINE_DIST dist
```

The geometry verifier needs Node 22.18+ to load the renderer's erasable
TypeScript. The browser checks use the existing Playwright dependency.
