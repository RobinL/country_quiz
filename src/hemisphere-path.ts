import type { GeoJSON, LineString, Polygon } from 'geojson'
import {
  geoArea, geoCentroid, geoClipRectangle, geoPath, geoStream, pathRound,
  type GeoPermissibleObjects, type GeoProjection, type GeoStream, type GeoStreamWrapper,
} from 'd3'

type Vector = [number, number, number]
type Part = {
  geometry: GeoPermissibleObjects
  cap: { center: Vector; coordinates: [number, number]; cosRadius: number; sinRadius: number; chordRadius: number } | null
  distinctVertices: boolean
  complement?: boolean
}
type BoundsTree = { start: number; end: number; cap: Part['cap']; children?: [BoundsTree, BoundsTree] }
const ringBounds = new WeakMap<object, BoundsTree>()
const radians = Math.PI / 180
const margin = 1e-6
const coincidentThreshold = Math.cos(1.5e-6)
const pathClipPadding = 64
const chainClipPadding = 128
const boundsLeafSize = 16
const prepared = new WeakMap<object, Part[]>()
const labelCoordinates = new WeakMap<object, number>()

function prepareRingBounds(coordinates: number[][]): BoundsTree {
  const cached = ringBounds.get(coordinates)
  if (cached) return cached
  const vectors = coordinates.map(point => vector(point[0], point[1]))
  function build(start: number, end: number): BoundsTree {
    const sum: Vector = [0, 0, 0]
    for (let i = start; i <= end; i++) {
      for (let axis = 0; axis < 3; axis++) sum[axis] += vectors[i][axis]
    }
    const length = Math.hypot(...sum)
    const center = sum.map(v => v / length) as Vector
    let minDot = 1
    for (let i = start; i <= end; i++) {
      const v = vectors[i]
      minDot = Math.min(minDot, center[0] * v[0] + center[1] * v[1] + center[2] * v[2])
    }
    const cap: Part['cap'] = minDot > margin && Number.isFinite(minDot) ? {
      center,
      coordinates: [Math.atan2(center[1], center[0]) / radians, Math.asin(center[2]) / radians],
      cosRadius: minDot,
      sinRadius: Math.sqrt(Math.max(0, 1 - minDot * minDot)) + margin,
      chordRadius: Math.sqrt(Math.max(0, 2 - 2 * minDot)) + margin,
    } : null
    const node: BoundsTree = { start, end, cap }
    if (end - start > boundsLeafSize) {
      const middle = (start + end) >>> 1
      node.children = [build(start, middle), build(middle, end)]
    }
    return node
  }
  const root = build(0, coordinates.length - 1)
  ringBounds.set(coordinates, root)
  return root
}

function vector(longitude: number, latitude: number): Vector {
  const lambda = longitude * radians
  const phi = latitude * radians
  const cosPhi = Math.cos(phi)
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)]
}

function streamVisibleGeometry(sink: GeoStream): GeoStream {
  let polygon = false
  let polygonStarted = false
  let lineStarted = false
  let firstX = NaN
  let firstY = NaN
  let previousX = NaN
  let previousY = NaN
  let pendingX = NaN
  let pendingY = NaN

  function emit(x: number, y: number): void {
    if (!lineStarted) {
      if (polygon && !polygonStarted) {
        sink.polygonStart()
        polygonStarted = true
      }
      sink.lineStart()
      lineStarted = true
    }
    sink.point(x, y)
  }

  function point(x: number, y: number): void {
    if (Number.isNaN(firstX)) { firstX = x; firstY = y }
    if (!(Math.abs(x - previousX) < margin && Math.abs(y - previousY) < margin)) {
      if (polygon) {
        // D3's circle clip drops the last accepted point after closing a ring.
        // A one-point delay preserves that rule without buffering the ring.
        if (!Number.isNaN(pendingX)) emit(pendingX, pendingY)
        pendingX = x
        pendingY = y
      } else {
        emit(x, y)
      }
    }
    previousX = x
    previousY = y
  }

  return {
    point,
    lineStart() {
      lineStarted = false
      firstX = firstY = previousX = previousY = pendingX = pendingY = NaN
    },
    lineEnd() {
      if (polygon && !Number.isNaN(firstX)) point(firstX, firstY)
      if (lineStarted) sink.lineEnd()
    },
    polygonStart() { polygon = true; polygonStarted = false },
    polygonEnd() {
      if (polygonStarted) sink.polygonEnd()
      polygon = false
    },
  }
}

function boundedPart(geometry: Polygon | LineString): Part {
  const part: Part = { geometry, cap: null, distinctVertices: true }
  for (const ring of geometry.type === 'Polygon' ? geometry.coordinates : [geometry.coordinates]) {
    if (ring.length > boundsLeafSize) prepareRingBounds(ring)
  }
  // A cap smaller than a hemisphere is geodesically convex. If it contains
  // every vertex, it also contains every edge and the smaller polygon interior.
  // Complements, large polygons, and ambiguous bounds retain D3's full clipping.
  if (geometry.type === 'Polygon' && (geoArea(geometry) >= Math.PI * 2 - margin ||
    geoArea({ type: 'Polygon', coordinates: geometry.coordinates.slice(0, 1) }) >= Math.PI * 2 - margin)) {
    part.complement = true
    return part
  }
  const [longitude, latitude] = geoCentroid(geometry)
  const center = vector(longitude, latitude)
  let minDot = 1
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : [geometry.coordinates]
  for (const ring of rings) {
    let previous: Vector | null = null
    for (const point of ring) {
      const v = vector(point[0], point[1])
      minDot = Math.min(minDot, center[0] * v[0] + center[1] * v[1] + center[2] * v[2])
      // D3 removes almost-duplicate consecutive vertices. Those rings need
      // the duplicate-filtered stream instead of direct pass-through.
      if (previous && previous[0] * v[0] + previous[1] * v[1] + previous[2] * v[2] > coincidentThreshold) {
        part.distinctVertices = false
      }
      previous = v
    }
  }
  if (minDot > margin && Number.isFinite(minDot)) {
    part.cap = {
      center,
      coordinates: [longitude, latitude],
      cosRadius: minDot,
      sinRadius: Math.sqrt(Math.max(0, 1 - minDot * minDot)) + margin,
      chordRadius: Math.sqrt(Math.max(0, 2 - 2 * minDot)) + margin,
    }
  }
  return part
}

export function prepareHemisphereGeometry(geometry: GeoPermissibleObjects): Part[] {
  const cached = prepared.get(geometry)
  if (cached) return cached
  let parts: Part[]
  const object = geometry as GeoJSON | { type: 'Sphere' }
  switch (object.type) {
    case 'Feature':
      parts = object.geometry ? prepareHemisphereGeometry(object.geometry) : []
      break
    case 'FeatureCollection':
      parts = object.features.flatMap(prepareHemisphereGeometry)
      break
    case 'GeometryCollection':
      parts = object.geometries.flatMap(prepareHemisphereGeometry)
      break
    case 'MultiPolygon':
      parts = object.coordinates.map(coordinates => boundedPart({ type: 'Polygon', coordinates }))
      break
    case 'MultiLineString':
      parts = object.coordinates.map(coordinates => boundedPart({ type: 'LineString', coordinates }))
      break
    case 'Polygon':
      parts = [boundedPart(object)]
      break
    default:
      parts = [{ geometry, cap: null, distinctVertices: false }]
  }
  prepared.set(geometry, parts)
  return parts
}

export function prepareHemisphereLabel(geometry: GeoPermissibleObjects, paddingX = 0): void {
  const parts = prepareHemisphereGeometry(geometry)
  if (parts.length === 1 && parts[0].geometry.type === 'Polygon') {
    labelCoordinates.set((parts[0].geometry as Polygon).coordinates, paddingX)
  }
}

// This renderer is a snapshot of one orthographic frame. Recreate it after any
// projection change; the immutable geometry bounds are shared across frames.
export function createHemispherePath(projection: GeoProjection, viewport?: { width: number; height: number; clipPaths?: boolean; clipExtent?: boolean }) {
  let side: 'front' | 'back' | 'horizon' = 'horizon'
  let distinctVertices = true
  const streams = new WeakMap<GeoStream, GeoStream>()
  const originalClip = projection.preclip()
  const originalClipAngle = projection.clipAngle()
  const adapter: GeoStreamWrapper = {
    stream(sink: GeoStream): GeoStream {
      const cached = streams.get(sink)
      if (cached) return cached
      // Build both routes from the original projection parameters. Cloning via
      // rotate() would round-trip radians through degrees and move centroids.
      projection.preclip(output => {
        const clipped = originalClip(output)
        const visible = streamVisibleGeometry(output)
        let active = clipped
        let polygon = false
        return {
          point(x, y, z) { active.point(x, y, z) },
          lineStart() {
            if (!polygon) active = side === 'front' ? (distinctVertices ? output : visible) : clipped
            active.lineStart()
          },
          lineEnd() {
            active.lineEnd()
            if (!polygon) active = clipped
          },
          polygonStart() {
            polygon = true
            active = side === 'front' ? (distinctVertices ? output : visible) : clipped
            active.polygonStart()
          },
          polygonEnd() {
            active.polygonEnd()
            polygon = false
            active = clipped
          },
          sphere() { clipped.sphere?.() },
        }
      })
      let stream: GeoStream
      try {
        stream = projection.stream(sink)
      } finally {
        if (Number.isFinite(originalClipAngle)) projection.clipAngle(originalClipAngle)
        else projection.preclip(originalClip)
      }
      streams.set(sink, stream)
      return stream
    },
  }
  const [longitude, latitude] = projection.rotate()
  const view = vector(-longitude, -latitude)
  const pixelScale = Math.abs(projection.scale())
  const origin = projection([0, 0])!
  const opposite = projection([180, 0])!
  const offset: [number, number] = [(origin[0] + opposite[0]) / 2, (origin[1] + opposite[1]) / 2]
  const horizonOutsideViewport = viewport && pixelScale > Math.hypot(
    Math.max(Math.abs(offset[0] + pathClipPadding), Math.abs(viewport.width + pathClipPadding - offset[0])),
    Math.max(Math.abs(offset[1] + pathClipPadding), Math.abs(viewport.height + pathClipPadding - offset[1])),
  ) + pixelScale * margin

  const measurementPath = geoPath(adapter)
  const sphereInsideViewport = viewport && offset[0] - pixelScale >= -pathClipPadding &&
    offset[0] + pixelScale <= viewport.width + pathClipPadding &&
    offset[1] - pixelScale >= -pathClipPadding && offset[1] + pixelScale <= viewport.height + pathClipPadding
  const clip = viewport?.clipExtent && !sphereInsideViewport
    ? geoClipRectangle(-pathClipPadding, -pathClipPadding, viewport.width + pathClipPadding, viewport.height + pathClipPadding)
    : null
  const clippedStreams = new WeakMap<GeoStream, GeoStream>()
  const path = clip ? geoPath({
    stream(sink) {
      let stream = clippedStreams.get(sink)
      if (!stream) {
        stream = adapter.stream(clip(sink))
        clippedStreams.set(sink, stream)
      }
      return stream
    },
  }) : measurementPath
  // A dedicated line/polygon writer avoids D3's generic tagged-template loop
  // for every coordinate. It uses exactly the same three-decimal rounding.
  let pathText = ''
  let firstPoint = true
  let polygonPath = false
  const pathSink: GeoStream = {
    point(x, y) {
      pathText += (firstPoint ? 'M' : 'L') + Math.round(x * 1000) / 1000 + ',' + Math.round(y * 1000) / 1000
      firstPoint = false
    },
    lineStart() { firstPoint = true },
    lineEnd() { if (polygonPath) pathText += 'Z' },
    polygonStart() { polygonPath = true },
    polygonEnd() { polygonPath = false },
  }
  const pathStream = adapter.stream(clip ? clip(pathSink) : pathSink)
  function drawPath(geometry: GeoPermissibleObjects): string {
    if (geometry.type !== 'Polygon' && geometry.type !== 'LineString') return path(geometry) ?? ''
    pathText = ''
    geoStream(geometry, pathStream)
    return pathText
  }
  const projectedCentroids = new Map<object, [number, number]>()
  let drawing = pathRound(3)
  let drawingPolygon = false
  let drawingLineStarted = false
  let combinedStream: GeoStream | null = null
  const drawingCentroid = geoPath({
    stream(centroidSink: GeoStream): GeoStream {
      if (!combinedStream) {
        // Feed the same projected points to D3's centroid accumulator and its
        // SVG path builder. Solved fills and their labels then project once.
        combinedStream = {
          point(x, y, z) {
            centroidSink.point(x, y, z)
            if (drawingLineStarted) drawing.lineTo(x, y)
            else { drawing.moveTo(x, y); drawingLineStarted = true }
          },
          lineStart() { centroidSink.lineStart(); drawingLineStarted = false },
          lineEnd() { centroidSink.lineEnd(); if (drawingPolygon) drawing.closePath() },
          polygonStart() { centroidSink.polygonStart(); drawingPolygon = true },
          polygonEnd() { centroidSink.polygonEnd(); drawingPolygon = false },
        }
      }
      return adapter.stream(combinedStream)
    },
  })

  function visibility(part: Part): 'front' | 'back' | 'horizon' {
    if (!part.cap) return 'horizon'
    const { center, sinRadius } = part.cap
    const dot = view[0] * center[0] + view[1] * center[1] + view[2] * center[2]
    if (dot > sinRadius) return 'front'
    if (dot < -sinRadius) return 'back'
    return 'horizon'
  }

  function partOutsideViewport(part: { cap: Part['cap'] }, paddingX: number, paddingY: number, includeHorizon = false): boolean {
    if (!viewport || !part.cap) return false
    const { center, coordinates, cosRadius, sinRadius, chordRadius } = part.cap
    const dot = view[0] * center[0] + view[1] * center[1] + view[2] * center[2]
    if (!includeHorizon && dot <= sinRadius) return false
    const point = projection(coordinates)
    if (!point) return false
    if (point[0] >= -paddingX && point[0] <= viewport.width + paddingX &&
      point[1] >= -paddingY && point[1] <= viewport.height + paddingY) return false
    // Orthographic projection cannot enlarge a 3D chord. This disk contains
    // the entire projected polygon, including its area/line centroid.
    const radius = pixelScale * chordRadius
    if (point[0] + radius < -paddingX || point[0] - radius > viewport.width + paddingX ||
      point[1] + radius < -paddingY || point[1] - radius > viewport.height + paddingY) return true

    // The disk can be loose near the horizon. Bound each projected axis by
    // its extrema over the spherical cap; these also include its interior.
    function outsideAxis(value: number, axisOffset: number, size: number, padding: number): boolean {
      if (value >= -padding && value <= size + padding) return false
      const component = Math.max(-1, Math.min(1, (value - axisOffset) / pixelScale))
      const extent = Math.sqrt(Math.max(0, 1 - component * component)) * sinRadius
      const min = -component >= cosRadius ? -1 : component * cosRadius - extent
      const max = component >= cosRadius ? 1 : component * cosRadius + extent
      return axisOffset + pixelScale * (max + margin) < -padding ||
        axisOffset + pixelScale * (min - margin) > size + padding
    }
    return outsideAxis(point[0], offset[0], viewport.width, paddingX) ||
      outsideAxis(point[1], offset[1], viewport.height, paddingY)
  }

  function visibleGeometry(part: Part): GeoPermissibleObjects {
    if (!viewport?.clipPaths || part.complement || (part.geometry.type !== 'Polygon' && part.geometry.type !== 'LineString')) return part.geometry
    const geometry = part.geometry as Polygon | LineString
    let changed = false
    function trim(coordinates: number[][]): number[][] {
      if (coordinates.length <= boundsLeafSize) return coordinates
      const result = [coordinates[0]]
      function visit(node: BoundsTree): void {
        // Every edge of this chain, and the chord joining its endpoints, lies
        // in its convex cap. Replacing an entirely hidden chain cannot change
        // any visible boundary or the polygon's winding at a visible point.
        const dot = node.cap ? view[0] * node.cap.center[0] + view[1] * node.cap.center[1] + view[2] * node.cap.center[2] : 0
        // When the entire horizon is outside the padded screen, changes to
        // its clipping arcs are invisible too. Orthographic cap bounds remain
        // valid on both sides of the horizon because projection is linear in 3D.
        if (node.cap && (dot < -node.cap.sinRadius || partOutsideViewport(node, chainClipPadding, chainClipPadding, horizonOutsideViewport))) {
          result.push(coordinates[node.end])
          changed ||= node.end - node.start > 1
        } else if (node.children) {
          visit(node.children[0])
          visit(node.children[1])
        } else {
          for (let i = node.start + 1; i <= node.end; i++) result.push(coordinates[i])
        }
      }
      visit(prepareRingBounds(coordinates))
      return result
    }
    let coordinates: Polygon['coordinates'] | LineString['coordinates']
    if (geometry.type === 'Polygon') {
      if (!geometry.coordinates.length) return geometry
      const outer = trim(geometry.coordinates[0])
      // If an entire minor exterior collapses into an invisible cap, its
      // interior and holes are invisible too. Do not restore the original ring
      // (which would project thousands of hidden vertices), or promote a hole.
      coordinates = outer.length < 4 ? [] : [outer, ...geometry.coordinates.slice(1).map(trim).filter(ring => ring.length >= 4)]
    } else {
      coordinates = trim(geometry.coordinates)
    }
    return changed ? { ...geometry, coordinates } as Polygon | LineString : geometry
  }

  return {
    outsideViewport(geometry: GeoPermissibleObjects, paddingX: number, paddingY: number): boolean {
      const parts = prepareHemisphereGeometry(geometry)
      return parts.length === 1 && partOutsideViewport(parts[0], paddingX, paddingY)
    },
    path(geometry: GeoPermissibleObjects): string {
      let result = ''
      for (const part of prepareHemisphereGeometry(geometry)) {
        side = visibility(part)
        distinctVertices = part.distinctVertices
        if (side === 'back') continue
        if (viewport?.clipPaths && partOutsideViewport(part, pathClipPadding, pathClipPadding, horizonOutsideViewport)) continue
        const geometry = visibleGeometry(part)
        if (geometry !== part.geometry) {
          if (geometry.type === 'Polygon' && !(geometry as Polygon).coordinates.length) continue
          distinctVertices = false
          result += drawPath(geometry)
          continue
        }
        const coordinates = part.geometry.type === 'Polygon' ? (part.geometry as Polygon).coordinates : null
        const paddingX = coordinates ? labelCoordinates.get(coordinates) : undefined
        if (!clip && coordinates && paddingX !== undefined && !partOutsideViewport(part, paddingX, 64)) {
          drawing = pathRound(3)
          projectedCentroids.set(coordinates, drawingCentroid.centroid(part.geometry))
          result += drawing.toString()
        } else {
          result += drawPath(part.geometry)
        }
      }
      return result
    },
    centroid(geometry: GeoPermissibleObjects): [number, number] {
      const parts = prepareHemisphereGeometry(geometry)
      if (parts.length === 1 && parts[0].geometry.type === 'Polygon') {
        const cached = projectedCentroids.get((parts[0].geometry as Polygon).coordinates)
        if (cached) return cached
      }
      // Label geometry is one primary polygon. Keep compound centroid weighting
      // and all horizon cases on the unchanged D3 path.
      side = parts.length === 1 ? visibility(parts[0]) : 'horizon'
      distinctVertices = parts.length === 1 && parts[0].distinctVertices
      return measurementPath.centroid(geometry)
    },
  }
}
