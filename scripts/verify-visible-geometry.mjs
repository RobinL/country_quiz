import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { geoArea, geoClipRectangle, geoPath, geoOrthographic } from 'd3'
import { feature, mesh } from 'topojson-client'
import { createHemispherePath } from '../src/hemisphere-path.ts'
import { visibleSegments } from './lib/visible-segments.mjs'

const geometries = []
for (const name of ['globe-atlas', 'globe-detail-atlas', 'globe-interaction-atlas']) {
  const atlas = JSON.parse(await readFile(new URL(`../src/generated/${name}.json`, import.meta.url)))
  geometries.push([`${name}-land`, feature(atlas, atlas.objects.land)])
  geometries.push([`${name}-borders`, mesh(atlas, atlas.objects.countries, (a, b) => a !== b)])
  geometries.push(...feature(atlas, atlas.objects.countries).features.map(f => [`${name}-${f.id}`, f]))
}
const fallbacks = JSON.parse(await readFile(new URL('../src/generated/country-geometry-fallbacks.json', import.meta.url)))
for (const country of fallbacks) {
  const normalize = coordinates => geoArea({ type: 'Polygon', coordinates }) > Math.PI * 2
    ? coordinates.map(ring => [...ring].reverse()) : coordinates
  country.geometry.coordinates = country.geometry.type === 'Polygon'
    ? normalize(country.geometry.coordinates) : country.geometry.coordinates.map(normalize)
  geometries.push([`fallback-${country.id}`, country])
}
// Long rings exercise the bounds tree, including holes and complement fallback.
const ring = Array.from({ length: 257 }, (_, i) => {
  const t = i % 256 / 256 * Math.PI * 2
  return [20 * Math.sin(t), 20 * Math.cos(t)]
})
geometries.push(
  ['dense-ring', { type: 'Polygon', coordinates: [ring] }],
  ['dense-hole', { type: 'Polygon', coordinates: [ring, ring.map(([x, y]) => [x / 2, y / 2]).reverse()] }],
  ['dense-complement', { type: 'Polygon', coordinates: [[...ring].reverse()] }],
  ['dense-duplicates', { type: 'Polygon', coordinates: [ring.flatMap(point => [point, point])] }],
)

const rotations = [[0, 0, 0], [-12, -18, 0], [90, 0, 0], [90 - 1e-7, 0, 0], [90 + 1e-7, 0, 0], [-180, 0, 0], [0, -90, 0], [0, 90, 0], [137, 75, 42], [-80, -65, -35]]
let seed = 701
for (let i = 0; i < 14; i++) {
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 2 ** 32
  rotations.push([random() * 360 - 180, random() * 180 - 90, random() * 360 - 180])
}
let checks = 0
let visibleEdges = 0
await mkdir('output/playwright', { recursive: true })
for (const rotation of rotations) {
  for (const scale of [150, 600, 5000]) {
    const projection = geoOrthographic().precision(0.6).clipAngle(90).rotate(rotation).scale(scale).translate([320, 320])
    const clip = geoClipRectangle(-64, -64, 704, 704)
    const original = geoPath({ stream: sink => projection.stream(clip(sink)) })
    const clipped = createHemispherePath(projection, { width: 640, height: 640, clipPaths: true, clipExtent: true })
    for (const [name, geometry] of geometries) {
      const expected = original(geometry)
      const actual = clipped.path(geometry)
      const a = visibleSegments(expected)
      const b = visibleSegments(actual)
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const missing = a.filter(x => !b.includes(x))
        const extra = b.filter(x => !a.includes(x))
        await writeFile('output/playwright/visible-segment-mismatch.json', JSON.stringify({ rotation, scale, name, expected, actual, missing, extra }))
        throw new Error(`${name}, rotation ${rotation}, scale ${scale}: ${missing.length} missing, ${extra.length} extra visible segments`)
      }
      checks++
      visibleEdges += a.length
    }
  }
  console.log(`Verified rotation ${rotation.map(n => n.toFixed(2)).join(', ')}`)
}
const summary = { checks, visibleEdges, rotations: rotations.length, scales: [150, 600, 5000] }
await writeFile('output/playwright/full-detail-geometry.json', JSON.stringify(summary, null, 2))
console.log(summary)
