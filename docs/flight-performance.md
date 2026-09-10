# Flight rendering performance

This report records the first optimisation, commit `76317d0`. Its reproduction
commands assume that checkout. See [the second-pass report](flight-performance-phase-two.md)
for the current renderer, its additional improvements, and updated verification.

Measured on 10 September 2026 against commit `1cdd54cb4fda0a0de9a205f0337f4388b7cde7c5`.
The target was at least 30% higher flight FPS with unchanged visual fidelity.

| Layout | Baseline FPS | Optimised FPS | Improvement |
| --- | ---: | ---: | ---: |
| Desktop, 1280 × 1000, pixel ratio 1 | 7.10 | 10.22 | **43.9%** |
| Mobile, 390 × 844, pixel ratio 2 | 6.92 | 10.97 | **58.7%** |
| Mobile, 100 countries already answered | 5.74 | 8.34 | **45.3%** |

These are production builds in Playwright Chromium 145.0.7632.6 on an Apple M4,
with **6× CPU throttling**. Mobile uses touch/mobile emulation. These measurements
represent CPU-constrained browser workloads, not measurements on a physical phone.

Each build/layout in the default game state ran three repetitions of GBR → USA → AUS → JPN → BRB → FRA → GBR
(18 measured flights), following two warm-up flights. The camera starts each leg
at the preceding destination. Flights retain their original 1,700 ms duration.
The benchmark uses the game's existing requestAnimationFrame timing, aggregating
sampled frame counts divided by sampled frame time. Warm-ups and CPU profiling
are excluded. Builds ran sequentially, without simultaneous screenshot tests.
Desktop was measured baseline first; mobile was measured optimised first.

Desktop improvement was 43.1%, 44.3%, and 44.2% across the three repetitions.
Every individual desktop route improved, ranging from 39.7% to 48.3% when
aggregated across repetitions. The initial exploratory run is excluded from the
table above.

The additional 100-answer check ran one repetition of the same six routes on
each build, with actual answers entered through the game's input handler.
Countries were spread across the full country list, adding solved fills, names,
capitals, and flags. This checks that the gain persists as the game progresses;
the three-repeat measurements above use the default starting game state.

## Changes

- Project the land geometry once per frame and use the identical SVG path for
  both its fill and coastline. Previously, D3 repeated the spherical clipping,
  projection, and path-string construction.
- Update SVG label text, flags, and styling only when their content or tone
  changes. Position updates continue every frame. This avoids recreating SVG
  text nodes and repeatedly setting unchanged attributes.
- Reuse projected label centroids within each frame when positioning the plane.
  Clear this cache every render, so rotation, zoom, resize, and projection changes
  always use fresh positions. Removed label elements are weakly held.

No geometry, projection precision, detail-switching thresholds, colours, label
placement, pixel density, or animation timing changed.

## Validation

`npm run build` passes. Playwright interaction checks confirmed immediate answer
acceptance, dragging, and showing/hiding capital labels after rendering.

The visual regression script compares complete SVG markup at identical virtual
animation times, separately from the real-time FPS benchmark. **104 SVG states
matched exactly. All 44 screenshot comparisons had zero differing pixels.**
Coverage includes desktop, mobile with flags and capitals, route mode, Mercator,
Equal Earth, answered countries, four intermediate flight positions per leg,
landings, and zooming. Both builds use the same original, pinned flag assets,
served locally during visual checks to remove CDN timing differences.

The screenshot check permits at most two colour levels of rasterisation noise
within the outer two pixels of the card; this run needed no tolerance. SVG markup
and every interior screenshot pixel must always match exactly.

## Reproduce

Create a separate baseline build, leaving the current checkout intact:

```sh
git worktree add --detach ../country-quiz-fps-baseline 1cdd54cb4fda0a0de9a205f0337f4388b7cde7c5
(cd ../country-quiz-fps-baseline && npm ci && npm run build)
npm run build

node scripts/benchmark-flights.mjs ../country-quiz-fps-baseline/dist baseline-desktop 6 3
node scripts/benchmark-flights.mjs dist optimized-desktop 6 3
node scripts/benchmark-flights.mjs dist optimized-mobile 6 3 mobile
node scripts/benchmark-flights.mjs ../country-quiz-fps-baseline/dist baseline-mobile 6 3 mobile

node scripts/verify-globe-rendering.mjs ../country-quiz-fps-baseline/dist dist
```

The scripts use the existing Playwright development dependency and its Chromium
installation. The visual check downloads the app's pinned flag package once with
`npm pack` and extracts it with `tar`, without changing application dependencies.
Results and screenshots are written under the ignored `output/playwright/` directory.
Set `PROFILE=1` for an additional CPU profile after the timed benchmark, or
`SOLVED_COUNT=100` to benchmark a game with 100 evenly distributed countries
already answered.
