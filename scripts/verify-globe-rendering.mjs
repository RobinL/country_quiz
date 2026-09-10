import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'
import { visibleSegments } from './lib/visible-segments.mjs'

// Compare SVG geometry, labels and screenshots at identical animation times.
// Run separately from the real-time FPS benchmark (this uses a fake clock).
const [baselineDir, currentDir = 'dist'] = process.argv.slice(2)
assert(baselineDir, 'Usage: node scripts/verify-globe-rendering.mjs <baseline-build> [current-build]')
const output = process.env.VISUAL_OUTPUT ?? 'output/playwright/visual'
await mkdir(output, { recursive: true })
// Obtain the same pinned assets as the app in one request, instead of making
// hundreds of CDN requests whose completion can vary between screenshots.
const flagsDirectory = 'output/playwright/flag-assets'
try {
  await readFile(`${flagsDirectory}/package/3x2/GB.svg`)
} catch {
  await mkdir(flagsDirectory, { recursive: true })
  const exec = promisify(execFile)
  await exec('npm', ['pack', 'country-flag-icons@1.5.19', '--pack-destination', flagsDirectory, '--silent'])
  await exec('tar', ['-xzf', `${flagsDirectory}/country-flag-icons-1.5.19.tgz`, '-C', flagsDirectory])
}
const browser = await chromium.launch(process.env.SOFTWARE_RASTER ? { args: ['--disable-gpu', '--disable-gpu-rasterization'] } : {})
const scenarios = [
  { name: 'desktop', query: '', width: 1280, height: 1000 },
  { name: 'mobile', query: '?flags=1&capitals=1', width: 390, height: 844 },
  { name: 'mobile-solved', query: '', width: 390, height: 844, solvedCount: 100 },
  { name: 'overview', query: '', width: 1280, height: 1000, overview: true },
  { name: 'route', query: '?mode=route', width: 1280, height: 1000 },
  { name: 'mercator', query: '?projection=mercator', width: 1280, height: 1000 },
  { name: 'equal-earth', query: '?projection=equal-earth', width: 1280, height: 1000 },
]
const selectedScenarios = (process.env.SCENARIOS ?? '').split(',').filter(Boolean)
const snapshots = new Map()
let checked = 0
let screenshots = 0
let borderNoisePixels = 0
let visiblePathChecks = 0
let identicalInputRasterCases = 0
let identicalInputRasterPixels = 0
const clippedPaths = Boolean(process.env.CLIPPED_PATHS)
const clippedSelector = '.globe__countries path, .globe__solved path, .globe__coastlines, .globe__borders, .globe__fallback-outlines path, .globe__hit-targets path'
try {
  for (const [build, directory] of [['baseline', baselineDir], ['current', currentDir]]) {
    const server = await serveBuild(directory)
    try {
      for (const scenario of scenarios) {
        if (selectedScenarios.length && !selectedScenarios.includes(scenario.name)) continue
        const context = await browser.newContext({
          viewport: { width: scenario.width, height: scenario.height },
          deviceScaleFactor: scenario.width < 841 ? 2 : 1,
          isMobile: scenario.width < 841,
          hasTouch: scenario.width < 841,
          serviceWorkers: 'block',
        })
        await context.route('https://cdn.jsdelivr.net/npm/country-flag-icons@1.5.19/3x2/*.svg', async route => {
          const filename = new URL(route.request().url()).pathname.split('/').at(-1)
          await route.fulfill({ contentType: 'image/svg+xml', body: await readFile(`${flagsDirectory}/package/3x2/${filename}`) })
        })
        const page = await context.newPage()
        const rasterPage = process.env.FRESH_RASTER ? await context.newPage() : null
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') })
        await page.goto(server.url + scenario.query)
        await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
        const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => link.href))
        const css = await page.evaluate(urls => Promise.all(urls.map(url => fetch(url).then(response => response.text()))), stylesheets)
        await page.waitForTimeout(1000)
        await page.clock.pauseAt(new Date('2026-09-10T12:01:00Z'))
        await page.clock.fastForward(256)
        if (scenario.solvedCount) {
          const records = JSON.parse(await readFile(new URL('../src/generated/quiz-country-records.json', import.meta.url)))
          const names = Array.from({ length: scenario.solvedCount }, (_, i) => records[Math.floor(i * records.length / scenario.solvedCount)].name)
          await page.evaluate(answers => {
            const input = document.querySelector('#guess-input')
            for (const answer of answers) {
              input.value = answer
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
          }, names)
          await page.clock.fastForward(2048)
          await page.clock.fastForward(256)
          assert((await page.locator('#score').textContent()).startsWith(`${scenario.solvedCount}/`))
        }
        if (scenario.overview) {
          for (let i = 0; i < 20; i++) {
            await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
            await page.clock.fastForward(32)
          }
          await page.clock.fastForward(256)
          assert.equal(await page.locator('.globe-frame').getAttribute('data-zoom'), '0.780')
        }
        const capture = async (state, screenshot = false) => {
          const key = `${scenario.name}-${state}`
          if (clippedPaths && build === 'current') {
            assert.equal(await page.locator('.globe-frame').getAttribute('data-detail-mode'), 'full', `${key}: full detail must stay enabled`)
          }
          if (screenshot) {
            // Clicking controls below the map can scroll the page. Settle that
            // scroll before sampling; screenshot() otherwise scrolls during capture.
            await page.locator('.globe-frame').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }))
            await page.clock.fastForward(32)
          }
          const geometry = clippedPaths ? await page.locator('.globe-frame').evaluate((el, selector) => ({
            projection: el.dataset.projection,
            width: el.querySelector('svg').viewBox.baseVal.width,
            height: el.querySelector('svg').viewBox.baseVal.height,
            rect: el.getBoundingClientRect().toJSON(),
            paths: [...el.querySelectorAll(selector)].map(path => {
              const matrix = el.querySelector('svg').getCTM().inverse().multiply(path.getCTM())
              return { d: path.getAttribute('d'), matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] }
            }),
          }), clippedSelector) : null
          const segments = geometry?.paths.map(path => visibleSegments(path.d, geometry.width, geometry.height, path.matrix))
          if (geometry?.projection === 'orthographic') {
            for (const path of geometry.paths) {
              assert(path.matrix.every((value, i) => Math.abs(value - [1, 0, 0, 1, 0, 0][i]) < 1e-9), `${key}: stale flat-map transform`)
            }
          }
          const svg = await page.locator('.globe-frame').evaluate((el, { visibleOnly, clippedPaths }) => {
            const clone = el.cloneNode(true)
            if (visibleOnly) {
              // Ignore only labels whose entire DOM bounds plus their shadows
              // are off-screen. Every map path and visible label remains exact.
              const frame = el.getBoundingClientRect()
              const clonedLabels = clone.querySelectorAll('.globe__label')
              el.querySelectorAll('.globe__label').forEach((label, i) => {
                const box = label.getBoundingClientRect()
                if (box.right + 36 < frame.left || box.left - 36 > frame.right ||
                  box.bottom + 36 < frame.top || box.top - 36 > frame.bottom) clonedLabels[i].remove()
              })
            }
            if (clippedPaths) {
              // Full-detail clipping has separate segment-geometry checks.
              // Keep all other attributes, labels, plane and flight paths exact.
              clone.querySelectorAll('.globe__countries path, .globe__solved path, .globe__coastlines, .globe__borders, .globe__fallback-outlines path, .globe__hit-targets path')
                .forEach(path => path.setAttribute('d', '[verified separately]'))
            }
            return clone.innerHTML
          }, { visibleOnly: Boolean(process.env.IGNORE_OFFSCREEN_LABELS), clippedPaths: Boolean(process.env.CLIPPED_PATHS) })
          if (screenshot) {
            await page.waitForLoadState('networkidle')
          }
          let screenshotPage = page
          let rasterMarkup = null
          let pairedReferencePng = null
          if (screenshot && rasterPage) {
            // Render the real component snapshot afresh. This removes paint
            // history and fractional scroll positions from pixel comparisons.
            rasterMarkup = await page.locator('.globe-frame').evaluate(el => {
              const clone = el.cloneNode(true)
              const box = el.getBoundingClientRect()
              clone.style.width = `${box.width}px`
              clone.style.height = `${box.height}px`
              return clone.outerHTML
            })
            const renderSnapshot = async (markup, styles) => {
              await rasterPage.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles.join('\n')}</style></head><body>${markup}</body></html>`)
              await rasterPage.waitForLoadState('networkidle')
              await rasterPage.evaluate(() => document.fonts.ready)
            }
            if (build === 'current') {
              const expected = snapshots.get(key)
              // Render the independently captured reference and result together
              // using their own original styles, avoiding cross-run paint state.
              await renderSnapshot(expected.rasterMarkup, expected.css)
              pairedReferencePng = await rasterPage.locator('.globe-frame').screenshot({ path: `${output}/baseline-${key}.png` })
            }
            await renderSnapshot(rasterMarkup, css)
            screenshotPage = rasterPage
          }
          const png = screenshot ? await screenshotPage.locator('.globe-frame').screenshot({ path: `${output}/${build}-${key}.png` }) : null
          if (build === 'baseline') snapshots.set(key, { svg, png, segments, geometry, rasterMarkup, css })
          else {
            const expected = snapshots.get(key)
            if (clippedPaths) {
              assert.deepEqual(segments, expected.segments, `${key}: visible geometry changed`)
              visiblePathChecks += segments.length
            }
            if (expected.svg !== svg) {
              await writeFile(`${output}/${key}-baseline.svg`, expected.svg)
              await writeFile(`${output}/${key}-current.svg`, svg)
            }
            assert(svg === expected.svg, `${key}: SVG changed (see saved SVGs)`)
            if (png) {
              screenshots++
              const referencePng = pairedReferencePng ?? expected.png
              if (!png.equals(referencePng)) {
                const diff = await page.evaluate(async ([before, after]) => {
                  const decode = async (data) => {
                    const image = new Image()
                    image.src = `data:image/png;base64,${data}`
                    await image.decode()
                    const canvas = document.createElement('canvas')
                    canvas.width = image.width
                    canvas.height = image.height
                    const ctx = canvas.getContext('2d')
                    ctx.drawImage(image, 0, 0)
                    return ctx.getImageData(0, 0, canvas.width, canvas.height)
                  }
                  const a = await decode(before)
                  const b = await decode(after)
                  if (a.width !== b.width || a.height !== b.height) return { invalid: 1, noise: 0 }
                  let invalid = 0
                  let noise = 0
                  for (let i = 0; i < a.data.length; i += 4) {
                    const delta = Math.max(...[0, 1, 2, 3].map(c => Math.abs(a.data[i + c] - b.data[i + c])))
                    if (!delta) continue
                    const x = i / 4 % a.width
                    const y = Math.floor(i / 4 / a.width)
                    // Only tolerate tiny rasterisation noise at the card edge.
                    // Every interior pixel, including all map detail, is exact.
                    if (delta <= 2 && (x < 2 || y < 2 || x >= a.width - 2 || y >= a.height - 2)) noise++
                    else invalid++
                  }
                  return { invalid, noise }
                }, [referencePng.toString('base64'), png.toString('base64')])
                if (diff.invalid && geometry) {
                  await writeFile(`${output}/${key}-geometry.json`, JSON.stringify({ baseline: expected.geometry, current: geometry, identicalDOM: rasterMarkup === expected.rasterMarkup, identicalCSS: JSON.stringify(css) === JSON.stringify(expected.css) }))
                }
                if (diff.invalid) {
                  // Chromium can cache/rasterize the exact same SVG differently.
                  // Only byte-identical complete inputs qualify; changed geometry
                  // or styles must still meet the original strict pixel check.
                  assert(rasterMarkup !== null && rasterMarkup === expected.rasterMarkup &&
                    JSON.stringify(css) === JSON.stringify(expected.css), `${key}: screenshot changed`)
                  identicalInputRasterCases++
                  identicalInputRasterPixels += diff.invalid
                }
                borderNoisePixels += diff.noise
              }
            }
            checked++
          }
        }
        await capture('initial', true)
        // Real answers exercise label content/tone changes and country fills.
        if (scenario.name === 'route') {
          await page.getByRole('button', { name: 'Skip', exact: true }).click()
          await page.clock.fastForward(2048)
          await page.clock.fastForward(256)
          await capture('skipped', true)
        } else if (!scenario.solvedCount) {
          await page.getByRole('searchbox').fill('France')
          await page.clock.fastForward(2048)
          await page.getByRole('searchbox').fill('United States')
          await page.clock.fastForward(2048)
          await page.clock.fastForward(256)
          await capture('answered', true)
        }
        let from = 'USA'
        for (const to of ['AUS', 'BRB', 'GBR']) {
          await page.evaluate(([a, b]) => { void window.__countriesQuizDebug.benchmarkFlight(a, b) }, [from, to])
          for (const step of [320, 320, 320, 320]) {
            await page.clock.fastForward(step)
            await capture(`${to}-${await page.evaluate(() => performance.now())}`, false)
          }
          await capture(`${to}-moving`, true)
          await page.clock.fastForward(768)
          await page.clock.fastForward(256)
          await capture(`${to}-settled`, true)
          from = to
        }
        if (scenario.width < 841) {
          await page.locator('.globe__map-svg').dispatchEvent('wheel', { deltaY: -80, bubbles: true })
        } else {
          await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
        }
        await page.clock.fastForward(512)
        await page.clock.fastForward(256)
        await capture('zoomed', true)
        if (scenario.name === 'desktop') {
          const frame = page.locator('.globe-frame')
          const beforeDrag = await frame.getAttribute('data-rotation-lon')
          const box = await page.locator('.globe__map-svg').boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
          await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 40, { steps: 8 })
          await page.mouse.up()
          await page.clock.fastForward(512)
          await page.clock.fastForward(256)
          assert.notEqual(await frame.getAttribute('data-rotation-lon'), beforeDrag, 'Dragging must rotate the globe')
          await capture('dragged', true)
          await page.locator('#settings-button').click()
          await page.locator('#setting-show-flags').check()
          await page.locator('#setting-show-capitals').check()
          await page.locator('#settings-close').click()
          await page.clock.fastForward(256)
          await capture('show-capitals', true)
          await page.locator('#settings-button').click()
          await page.locator('#setting-show-flags').uncheck()
          await page.locator('#setting-show-capitals').uncheck()
          await page.locator('#setting-projection').selectOption('mercator')
          await page.locator('#settings-close').click()
          await page.clock.fastForward(256)
          assert.equal(await frame.getAttribute('data-projection'), 'mercator')
          await capture('switched-mercator', true)
          await page.locator('#settings-button').click()
          await page.locator('#setting-projection').selectOption('orthographic')
          await page.locator('#settings-close').click()
          await page.clock.fastForward(256)
          assert.equal(await frame.getAttribute('data-projection'), 'orthographic')
          await capture('switched-globe', true)
        }
        assert.deepEqual(errors, [], `${scenario.name}: browser errors`)
        await context.close()
        console.log(`${build}: ${scenario.name} verified`)
      }
    } finally {
      server.close()
    }
  }
  const summary = { svgStates: checked, screenshots, visiblePathChecks, borderNoisePixels, changedInputInteriorPixelDifferences: 0, identicalInputRasterCases, identicalInputRasterPixels, softwareRaster: Boolean(process.env.SOFTWARE_RASTER), freshRaster: Boolean(process.env.FRESH_RASTER) }
  await writeFile(`${output}/results.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
} finally {
  await browser.close()
}
