import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'

// Compare production builds, with identical routes, viewport and CPU throttling.
// node scripts/benchmark-flights.mjs <build-dir> <result-name> [cpu-rate] [repeats] [mobile]
const [directory = 'dist', name = 'current', rate = '6', repeats = '3', device] = process.argv.slice(2)
const solvedCount = Number(process.env.SOLVED_COUNT ?? 0)
if (!Number.isInteger(solvedCount) || solvedCount < 0 || solvedCount > 196) throw new Error('SOLVED_COUNT must be 0–196')
const output = resolve('output/playwright')
await mkdir(output, { recursive: true })
const server = await serveBuild(directory)
const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    viewport: device === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 1000 },
    deviceScaleFactor: device === 'mobile' ? 2 : 1,
    isMobile: device === 'mobile', hasTouch: device === 'mobile', serviceWorkers: 'block',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(server.url)
  await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
  await page.waitForTimeout(700)
  if (solvedCount) {
    const records = JSON.parse(await readFile(new URL('../src/generated/quiz-country-records.json', import.meta.url)))
    const answers = Array.from({ length: solvedCount }, (_, i) => records[Math.floor(i * records.length / solvedCount)].name)
    await page.evaluate(names => {
      const input = document.querySelector('#guess-input')
      for (const name of names) {
        input.value = name
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, answers)
    await page.waitForTimeout(2500)
    if (!(await page.locator('#score').textContent()).startsWith(`${solvedCount}/`)) throw new Error('Could not seed answers')
  }
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate) })
  const flight = (from, to) => page.evaluate(([a, b]) => window.__countriesQuizDebug.benchmarkFlight(a, b), [from, to])
  await flight('GBR', 'USA')
  await flight('USA', 'GBR')
  const routes = ['GBR', 'USA', 'AUS', 'JPN', 'BRB', 'FRA', 'GBR']
  const results = []
  for (let repeat = 0; repeat < Number(repeats); repeat++) {
    for (let i = 1; i < routes.length; i++) {
      const result = await flight(routes[i - 1], routes[i])
      if (!result || result.status !== 'complete') throw new Error('Flight failed')
      results.push({ repeat, ...result })
      await page.waitForTimeout(250)
    }
    console.log(`${name}: completed repeat ${repeat + 1}`)
  }
  const frames = results.reduce((n, r) => n + r.frameCount, 0)
  const sampledMs = results.reduce((n, r) => n + r.frameCount * r.averageFrameMs, 0)
  const summary = { name, browser: browser.version(), cpuRate: Number(rate), device: device ?? 'desktop', solvedCount, fps: frames / sampledMs * 1000, errors, results }
  await writeFile(`${output}/${name}.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ ...summary, results: undefined }))
  if (process.env.PROFILE) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.start')
    await flight('GBR', 'USA')
    await flight('USA', 'AUS')
    const { profile } = await cdp.send('Profiler.stop')
    await writeFile(`${output}/${name}.cpuprofile`, JSON.stringify(profile))
    const counts = new Map()
    for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
    console.log(profile.nodes.map(n => ({ fn: n.callFrame.functionName, url: n.callFrame.url, hits: counts.get(n.id) ?? 0 })).sort((a, b) => b.hits - a.hits).slice(0, 25))
  }
} finally {
  await browser.close()
  server.close()
}
