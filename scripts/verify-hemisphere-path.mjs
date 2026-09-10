import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { geoArea, geoOrthographic, geoPath } from 'd3'
import { feature, mesh } from 'topojson-client'
import { createHemispherePath, prepareHemisphereGeometry, prepareHemisphereLabel } from '../src/hemisphere-path.ts'

// Node 22.18+ can load the renderer's erasable TypeScript directly.
const geometries = []
const labels = []
function addCountry(name, country) {
  geometries.push([name, country])
  const polygons = country.geometry.type === 'Polygon' ? [country.geometry] : country.geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }))
  const primary = polygons.sort((a, b) => geoArea(b) - geoArea(a))[0]
  if (primary) labels.push([`${name}-label`, primary])
}
for (const name of ['globe-atlas', 'globe-detail-atlas', 'globe-interaction-atlas']) {
  const topology = JSON.parse(await readFile(new URL(`../src/generated/${name}.json`, import.meta.url)))
  geometries.push([`${name}-land`, feature(topology, topology.objects.land)])
  geometries.push([`${name}-borders`, mesh(topology, topology.objects.countries, (a, b) => a !== b)])
  for (const country of feature(topology, topology.objects.countries).features) {
    addCountry(`${name}-${country.id}`, country)
  }
}
// Exercise the tiny-country fallbacks with the same winding normalization
// used by the app, including the shared fill/label centroid path.
const fallbacks = JSON.parse(await readFile(new URL('../src/generated/country-geometry-fallbacks.json', import.meta.url)))
for (const country of fallbacks) {
  const normalize = coordinates => geoArea({ type: 'Polygon', coordinates }) > Math.PI * 2
    ? coordinates.map(ring => [...ring].reverse()) : coordinates
  country.geometry.coordinates = country.geometry.type === 'Polygon'
    ? normalize(country.geometry.coordinates) : country.geometry.coordinates.map(normalize)
  addCountry(`fallback-${country.id}`, country)
}
const ring = [[-5, -5], [-5, 5], [5, 5], [5, -5], [-5, -5]]
const edgeCases = [
  ['empty', { type: 'Polygon', coordinates: [] }],
  ['small', { type: 'Polygon', coordinates: [ring] }],
  ['complement', { type: 'Polygon', coordinates: [[...ring].reverse()] }],
  ['hole', { type: 'Polygon', coordinates: [ring, ring.map(([x, y]) => [x / 2, y / 2]).reverse()] }],
  ['pole', { type: 'Polygon', coordinates: [[[-180, 85], [-60, 85], [60, 85], [180, 85], [-180, 85]]] }],
  ['antimeridian', { type: 'Polygon', coordinates: [[[175, -5], [175, 5], [-175, 5], [-175, -5], [175, -5]]] }],
  ['antipodal-line', { type: 'MultiLineString', coordinates: [[[0, 0], [180, 0]]] }],
  ['duplicates', { type: 'Polygon', coordinates: [[ring[0], ring[0], [-4.99999, -5], ...ring.slice(1)]] }],
  ['stream-transitions', { type: 'GeometryCollection', geometries: [
    { type: 'MultiLineString', coordinates: [[[-2, 0], [2, 0]]] },
    { type: 'Point', coordinates: [180, 0] },
    { type: 'Sphere' },
    { type: 'Point', coordinates: [0, 0] },
  ] }],
  ['empty-feature', { type: 'Feature', geometry: null, properties: {} }],
]
geometries.push(...edgeCases)
labels.push(...edgeCases.filter(([, geometry]) => geometry.type === 'Polygon'))
for (const [, geometry] of [...geometries, ...labels]) prepareHemisphereGeometry(geometry)
for (const [, geometry] of labels) prepareHemisphereLabel(geometry)

const rotations = [[0, 0, 0], [-12, -18, 0], [90, 0, 0], [90 - 1e-7, 0, 0], [90 + 1e-7, 0, 0], [-180, 0, 0], [0, -90, 0], [0, 90, 0], [137, 75, 42], [-80, -65, -35]]
let seed = 701
for (let i = 0; i < 14; i++) {
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 2 ** 32
  rotations.push([random() * 360 - 180, random() * 180 - 90, random() * 360 - 180])
}
let pathChecks = 0
let centroidChecks = 0
let viewportChecks = 0
let culledLabels = 0
await mkdir('output/playwright/geometry', { recursive: true })
for (const rotation of rotations) {
  for (const scale of [150, 600, 5000]) {
    const projection = geoOrthographic().precision(0.6).clipAngle(90).rotate(rotation).scale(scale).translate([320, 320])
    const original = geoPath(projection)
    const optimized = createHemispherePath(projection)
    const viewport = createHemispherePath(projection, { width: 640, height: 640 })
    for (const [name, geometry] of geometries) {
      const expected = original(geometry) ?? ''
      const actual = optimized.path(geometry)
      if (expected !== actual) {
        await writeFile('output/playwright/geometry/mismatch.json', JSON.stringify({ name, rotation, scale, geometry, expected, actual }))
        let index = 0
        while (expected[index] === actual[index] && index < expected.length) index++
        throw new Error(`${name}, rotation ${rotation}, scale ${scale}: path differs at ${index}: ${expected.slice(index, index + 100)} / ${actual.slice(index, index + 100)}`)
      }
      pathChecks++
    }
    for (const [name, geometry] of labels) {
      const expected = original.centroid(geometry)
      const actual = optimized.centroid(geometry)
      assert.deepEqual(actual, expected, `${name}, rotation ${rotation}, scale ${scale}: centroid changed`)
      assert.deepEqual(viewport.centroid(geometry), expected, `${name}: viewport changed centroid`)
      for (const paddingX of [50, 240]) {
        if (viewport.outsideViewport(geometry, paddingX, 64)) {
          // D3 drops degenerate rings and returns NaN; the app omits those labels.
          assert(expected.some(Number.isNaN) || expected[0] < -paddingX || expected[0] > 640 + paddingX || expected[1] < -64 || expected[1] > 704,
            `${name}, rotation ${rotation}, scale ${scale}, padding ${paddingX}: culled centroid ${expected}`)
          culledLabels++
        }
        viewportChecks++
      }
      centroidChecks++
    }
  }
  console.log(`Verified rotation ${rotation.map(n => n.toFixed(2)).join(', ')}`)
}
assert(culledLabels > 0, 'Viewport checks did not exercise label culling')
const summary = { pathChecks, centroidChecks, viewportChecks, culledLabels, rotations: rotations.length, scales: [150, 600, 5000] }
await writeFile('output/playwright/geometry/results.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
