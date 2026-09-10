import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'

// Compare SVG geometry, labels and screenshots at identical animation times.
// Run separately from the real-time FPS benchmark (this uses a fake clock).
const [baselineDir, currentDir = 'dist'] = process.argv.slice(2)
assert(baselineDir, 'Usage: node scripts/verify-globe-rendering.mjs <baseline-build> [current-build]')
const output = 'output/playwright/visual'
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
const browser = await chromium.launch()
const scenarios = [
  { name: 'desktop', query: '', width: 1280, height: 1000 },
  { name: 'mobile', query: '?flags=1&capitals=1', width: 390, height: 844 },
  { name: 'route', query: '?mode=route', width: 1280, height: 1000 },
  { name: 'mercator', query: '?projection=mercator', width: 1280, height: 1000 },
  { name: 'equal-earth', query: '?projection=equal-earth', width: 1280, height: 1000 },
]
const snapshots = new Map()
let checked = 0
let screenshots = 0
let borderNoisePixels = 0
try {
  for (const [build, directory] of [['baseline', baselineDir], ['current', currentDir]]) {
    const server = await serveBuild(directory)
    try {
      for (const scenario of scenarios) {
        const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, serviceWorkers: 'block' })
        await context.route('https://cdn.jsdelivr.net/npm/country-flag-icons@1.5.19/3x2/*.svg', async route => {
          const filename = new URL(route.request().url()).pathname.split('/').at(-1)
          await route.fulfill({ contentType: 'image/svg+xml', body: await readFile(`${flagsDirectory}/package/3x2/${filename}`) })
        })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') })
        await page.goto(server.url + scenario.query)
        await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
        await page.waitForTimeout(1000)
        await page.clock.pauseAt(new Date('2026-09-10T12:01:00Z'))
        await page.clock.fastForward(256)
        const capture = async (state, screenshot = false) => {
          const key = `${scenario.name}-${state}`
          const svg = await page.locator('.globe-frame').evaluate(el => el.innerHTML)
          if (screenshot) {
            await page.waitForLoadState('networkidle')
          }
          const png = screenshot ? await page.locator('.globe-frame').screenshot({ path: `${output}/${build}-${key}.png` }) : null
          if (build === 'baseline') snapshots.set(key, { svg, png })
          else {
            const expected = snapshots.get(key)
            if (expected.svg !== svg) {
              await writeFile(`${output}/${key}-baseline.svg`, expected.svg)
              await writeFile(`${output}/${key}-current.svg`, svg)
            }
            assert(svg === expected.svg, `${key}: SVG changed (see saved SVGs)`)
            if (png) {
              screenshots++
              if (!png.equals(expected.png)) {
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
                }, [expected.png.toString('base64'), png.toString('base64')])
                assert.equal(diff.invalid, 0, `${key}: screenshot changed`)
                borderNoisePixels += diff.noise
              }
            }
            checked++
          }
        }
        await capture('initial', true)
        // Real answers exercise label content/tone changes and country fills.
        if (scenario.name !== 'route') {
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
        if (scenario.name === 'mobile') {
          await page.locator('.globe__map-svg').dispatchEvent('wheel', { deltaY: -80, bubbles: true })
        } else {
          await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
        }
        await page.clock.fastForward(512)
        await page.clock.fastForward(256)
        await capture('zoomed', true)
        assert.deepEqual(errors, [], `${scenario.name}: browser errors`)
        await context.close()
        console.log(`${build}: ${scenario.name} verified`)
      }
    } finally {
      server.close()
    }
  }
  const summary = { svgStates: checked, screenshots, borderNoisePixels, interiorPixelDifferences: 0 }
  await writeFile(`${output}/results.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
} finally {
  await browser.close()
}
