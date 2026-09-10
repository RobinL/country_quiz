import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { geoEqualEarth, geoMercator, geoPath } from 'd3'
import { feature, mesh } from 'topojson-client'
import { serveBuild } from './lib/serve-build.mjs'

// Check the app's actual cached SVG against a fresh D3 projection at each
// camera transform, using the same or finer precision than the old renderer.
const atlas = JSON.parse(await readFile(new URL('../src/generated/globe-detail-atlas.json', import.meta.url)))
const geometries = [feature(atlas, atlas.objects.land), mesh(atlas, atlas.objects.countries, (a, b) => a !== b)]
const server = await serveBuild(process.argv[2] ?? 'dist')
const browser = await chromium.launch()
let checkedPoints = 0
let maxError = 0
try {
  for (const [name, createProjection] of [['mercator', geoMercator], ['equal-earth', geoEqualEarth]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') })
    await page.goto(`${server.url}?projection=${name}`)
    await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
    await page.clock.pauseAt(new Date('2026-09-10T12:01:00Z'))
    for (const destination of ['USA', 'AUS', 'BRB']) {
      await page.evaluate(to => { void window.__countriesQuizDebug.benchmarkFlight('GBR', to) }, destination)
      for (const elapsed of [600, 600, 1100]) {
        await page.clock.fastForward(elapsed)
        const actual = await page.locator('.globe-frame').evaluate(el => {
          const paths = [...el.querySelectorAll('.globe__coastlines, .globe__borders')]
          return {
            referenceScale: Number(el.dataset.pathReferenceScale),
            paths: paths.map(path => {
              const { a, b, c, d, e, f } = path.transform.baseVal.consolidate().matrix
              return { d: path.getAttribute('d'), transform: { a, b, c, d, e, f }, vectorEffect: getComputedStyle(path).vectorEffect }
            }),
          }
        })
        for (const [i, path] of actual.paths.entries()) {
          assert.equal(path.vectorEffect, 'non-scaling-stroke')
          const { a: ratio, e: x, f: y } = path.transform
          assert(ratio > 0 && ratio <= 1)
          const projection = createProjection().clipAngle(null).rotate([0, 0, 0])
            .scale(actual.referenceScale * ratio).translate([x, y]).precision(0.6 * ratio)
          const expected = geoPath(projection).digits(null)(geometries[i]) ?? ''
          const tokenize = value => value.match(/[MLZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
          const a = tokenize(path.d)
          const b = tokenize(expected)
          assert.equal(a.length, b.length, `${name}: cached geometry changed sampling`)
          for (let j = 0; j < a.length;) {
            const command = a[j]
            assert.equal(command, b[j++])
            if (command === 'Z') continue
            const actualX = Number(a[j]) * ratio + x
            const expectedX = Number(b[j++])
            const actualY = Number(a[j]) * ratio + y
            const expectedY = Number(b[j++])
            const error = Math.hypot(actualX - expectedX, actualY - expectedY)
            maxError = Math.max(maxError, error)
            assert(error < 0.00001, `${name}: projection changed by ${error} pixels`)
            checkedPoints++
          }
        }
      }
      if (destination === 'AUS') {
        await page.setViewportSize({ width: 1100, height: 900 })
        await page.clock.fastForward(256)
      }
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
  const summary = { checkedPoints, maxErrorPixels: maxError }
  await writeFile('output/playwright/flat-geometry.json', JSON.stringify(summary, null, 2))
  console.log(summary)
} finally {
  await browser.close()
  server.close()
}
