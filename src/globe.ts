import {
  type D3DragEvent,
  type EnterElement,
  type GeoPermissibleObjects,
  type GeoProjection,
  type Selection,
  drag,
  geoAlbers,
  geoArea,
  geoCentroid,
  geoConicConformal,
  geoDistance,
  geoEqualEarth,
  geoEquirectangular,
  geoGraticule,
  geoInterpolate,
  geoGraticule10,
  geoMercator,
  geoNaturalEarth1,
  geoOrthographic,
  geoPath,
  geoStereographic,
  select,
} from 'd3'
import { geoMollweide, geoRobinson } from 'd3-geo-projection'
import { feature, mesh } from 'topojson-client'

import atlasUrl from './generated/globe-atlas.json?url'
import detailAtlasUrl from './generated/globe-detail-atlas.json?url'
import interactionAtlasUrl from './generated/globe-interaction-atlas.json?url'
import fallbackFeatures from './generated/country-geometry-fallbacks.json'
import type { QuizCountry } from './quiz-data'
import { createHemispherePath, prepareHemisphereGeometry, prepareHemisphereLabel } from './hemisphere-path'

type AtlasFeature = GeoPermissibleObjects & {
  id?: string | number
  properties?: {
    name?: string
  }
}

type Topology = {
  objects: {
    countries: object
    land: object
  }
}

type AtlasBundle = {
  borderMesh: GeoPermissibleObjects
  countryCentroidById: Map<string, [number, number]>
  countryAngularRadiusById: Map<string, number>
  featureByCountryId: Map<string, AtlasFeature>
  labelFeatureByCountryId: Map<string, GeoPermissibleObjects>
  landFeature: GeoPermissibleObjects
}

export type GlobeFlightPerformance = {
  averageFps: number | null
  averageFrameMs: number | null
  elapsedMs: number
  frameCount: number
  fromCountryId: string
  fromName: string
  maxFrameMs: number | null
  minFps: number | null
  status: 'running' | 'complete' | 'cancelled'
  toCountryId: string
  toName: string
}

type PreAnswerLabelMode = 'none' | 'country' | 'capital'

type GlobeController = {
  benchmarkFlight: (
    fromCountryId: string,
    toCountryId: string,
  ) => Promise<GlobeFlightPerformance | null>
  describeFlightPath: (answerOrder: string[]) => GlobeFlightStatus | null
  setAnswered: (
    answeredIds: Set<string>,
    options?: {
      activeCountryIds?: Set<string>
      cheatedIds?: Set<string>
      focusLatest?: boolean
      answerKind?: 'country' | 'capital'
      layoutMode?: 'free' | 'route'
      preAnswerLabelMode?: PreAnswerLabelMode
      showAllCountryLabels?: boolean
      showPreAnswerFlags?: boolean
      showUnansweredMarkers?: boolean
      skippedIds?: Set<string>
    },
  ) => void
  setPromptedCountry: (
    countryId: string | null,
    options?: {
      focus?: boolean
    },
  ) => void
  syncFlightPath: (
    answerOrder: string[],
    options?: {
      animate?: boolean
    },
  ) => GlobeFlightStatus | null
  resetView: (
    options?: {
      countryIds?: Iterable<string>
    },
  ) => void
  setProjection: (projectionKey: GlobeProjectionKey) => void
  zoomBy: (factor: number) => void
}

export type GlobeFlightStatus = {
  fromName: string
  legMiles: number
  toName: string
  totalMiles: number
}

type GlobeLabel = {
  flagAssetUrl: string | null
  id: string
  detail: string | null
  markerText: string | null
  name: string | null
  tone: 'answered' | 'default' | 'prompt' | 'skipped'
  x: number
  y: number
}

type FlightSegment = {
  fromCoordinates: [number, number]
  fromCountryId: string
  fromName: string
  id: string
  miles: number
  pathCoordinates: [number, number][]
  toCoordinates: [number, number]
  toCountryId: string
  toName: string
}

type PinchZoomState = {
  distance: number
  zoom: number
}

type TouchCheatState = {
  countryId: string
  startX: number
  startY: number
  timeoutId: number
}

type FlightPerformanceAccumulator = {
  lastFrameTime: number | null
  lastPublishedTime: number
  maxFrameMs: number
  sampledFrameCount: number
  startTime: number
  totalFrameMs: number
}

type MotionSource = 'drag' | 'flight' | 'pinch' | 'wheel'

export type GlobeProjectionKey =
  | 'mercator'
  | 'equirectangular'
  | 'orthographic'
  | 'albers'
  | 'natural-earth'
  | 'equal-earth'
  | 'stereographic'
  | 'conic-conformal'
  | 'mollweide'
  | 'robinson'

const BASE_SCALE_RATIO = 0.318
const EARTH_RADIUS_MILES = 3958.7613
const FLIGHT_PATH_SAMPLE_STEP_RADIANS = 0.045
const FLIGHT_START_COUNTRY_ID = 'GBR'
const FLY_DURATION_MS = 1700
const MIN_ZOOM = 0.78
const MAX_ZOOM = 18
const FOCUS_COUNTRY_RADIUS_PX = 124
const FOCUS_REGION_RADIUS_RATIO = 0.26
const MIN_COUNTRY_ANGULAR_RADIUS = 0.0025
const DESKTOP_FLIGHT_TRAILS_MEDIA_QUERY = '(min-width: 841px)'
const PLANE_EMOJI_BASE_HEADING_DEGREES = -45
const PLANE_TANGENT_SAMPLE_STEP = 0.018
const WHEEL_ZOOM_SENSITIVITY = 0.0034
const MAX_WHEEL_DELTA = 80
const MIN_PINCH_DISTANCE_PX = 24
const MOBILE_CHEAT_HOLD_MS = 2000
const SETTLED_OUTLINE_DELAY_MS = 140
const MAP_LABEL_CENTER_ROW_OFFSET_PX = -4
const MAP_LABEL_NAME_ROW_GAP_PX = 22
const MAP_LABEL_DETAIL_ROW_GAP_PX = 18
const MAP_LABEL_FLAG_OFFSET_PX = MAP_LABEL_CENTER_ROW_OFFSET_PX
const MAP_LABEL_NAME_OFFSET_PX = MAP_LABEL_CENTER_ROW_OFFSET_PX - MAP_LABEL_NAME_ROW_GAP_PX
const MAP_LABEL_FLAG_WIDTH_PX = 26
const MAP_LABEL_FLAG_HEIGHT_PX = 18
const MAP_LABEL_DETAIL_OFFSET_PX = MAP_LABEL_CENTER_ROW_OFFSET_PX + MAP_LABEL_DETAIL_ROW_GAP_PX
const MAP_LABEL_MARKER_FONT_SIZE_PX = 19
const PLANE_LABEL_OFFSET_PX = -17
const PLANE_EMOJI = '✈️'
const SEA_FILL = '#126aa6'
const UNSOLVED_LAND_FILL = '#34393f'
const PROMPTED_COUNTRY_FILL = '#ffe45c'
const LATEST_SOLVED_FILL = '#3cff72'
const SOLVED_COUNTRY_FILL = '#57c46f'
const CHEATED_SOLVED_FILL = '#8f59ff'
const ROUTE_SOLVED_FILL = SOLVED_COUNTRY_FILL
const ROUTE_SKIPPED_FILL = '#8f59ff'
const SOLVED_COUNTRY_OUTLINE_WIDTH = 2.6
const SOLVED_COUNTRY_OUTLINE_COLOR = 'rgba(8, 18, 28, 0.95)'
const MAX_COUNTRY_POLYGON_AREA = Math.PI * 2
const DEFAULT_ROTATION: [number, number, number] = [-12, -18, 0]
const FIT_PADDING_RATIO = 0.08
const MIN_FIT_PADDING_PX = 22
const RECTANGULAR_WORLD_OUTLINE = geoGraticule()
  .extent([
    [-179.999, -85],
    [179.999, 85],
  ])
  .outline() as GeoPermissibleObjects

export const DEFAULT_GLOBE_PROJECTION: GlobeProjectionKey = 'orthographic'

type ProjectionDefinition = {
  clipAngle: number | null
  createProjection: () => GeoProjection
  defaultRotation: [number, number, number]
  fitGeometry: GeoPermissibleObjects
  interactionMode: 'globe' | 'map'
  maxLatitude: number
  usesHemisphereVisibility: boolean
}

const PROJECTION_DEFINITIONS: Record<GlobeProjectionKey, ProjectionDefinition> = {
  mercator: {
    clipAngle: null,
    createProjection: () => geoMercator(),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 80,
    usesHemisphereVisibility: false,
  },
  equirectangular: {
    clipAngle: null,
    createProjection: () => geoEquirectangular(),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 85,
    usesHemisphereVisibility: false,
  },
  orthographic: {
    clipAngle: 90,
    createProjection: () => geoOrthographic(),
    defaultRotation: DEFAULT_ROTATION,
    fitGeometry: { type: 'Sphere' } as GeoPermissibleObjects,
    interactionMode: 'globe',
    maxLatitude: 75,
    usesHemisphereVisibility: true,
  },
  albers: {
    clipAngle: null,
    createProjection: () => geoAlbers().center([0, 10]).parallels([-30, 60]),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 82,
    usesHemisphereVisibility: false,
  },
  'natural-earth': {
    clipAngle: null,
    createProjection: () => geoNaturalEarth1(),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 85,
    usesHemisphereVisibility: false,
  },
  'equal-earth': {
    clipAngle: null,
    createProjection: () => geoEqualEarth(),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 85,
    usesHemisphereVisibility: false,
  },
  stereographic: {
    clipAngle: 90,
    createProjection: () => geoStereographic(),
    defaultRotation: [0, 0, 0],
    fitGeometry: { type: 'Sphere' } as GeoPermissibleObjects,
    interactionMode: 'map',
    maxLatitude: 80,
    usesHemisphereVisibility: false,
  },
  'conic-conformal': {
    clipAngle: null,
    createProjection: () => geoConicConformal().center([0, 15]).parallels([20, 60]),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 82,
    usesHemisphereVisibility: false,
  },
  mollweide: {
    clipAngle: null,
    createProjection: () => geoMollweide(),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 85,
    usesHemisphereVisibility: false,
  },
  robinson: {
    clipAngle: null,
    createProjection: () => geoRobinson(),
    defaultRotation: [0, 0, 0],
    fitGeometry: RECTANGULAR_WORLD_OUTLINE,
    interactionMode: 'map',
    maxLatitude: 85,
    usesHemisphereVisibility: false,
  },
}

function latestAnsweredId(answeredIds: Set<string>): string | null {
  let latestId: string | null = null

  for (const answeredId of answeredIds) {
    latestId = answeredId
  }

  return latestId
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function interpolateNumber(start: number, end: number, t: number): number {
  return start + (end - start) * t
}

function distanceBetweenTouches(firstTouch: Touch, secondTouch: Touch): number {
  return Math.hypot(
    secondTouch.clientX - firstTouch.clientX,
    secondTouch.clientY - firstTouch.clientY,
  )
}

function toMiles(distanceRadians: number): number {
  return Math.round(distanceRadians * EARTH_RADIUS_MILES)
}

function roundedMetric(value: number | null, fractionDigits = 1): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }

  return Number(value.toFixed(fractionDigits))
}

function normaliseAtlasId(value: string | number | undefined): string | null {
  if (value === undefined) {
    return null
  }

  return String(value).padStart(3, '0')
}

function normalisePolygonCoordinates(
  coordinates: number[][][],
): number[][][] {
  const polygon = {
    type: 'Polygon',
    coordinates,
  } as GeoPermissibleObjects

  if (geoArea(polygon) <= MAX_COUNTRY_POLYGON_AREA) {
    return coordinates
  }

  return coordinates.map((ring) => [...ring].reverse())
}

function normaliseCountryFeature(feature: AtlasFeature): AtlasFeature {
  if (!('geometry' in feature) || !feature.geometry) {
    return feature
  }

  if (feature.geometry.type === 'Polygon') {
    const geometry = feature.geometry as {
      type: 'Polygon'
      coordinates: number[][][]
    }

    return {
      ...feature,
      geometry: {
        ...geometry,
        coordinates: normalisePolygonCoordinates(geometry.coordinates),
      },
    }
  }

  if (feature.geometry.type === 'MultiPolygon') {
    const geometry = feature.geometry as {
      type: 'MultiPolygon'
      coordinates: number[][][][]
    }

    return {
      ...feature,
      geometry: {
        ...geometry,
        coordinates: geometry.coordinates.map((polygonCoordinates) =>
          normalisePolygonCoordinates(polygonCoordinates),
        ),
      },
    }
  }

  return feature
}

function shortestLongitudeTarget(startLongitude: number, targetLongitude: number): number {
  const delta = ((targetLongitude - startLongitude + 540) % 360) - 180
  return startLongitude + delta
}

function greatArcCoordinates(
  fromCoordinates: [number, number],
  toCoordinates: [number, number],
): [number, number][] {
  const angularDistance = geoDistance(fromCoordinates, toCoordinates)

  if (angularDistance < 0.000001) {
    return [fromCoordinates, toCoordinates]
  }

  const sampleCount = Math.max(
    18,
    Math.ceil(angularDistance / FLIGHT_PATH_SAMPLE_STEP_RADIANS),
  )
  const interpolateCoordinates = geoInterpolate(fromCoordinates, toCoordinates)

  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    return interpolateCoordinates(index / sampleCount) as [number, number]
  })
}

function visitCoordinates(
  value: unknown,
  visitor: (coordinates: [number, number]) => void,
): void {
  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      visitor([value[0], value[1]])
      return
    }

    for (const entry of value) {
      visitCoordinates(entry, visitor)
    }

    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  const candidate = value as {
    coordinates?: unknown
    geometries?: unknown[]
    geometry?: unknown
  }

  if (candidate.coordinates !== undefined) {
    visitCoordinates(candidate.coordinates, visitor)
  }

  if (Array.isArray(candidate.geometries)) {
    for (const geometry of candidate.geometries) {
      visitCoordinates(geometry, visitor)
    }
  }

  if (candidate.geometry !== undefined) {
    visitCoordinates(candidate.geometry, visitor)
  }
}

function featureAngularRadius(feature: GeoPermissibleObjects, centroid: [number, number]): number {
  let maxDistance = 0

  visitCoordinates(feature, (coordinates) => {
    maxDistance = Math.max(maxDistance, geoDistance(centroid, coordinates))
  })

  return Math.max(maxDistance, MIN_COUNTRY_ANGULAR_RADIUS)
}

function toCartesian(coordinates: [number, number]): [number, number, number] {
  const [longitude, latitude] = coordinates
  const longitudeRadians = (longitude * Math.PI) / 180
  const latitudeRadians = (latitude * Math.PI) / 180
  const cosLatitude = Math.cos(latitudeRadians)

  return [
    cosLatitude * Math.cos(longitudeRadians),
    cosLatitude * Math.sin(longitudeRadians),
    Math.sin(latitudeRadians),
  ]
}

function toSpherical([x, y, z]: [number, number, number]): [number, number] | null {
  const magnitude = Math.hypot(x, y, z)

  if (magnitude < 0.000001) {
    return null
  }

  const normalizedX = x / magnitude
  const normalizedY = y / magnitude
  const normalizedZ = z / magnitude

  return [
    (Math.atan2(normalizedY, normalizedX) * 180) / Math.PI,
    (Math.atan2(normalizedZ, Math.hypot(normalizedX, normalizedY)) * 180) / Math.PI,
  ]
}

function primaryLabelFeature(feature: AtlasFeature): GeoPermissibleObjects {
  const geometry =
    'geometry' in feature && feature.geometry
      ? (feature.geometry as AtlasFeature)
      : feature

  if (geometry.type === 'Polygon') {
    return geometry
  }

  if (geometry.type !== 'MultiPolygon') {
    return geometry
  }

  const multiPolygonGeometry = geometry as {
    type: 'MultiPolygon'
    coordinates: number[][][][]
  }

  let largestPolygon = multiPolygonGeometry.coordinates[0]
  let largestArea = 0

  for (const polygonCoordinates of multiPolygonGeometry.coordinates) {
    const polygon = {
      type: 'Polygon',
      coordinates: polygonCoordinates,
    } as GeoPermissibleObjects
    const area = geoArea(polygon)

    if (area > largestArea) {
      largestArea = area
      largestPolygon = polygonCoordinates
    }
  }

  return {
    type: 'Polygon',
    coordinates: largestPolygon,
  } as GeoPermissibleObjects
}

function buildAtlasBundle(topology: Topology, countries: QuizCountry[]): AtlasBundle {
  const countryFeatures = (feature(topology as never, topology.objects.countries as never) as unknown as {
    features: AtlasFeature[]
  }).features
  const landFeature = feature(
    topology as never,
    topology.objects.land as never,
  ) as unknown as GeoPermissibleObjects
  const borderMesh = mesh(
    topology as never,
    topology.objects.countries as never,
    ((left: unknown, right: unknown) => left !== right) as never,
  ) as unknown as GeoPermissibleObjects

  const byCcn3 = new Map<string, AtlasFeature>()
  const byName = new Map<string, AtlasFeature>()

  for (const countryFeature of countryFeatures) {
    const atlasId = normaliseAtlasId(countryFeature.id)

    if (atlasId) {
      byCcn3.set(atlasId, countryFeature)
    }

    const featureName = countryFeature.properties?.name

    if (featureName) {
      byName.set(featureName, countryFeature)
    }
  }

  const featureByCountryId = new Map<string, AtlasFeature>()
  const labelFeatureByCountryId = new Map<string, GeoPermissibleObjects>()
  const countryCentroidById = new Map<string, [number, number]>()
  const countryAngularRadiusById = new Map<string, number>()
  prepareHemisphereGeometry(landFeature)
  prepareHemisphereGeometry(borderMesh)

  for (const country of countries) {
    const matchedFeatureSource =
      byName.get(country.atlasName) ??
      (country.ccn3 ? byCcn3.get(country.ccn3.padStart(3, '0')) : undefined)

    if (!matchedFeatureSource) {
      continue
    }

    const matchedFeature = normaliseCountryFeature(matchedFeatureSource)

    featureByCountryId.set(country.id, matchedFeature)
    const labelFeature = primaryLabelFeature(matchedFeature)
    prepareHemisphereGeometry(matchedFeature)
    prepareHemisphereGeometry(labelFeature)
    labelFeatureByCountryId.set(country.id, labelFeature)
    const centroid = geoCentroid(labelFeature) as [number, number]
    countryCentroidById.set(country.id, centroid)
    countryAngularRadiusById.set(country.id, featureAngularRadius(labelFeature, centroid))
  }

  return {
    borderMesh,
    countryCentroidById,
    countryAngularRadiusById,
    featureByCountryId,
    labelFeatureByCountryId,
    landFeature,
  }
}

export async function createGlobe(
  container: HTMLElement,
  countries: QuizCountry[],
  options?: {
    initialProjection?: GlobeProjectionKey
    onCountryCheat?: (countryId: string) => void
    onFlightPerformanceChange?: (performance: GlobeFlightPerformance | null) => void
  },
): Promise<GlobeController> {
  const [topology, interactionTopology] = await Promise.all([
    fetch(atlasUrl).then((response) => response.json()) as Promise<Topology>,
    fetch(interactionAtlasUrl).then((response) => response.json()) as Promise<Topology>,
  ])
  const atlas = buildAtlasBundle(topology, countries)
  const interactionAtlas = buildAtlasBundle(interactionTopology, countries)
  for (const country of countries) {
    const labelFeature = atlas.labelFeatureByCountryId.get(country.id)
    if (labelFeature) prepareHemisphereLabel(labelFeature, Math.max(country.name.length, country.capitalDisplayName.length) * 10 + 40)
  }
  let detailAtlas: AtlasBundle | null = null
  void fetch(detailAtlasUrl)
    .then((response) => response.json() as Promise<Topology>)
    .then((resolvedTopology) => {
      detailAtlas = buildAtlasBundle(resolvedTopology, countries)

      if (outlineDetailMode === 'settled') {
        scheduleRender()
      }
    })
    .catch(() => undefined)
  const fallbackFeatureByCountryId = new Map<string, AtlasFeature>()
  const fallbackLabelFeatureByCountryId = new Map<string, GeoPermissibleObjects>()
  const fallbackCentroidByCountryId = new Map<string, [number, number]>()
  const fallbackAngularRadiusByCountryId = new Map<string, number>()
  const countryById = new Map(countries.map((country) => [country.id, country]))

  for (const rawFeature of fallbackFeatures as AtlasFeature[]) {
    const normalizedFeature = normaliseCountryFeature(rawFeature)
    const atlasId = normaliseAtlasId(rawFeature.id)
    const country = countries.find((candidate) => {
      return (candidate.ccn3 && candidate.ccn3 === atlasId) || candidate.atlasName === rawFeature.properties?.name
    })

    if (!country) {
      continue
    }

    fallbackFeatureByCountryId.set(country.id, normalizedFeature)
    const labelFeature = primaryLabelFeature(normalizedFeature)
    prepareHemisphereLabel(labelFeature, Math.max(country.name.length, country.capitalDisplayName.length) * 10 + 40)
    fallbackLabelFeatureByCountryId.set(country.id, labelFeature)
    const centroid = geoCentroid(labelFeature) as [number, number]
    fallbackCentroidByCountryId.set(country.id, centroid)
    fallbackAngularRadiusByCountryId.set(country.id, featureAngularRadius(labelFeature, centroid))
  }

  container.replaceChildren()

  const mapSvg = select(container)
    .append('svg')
    .attr('class', 'globe__map-svg')
    .attr('aria-hidden', 'true')

  const labelsSvg = select(container)
    .append('svg')
    .attr('class', 'globe__labels-svg')
    .attr('role', 'img')
    .attr('aria-label', 'Interactive globe showing countries of the world')

  const mapLayer = mapSvg.append('g').attr('class', 'globe__map')
  const spherePath = mapLayer.append('path').attr('class', 'globe__sphere')
  const graticulePath = mapLayer.append('path').attr('class', 'globe__graticule')
  const countriesLayer = mapLayer.append('g').attr('class', 'globe__countries')
  const solvedLayer = mapLayer.append('g').attr('class', 'globe__solved')
  const flightLayer = mapLayer.append('g').attr('class', 'globe__flights')
  const flightTrailLayer = flightLayer.append('g').attr('class', 'globe__flight-trails')
  const flightActiveLayer = flightLayer.append('g').attr('class', 'globe__flight-active')
  const coastlinePath = mapLayer.append('path').attr('class', 'globe__coastlines')
  const borderPath = mapLayer.append('path').attr('class', 'globe__borders')
  const fallbackOutlineLayer = mapLayer.append('g').attr('class', 'globe__fallback-outlines')
  const hitTargetLayer = mapLayer.append('g').attr('class', 'globe__hit-targets')
  const labelLayer = labelsSvg.append('g').attr('class', 'globe__labels')
  const planeLayer = labelsSvg.append('g').attr('class', 'globe__plane-layer').attr('aria-hidden', 'true')
  const planeMarker = planeLayer.append('g').attr('class', 'globe__plane')
  planeMarker.append('circle').attr('class', 'globe__plane-halo')
  planeMarker.append('text').attr('class', 'globe__plane-emoji').text(PLANE_EMOJI)
  let currentProjectionKey = options?.initialProjection ?? DEFAULT_GLOBE_PROJECTION
  let projection = createProjection(currentProjectionKey)
  let measurementPath = geoPath(projection)
  let hemispherePath: ReturnType<typeof createHemispherePath> | null = null
  // Projection-dependent positions live for one render only. Labels and the
  // plane use the same polygon centroid, including its horizon clipping.
  const projectedLabelPositions = new Map<string, [number, number] | null>()
  const paintedLabels = new WeakMap<SVGGElement, GlobeLabel>()
  const paintedCountryFills = new WeakMap<SVGPathElement, string>()
  const preloadedFlags = new Map<string, HTMLImageElement>()
  const graticule = geoGraticule10()
  const desktopFlightTrailsMediaQuery = window.matchMedia(DESKTOP_FLIGHT_TRAILS_MEDIA_QUERY)

  let answeredIds = new Set<string>()
  let activeCountryIds = new Set(countries.map((country) => country.id))
  let cheatedIds = new Set<string>()
  let skippedIds = new Set<string>()
  let flightSegments: FlightSegment[] = []
  let activeFlightSegmentId: string | null = null
  let activeFlightProgress = 1
  let promptedCountryId: string | null = null
  let answerKind: 'country' | 'capital' = 'country'
  let renderMode: 'free' | 'route' = 'free'
  let preAnswerLabelMode: PreAnswerLabelMode = 'none'
  let showAllCountryLabels = false
  let showPreAnswerFlags = false
  let showUnansweredMarkers = false
  let currentZoom = 1
  let cssWidth = 760
  let cssHeight = 760
  let fittedBaseScale = Math.max(1, Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO)
  let fittedBaseTranslate: [number, number] = [cssWidth / 2, cssHeight / 2]
  let mapPanOffset: [number, number] = [0, 0]
  let flyFrame: number | null = null
  let framePending = false
  let planeCoordinates: [number, number] | null = null
  let pinchZoomState: PinchZoomState | null = null
  let showDesktopFlightTrails = desktopFlightTrailsMediaQuery.matches
  let touchCheatState: TouchCheatState | null = null
  let debugFlightSequence = 0
  let flightPerformance: GlobeFlightPerformance | null = null
  let flightPerformanceAccumulator: FlightPerformanceAccumulator | null = null
  let outlineDetailMode: 'interactive' | 'settled' = 'settled'
  let outlineMotionSources = new Set<MotionSource>()
  let outlineSettleTimeoutId: number | null = null
  let wheelMotionTimeoutId: number | null = null
  let pendingFlightCompletion:
    | ((performance: GlobeFlightPerformance | null) => void)
    | null = null

  function projectionDefinition(projectionKey = currentProjectionKey): ProjectionDefinition {
    return PROJECTION_DEFINITIONS[projectionKey]
  }

  function projectionInteractionMode(
    projectionKey = currentProjectionKey,
  ): ProjectionDefinition['interactionMode'] {
    return projectionDefinition(projectionKey).interactionMode
  }

  function usesGlobeInteraction(projectionKey = currentProjectionKey): boolean {
    return projectionInteractionMode(projectionKey) === 'globe'
  }

  function projectionRotation(): [number, number, number] {
    if (usesGlobeInteraction()) {
      return projection.rotate() as [number, number, number]
    }

    return projectionDefinition().defaultRotation
  }

  function createProjection(
    projectionKey: GlobeProjectionKey,
    rotation: [number, number, number] = projectionDefinition(projectionKey).defaultRotation,
  ): GeoProjection {
    const definition = projectionDefinition(projectionKey)
    const nextProjection = definition.createProjection().precision(0.6)
    nextProjection.clipAngle(definition.clipAngle)
    nextProjection.rotate(rotation)
    return nextProjection
  }

  function currentScale(): number {
    return fittedBaseScale * currentZoom
  }

  function projectionLatitudeLimit(): number {
    return projectionDefinition().maxLatitude
  }

  function clampProjectionLatitude(latitude: number): number {
    const limit = projectionLatitudeLimit()
    return Math.max(-limit, Math.min(limit, latitude))
  }

  function currentSurfaceGeometry(): GeoPermissibleObjects {
    return projectionDefinition().fitGeometry
  }

  function currentTranslate(): [number, number] {
    if (usesGlobeInteraction()) {
      return fittedBaseTranslate
    }

    return [
      fittedBaseTranslate[0] + mapPanOffset[0],
      fittedBaseTranslate[1] + mapPanOffset[1],
    ]
  }

  function applyProjectionTransform(nextProjection: GeoProjection): void {
    nextProjection
      .translate(currentTranslate())
      .scale(currentScale())
  }

  function applyProjectionLayout(): void {
    const rotation = projectionRotation()
    const layoutProjection = createProjection(currentProjectionKey, rotation)
    layoutProjection.scale(1).translate([0, 0])

    const [[x0, y0], [x1, y1]] = geoPath(layoutProjection).bounds(currentSurfaceGeometry())

    if (![x0, y0, x1, y1].every(Number.isFinite)) {
      fittedBaseScale = Math.max(1, Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO)
      fittedBaseTranslate = [cssWidth / 2, cssHeight / 2]
      projection = layoutProjection
      measurementPath = geoPath(projection)
      applyProjectionTransform(projection)
      return
    }

    const fitPadding = Math.max(
      MIN_FIT_PADDING_PX,
      Math.min(cssWidth, cssHeight) * FIT_PADDING_RATIO,
    )
    const geometryWidth = Math.max(0.000001, x1 - x0)
    const geometryHeight = Math.max(0.000001, y1 - y0)

    fittedBaseScale = Math.max(
      0.000001,
      Math.min(
        Math.max(1, cssWidth - fitPadding * 2) / geometryWidth,
        Math.max(1, cssHeight - fitPadding * 2) / geometryHeight,
      ),
    )

    projection = layoutProjection
    measurementPath = geoPath(projection)
    fittedBaseTranslate = [
      cssWidth / 2 - currentScale() * ((x0 + x1) / 2),
      cssHeight / 2 - currentScale() * ((y0 + y1) / 2),
    ]
    applyProjectionTransform(projection)
  }

  function setViewCenter(center: [number, number]): void {
    if (usesGlobeInteraction()) {
      const [, , gamma] = projection.rotate()
      projection.rotate([
        shortestLongitudeTarget(projection.rotate()[0], -center[0]),
        -clampProjectionLatitude(center[1]),
        gamma,
      ])
      return
    }

    applyProjectionLayout()
    const projectedCenter = projection(center)

    if (!projectedCenter) {
      return
    }

    mapPanOffset = [
      mapPanOffset[0] + (cssWidth / 2 - projectedCenter[0]),
      mapPanOffset[1] + (cssHeight / 2 - projectedCenter[1]),
    ]
  }

  function publishFlightPerformance(): void {
    options?.onFlightPerformanceChange?.(
      flightPerformance
        ? {
          ...flightPerformance,
        }
        : null,
    )
  }

  function clampZoom(nextZoom: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
  }

  function writeRenderState(): void {
    const [rotationLongitude, rotationLatitude] = projection.rotate()
    container.dataset.detailMode = outlineDetailMode
    container.dataset.projection = currentProjectionKey
    container.dataset.panX = mapPanOffset[0].toFixed(2)
    container.dataset.panY = mapPanOffset[1].toFixed(2)
    container.dataset.rotationLon = rotationLongitude.toFixed(2)
    container.dataset.rotationLat = rotationLatitude.toFixed(2)
    container.dataset.zoom = currentZoom.toFixed(3)
  }

  function clearOutlineSettleTimeout(): void {
    if (outlineSettleTimeoutId === null) {
      return
    }

    window.clearTimeout(outlineSettleTimeoutId)
    outlineSettleTimeoutId = null
  }

  function setOutlineDetailMode(nextMode: 'interactive' | 'settled'): void {
    if (outlineDetailMode === nextMode) {
      return
    }

    outlineDetailMode = nextMode
    scheduleRender()
  }

  function beginOutlineMotion(source: MotionSource): void {
    clearOutlineSettleTimeout()
    outlineMotionSources.add(source)
    setOutlineDetailMode('interactive')
  }

  function endOutlineMotion(
    source: MotionSource,
    delayMs = SETTLED_OUTLINE_DELAY_MS,
  ): void {
    outlineMotionSources.delete(source)

    if (outlineMotionSources.size > 0) {
      return
    }

    clearOutlineSettleTimeout()
    outlineSettleTimeoutId = window.setTimeout(() => {
      outlineSettleTimeoutId = null

      if (outlineMotionSources.size === 0) {
        setOutlineDetailMode('settled')
      }
    }, delayMs)
  }

  function pulseWheelOutlineMotion(): void {
    beginOutlineMotion('wheel')

    if (wheelMotionTimeoutId !== null) {
      window.clearTimeout(wheelMotionTimeoutId)
    }

    wheelMotionTimeoutId = window.setTimeout(() => {
      wheelMotionTimeoutId = null
      endOutlineMotion('wheel')
    }, SETTLED_OUTLINE_DELAY_MS)
  }

  function syncCanvasSize(): void {
    const bounds = container.getBoundingClientRect()
    cssWidth = Math.max(1, bounds.width)
    cssHeight = Math.max(1, bounds.height)

    applyProjectionLayout()

    mapSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
    labelsSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
    scheduleRender()
  }

  function projectedPathData(geometry: GeoPermissibleObjects, useHemisphereBounds = true): string {
    if (hemispherePath && useHemisphereBounds) return hemispherePath.path(geometry)
    return measurementPath(geometry) ?? ''
  }

  function isVisible(coordinates: [number, number]): boolean {
    if (!projection(coordinates)) {
      return false
    }

    if (!projectionDefinition().usesHemisphereVisibility) {
      return true
    }

    const [rotationLongitude, rotationLatitude] = projection.rotate()
    const center: [number, number] = [-rotationLongitude, -rotationLatitude]
    return geoDistance(center, coordinates) < Math.PI / 2 - 0.05
  }

  function centroidForCountry(countryId: string): [number, number] | null {
    return (
      fallbackCentroidByCountryId.get(countryId) ??
      atlas.countryCentroidById.get(countryId) ??
      null
    )
  }

  function featureForCountry(countryId: string): AtlasFeature | null {
    return (
      fallbackFeatureByCountryId.get(countryId) ??
      atlas.featureByCountryId.get(countryId) ??
      null
    )
  }

  function displayFeatureForCountry(
    countryId: string,
    displayAtlas: AtlasBundle,
  ): AtlasFeature | null {
    return (
      fallbackFeatureByCountryId.get(countryId) ??
      displayAtlas.featureByCountryId.get(countryId) ??
      atlas.featureByCountryId.get(countryId) ??
      null
    )
  }

  function interactionFeatureForCountry(countryId: string): AtlasFeature | null {
    return (
      fallbackFeatureByCountryId.get(countryId) ??
      interactionAtlas.featureByCountryId.get(countryId) ??
      atlas.featureByCountryId.get(countryId) ??
      null
    )
  }

  function labelFeatureForCountry(countryId: string): GeoPermissibleObjects | null {
    return (
      fallbackLabelFeatureByCountryId.get(countryId) ??
      atlas.labelFeatureByCountryId.get(countryId) ??
      featureForCountry(countryId)
    )
  }

  function angularRadiusForCountry(countryId: string): number | null {
    return (
      fallbackAngularRadiusByCountryId.get(countryId) ??
      atlas.countryAngularRadiusById.get(countryId) ??
      null
    )
  }

  function zoomForCountry(countryId: string): number {
    const angularRadius = angularRadiusForCountry(countryId) ?? MIN_COUNTRY_ANGULAR_RADIUS
    return zoomForAngularRadius(angularRadius, FOCUS_COUNTRY_RADIUS_PX)
  }

  function zoomForAngularRadius(angularRadius: number, targetPixelRadius: number): number {
    const baseScale = fittedBaseScale
    const targetZoom = targetPixelRadius / Math.max(baseScale * angularRadius, 0.0001)
    return clampZoom(targetZoom)
  }

  function regionView(countryIds: Iterable<string>): {
    center: [number, number]
    zoom: number
  } | null {
    let vectorX = 0
    let vectorY = 0
    let vectorZ = 0
    let includedCountryCount = 0
    const countriesWithGeometry: Array<{
      angularRadius: number
      centroid: [number, number]
    }> = []

    for (const countryId of countryIds) {
      const centroid = centroidForCountry(countryId)

      if (!centroid) {
        continue
      }

      const [x, y, z] = toCartesian(centroid)
      vectorX += x
      vectorY += y
      vectorZ += z
      includedCountryCount += 1
      countriesWithGeometry.push({
        angularRadius: angularRadiusForCountry(countryId) ?? MIN_COUNTRY_ANGULAR_RADIUS,
        centroid,
      })
    }

    if (includedCountryCount === 0) {
      return null
    }

    const center = toSpherical([vectorX, vectorY, vectorZ])

    if (!center) {
      return null
    }

    let maxAngularRadius = MIN_COUNTRY_ANGULAR_RADIUS

    for (const country of countriesWithGeometry) {
      maxAngularRadius = Math.max(
        maxAngularRadius,
        geoDistance(center, country.centroid) + country.angularRadius,
      )
    }

    const targetPixelRadius = Math.min(cssWidth, cssHeight) * FOCUS_REGION_RADIUS_RATIO

    return {
      center,
      zoom: zoomForAngularRadius(maxAngularRadius, targetPixelRadius),
    }
  }

  function flightPathGeometry(
    segment: FlightSegment,
    progress = 1,
  ): GeoPermissibleObjects {
    if (progress >= 1) {
      return {
        type: 'LineString',
        coordinates: segment.pathCoordinates,
      } as GeoPermissibleObjects
    }

    const interpolatedCoordinates = geoInterpolate(
      segment.fromCoordinates,
      segment.toCoordinates,
    )(Math.max(0, progress)) as [number, number]
    const lastIndex = segment.pathCoordinates.length - 1
    const visiblePointCount = Math.max(1, Math.floor(lastIndex * Math.max(0, progress)))
    const coordinates = segment.pathCoordinates.slice(0, visiblePointCount + 1)
    const lastCoordinates = coordinates[coordinates.length - 1]

    if (
      !lastCoordinates ||
      lastCoordinates[0] !== interpolatedCoordinates[0] ||
      lastCoordinates[1] !== interpolatedCoordinates[1]
    ) {
      coordinates.push(interpolatedCoordinates)
    }

    return {
      type: 'LineString',
      coordinates,
    } as GeoPermissibleObjects
  }

  function buildFlightSegments(answerOrder: string[]): {
    planePosition: [number, number] | null
    segments: FlightSegment[]
    status: GlobeFlightStatus | null
  } {
    const startCountry = countryById.get(FLIGHT_START_COUNTRY_ID)
    let previousCountryId = FLIGHT_START_COUNTRY_ID
    let previousCoordinates = centroidForCountry(previousCountryId)
    let totalMiles = 0
    const segments: FlightSegment[] = []

    for (const [index, countryId] of answerOrder.entries()) {
      const fromCountry = countryById.get(previousCountryId) ?? startCountry
      const toCountry = countryById.get(countryId)
      const toCoordinates = centroidForCountry(countryId)

      if (!fromCountry || !toCountry || !previousCoordinates || !toCoordinates) {
        previousCountryId = countryId
        previousCoordinates = toCoordinates
        continue
      }

      const fromLabel = answerKind === 'capital' ? fromCountry.capitalDisplayName : fromCountry.name
      const toLabel = answerKind === 'capital' ? toCountry.capitalDisplayName : toCountry.name

      const miles = toMiles(geoDistance(previousCoordinates, toCoordinates))
      totalMiles += miles
      segments.push({
        fromCoordinates: previousCoordinates,
        fromCountryId: previousCountryId,
        fromName: fromLabel,
        id: `${index}-${previousCountryId}-${countryId}`,
        miles,
        pathCoordinates: greatArcCoordinates(previousCoordinates, toCoordinates),
        toCoordinates,
        toCountryId: countryId,
        toName: toLabel,
      })
      previousCountryId = countryId
      previousCoordinates = toCoordinates
    }

    const lastSegment = segments.at(-1) ?? null

    return {
      planePosition: previousCoordinates,
      segments,
      status: lastSegment
        ? {
          fromName: lastSegment.fromName,
          legMiles: lastSegment.miles,
          toName: lastSegment.toName,
          totalMiles,
        }
        : null,
    }
  }

  function directFlightSegment(
    fromCountryId: string,
    toCountryId: string,
  ): FlightSegment | null {
    const fromCountry = countryById.get(fromCountryId)
    const toCountry = countryById.get(toCountryId)
    const fromCoordinates = centroidForCountry(fromCountryId)
    const toCoordinates = centroidForCountry(toCountryId)

    if (!fromCountry || !toCountry || !fromCoordinates || !toCoordinates) {
      return null
    }

    return {
      fromCoordinates,
      fromCountryId,
      fromName: answerKind === 'capital' ? fromCountry.capitalDisplayName : fromCountry.name,
      id: `debug-${debugFlightSequence += 1}-${fromCountryId}-${toCountryId}`,
      miles: toMiles(geoDistance(fromCoordinates, toCoordinates)),
      pathCoordinates: greatArcCoordinates(fromCoordinates, toCoordinates),
      toCoordinates,
      toCountryId,
      toName: answerKind === 'capital' ? toCountry.capitalDisplayName : toCountry.name,
    }
  }

  function startFlightPerformance(segment: FlightSegment, startTime: number): void {
    flightPerformance = {
      averageFps: null,
      averageFrameMs: null,
      elapsedMs: 0,
      frameCount: 0,
      fromCountryId: segment.fromCountryId,
      fromName: segment.fromName,
      maxFrameMs: null,
      minFps: null,
      status: 'running',
      toCountryId: segment.toCountryId,
      toName: segment.toName,
    }
    flightPerformanceAccumulator = {
      lastFrameTime: null,
      lastPublishedTime: Number.NEGATIVE_INFINITY,
      maxFrameMs: 0,
      sampledFrameCount: 0,
      startTime,
      totalFrameMs: 0,
    }
    publishFlightPerformance()
  }

  function sampleFlightPerformance(now: number): void {
    if (!flightPerformance || !flightPerformanceAccumulator) {
      return
    }

    const accumulator = flightPerformanceAccumulator

    if (accumulator.lastFrameTime !== null) {
      const frameMs = now - accumulator.lastFrameTime
      accumulator.sampledFrameCount += 1
      accumulator.totalFrameMs += frameMs
      accumulator.maxFrameMs = Math.max(accumulator.maxFrameMs, frameMs)
      const averageFrameMs = accumulator.totalFrameMs / accumulator.sampledFrameCount

      flightPerformance = {
        ...flightPerformance,
        averageFps: roundedMetric(1000 / averageFrameMs),
        averageFrameMs: roundedMetric(averageFrameMs, 2),
        elapsedMs: roundedMetric(now - accumulator.startTime, 1) ?? 0,
        frameCount: accumulator.sampledFrameCount,
        maxFrameMs: roundedMetric(accumulator.maxFrameMs, 2),
        minFps: roundedMetric(1000 / accumulator.maxFrameMs),
      }
    } else {
      flightPerformance = {
        ...flightPerformance,
        elapsedMs: roundedMetric(now - accumulator.startTime, 1) ?? 0,
      }
    }

    accumulator.lastFrameTime = now

    if (now - accumulator.lastPublishedTime >= 125) {
      accumulator.lastPublishedTime = now
      publishFlightPerformance()
    }
  }

  function settleFlightPerformance(
    status: 'complete' | 'cancelled',
  ): GlobeFlightPerformance | null {
    const accumulator = flightPerformanceAccumulator

    if (!flightPerformance || !accumulator) {
      if (pendingFlightCompletion) {
        pendingFlightCompletion(null)
        pendingFlightCompletion = null
      }

      return null
    }

    const now = performance.now()
    const updatedPerformance =
      accumulator.sampledFrameCount > 0
        ? {
          ...flightPerformance,
          elapsedMs: roundedMetric(now - accumulator.startTime, 1) ?? flightPerformance.elapsedMs,
        }
        : {
          ...flightPerformance,
          elapsedMs: roundedMetric(now - accumulator.startTime, 1) ?? 0,
        }

    flightPerformance = {
      ...updatedPerformance,
      status,
    }
    flightPerformanceAccumulator = null
    publishFlightPerformance()

    const snapshot = {
      ...flightPerformance,
    }

    if (pendingFlightCompletion) {
      pendingFlightCompletion(snapshot)
      pendingFlightCompletion = null
    }

    return snapshot
  }

  function renderFlights(): void {
    const renderedSegments = showDesktopFlightTrails ? flightSegments : []

    const activeSegment = showDesktopFlightTrails
      ? flightSegments.find((segment) => segment.id === activeFlightSegmentId) ?? null
      : null

    flightTrailLayer
      .selectAll<SVGPathElement, FlightSegment>('path.globe__flight-trail')
      .data(renderedSegments, (segment) => segment.id)
      .join('path')
      .attr('class', 'globe__flight-trail')
      // Flight arcs change each frame and do not benefit from cached geometry bounds.
      .attr('d', (segment) => projectedPathData(flightPathGeometry(segment), false))
      .attr('fill', 'none')
      .attr('stroke', (segment) =>
        segment.id === activeFlightSegmentId
          ? 'rgba(255, 234, 163, 0.24)'
          : 'rgba(255, 226, 120, 0.18)',
      )
      .attr('stroke-width', (segment) => (segment.id === activeFlightSegmentId ? 1.35 : 1.1))
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .attr('stroke-dasharray', (segment) =>
        segment.id === activeFlightSegmentId ? '4.5 7.5' : '3.2 8.2',
      )

    flightActiveLayer
      .selectAll<SVGPathElement, FlightSegment>('path.globe__flight-progress')
      .data(activeSegment ? [activeSegment] : [], (segment) => segment.id)
      .join('path')
      .attr('class', 'globe__flight-progress')
      .attr('d', (segment) => projectedPathData(flightPathGeometry(segment, activeFlightProgress), false))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255, 239, 187, 0.68)')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
  }

  function projectedLabelPosition(countryId: string): [number, number] | null {
    if (projectedLabelPositions.has(countryId)) {
      return projectedLabelPositions.get(countryId)!
    }

    const position = computeProjectedLabelPosition(countryId)
    projectedLabelPositions.set(countryId, position)
    return position
  }

  function computeProjectedLabelPosition(countryId: string): [number, number] | null {
    const centroid = centroidForCountry(countryId)
    const labelFeature = labelFeatureForCountry(countryId)

    if (!centroid || !labelFeature || !isVisible(centroid)) {
      return null
    }

    const projected = (hemispherePath ?? measurementPath).centroid(labelFeature)

    if (!projected || Number.isNaN(projected[0]) || Number.isNaN(projected[1])) {
      return null
    }

    return [projected[0], projected[1]]
  }

  function projectedPlaneLabelAnchor(countryId: string): [number, number] | null {
    const projectedLabel = projectedLabelPosition(countryId)

    if (!projectedLabel) {
      return null
    }

    return [projectedLabel[0], projectedLabel[1] + PLANE_LABEL_OFFSET_PX]
  }

  function correctedProjectedPlanePosition(
    segment: FlightSegment,
    progress: number,
  ): [number, number] | null {
    const projectedFlightPoint = projection(
      geoInterpolate(segment.fromCoordinates, segment.toCoordinates)(progress) as [number, number],
    )

    if (!projectedFlightPoint) {
      return null
    }

    const projectedStart = projection(segment.fromCoordinates)
    const projectedEnd = projection(segment.toCoordinates)
    const startAnchor = projectedPlaneLabelAnchor(segment.fromCountryId)
    const endAnchor = projectedPlaneLabelAnchor(segment.toCountryId)

    if (!projectedStart || !projectedEnd || !startAnchor || !endAnchor) {
      return [projectedFlightPoint[0], projectedFlightPoint[1]]
    }

    const startDx = startAnchor[0] - projectedStart[0]
    const startDy = startAnchor[1] - projectedStart[1]
    const endDx = endAnchor[0] - projectedEnd[0]
    const endDy = endAnchor[1] - projectedEnd[1]

    return [
      projectedFlightPoint[0] + interpolateNumber(startDx, endDx, progress),
      projectedFlightPoint[1] + interpolateNumber(startDy, endDy, progress),
    ]
  }

  function planeHeadingDegrees(segment: FlightSegment, progress: number): number {
    const startProgress = Math.max(0, Math.min(1, progress - PLANE_TANGENT_SAMPLE_STEP))
    const endProgress = Math.max(0, Math.min(1, progress + PLANE_TANGENT_SAMPLE_STEP))

    if (Math.abs(endProgress - startProgress) < 0.0001) {
      return 0
    }

    const interpolateCoordinates = geoInterpolate(
      segment.fromCoordinates,
      segment.toCoordinates,
    )
    const startPoint = projection(interpolateCoordinates(startProgress) as [number, number])
    const endPoint = projection(interpolateCoordinates(endProgress) as [number, number])

    if (!startPoint || !endPoint) {
      return 0
    }

    return (
      (Math.atan2(endPoint[1] - startPoint[1], endPoint[0] - startPoint[0]) * 180) / Math.PI -
      PLANE_EMOJI_BASE_HEADING_DEGREES
    )
  }

  function renderLabels(): void {
    const labelCountryIds = [...activeCountryIds]
    const labelIds: string[] = showAllCountryLabels || showUnansweredMarkers
      ? labelCountryIds
      : renderMode === 'route'
        ? [...new Set([...answeredIds, ...skippedIds])].filter((countryId) => activeCountryIds.has(countryId))
        : [...answeredIds]

    const visibleLabels: GlobeLabel[] = labelIds
      .map((countryId) => {
        const country = countryById.get(countryId)
        if (!country) {
          return null
        }

        const tone =
          skippedIds.has(countryId)
            ? 'skipped'
            : promptedCountryId === countryId
              ? 'prompt'
              : answeredIds.has(countryId)
                ? 'answered'
                : 'default'
        const answered = answeredIds.has(countryId)
        const skipped = skippedIds.has(countryId)
        const showMarker = !answered && !skipped && showUnansweredMarkers
        const topLabel =
          answered || skipped || preAnswerLabelMode === 'country'
            ? country.name
            : null
        const bottomLabel =
          answered || skipped || preAnswerLabelMode === 'capital'
            ? country.capitalDisplayName
            : null
        const flagAssetUrl =
          (answered || skipped || showPreAnswerFlags) && country.appearance.kind === 'flag'
            ? country.appearance.assetUrl
            : null

        const labelFeature = labelFeatureForCountry(countryId)
        // Allow 20px per character (text is at most 13px) plus flag shadows.
        // The plane still computes its full anchor even when a label is culled.
        const paddingX = Math.max(topLabel?.length ?? 0, bottomLabel?.length ?? 0, 1) * 10 + 40
        if (labelFeature && hemispherePath?.outsideViewport(labelFeature, paddingX, 64)) {
          // Preserve the original flag-loading lead time while its label is
          // off-screen, so entering the viewport never delays the image request.
          if (flagAssetUrl && !preloadedFlags.has(flagAssetUrl)) {
            const centroid = centroidForCountry(countryId)
            if (centroid && isVisible(centroid)) {
              const image = new Image()
              image.src = flagAssetUrl
              preloadedFlags.set(flagAssetUrl, image)
            }
          }
          return null
        }
        const projected = projectedLabelPosition(countryId)
        if (!projected) return null

        return {
          detail: bottomLabel,
          flagAssetUrl,
          id: country.id,
          markerText: showMarker ? '?' : null,
          name: topLabel,
          tone,
          x: projected[0],
          y: projected[1],
        }
      })
      .filter((label): label is GlobeLabel => Boolean(label))

    labelLayer
      .selectAll<SVGGElement, GlobeLabel>('g.globe__label')
      .data(visibleLabels, (label: GlobeLabel) => label.id)
      .join(
        (enter: Selection<EnterElement, GlobeLabel, SVGGElement, unknown>) =>
          enter.append('g')
            .attr('class', 'globe__label')
            .call((groupSelection) => {
              groupSelection
                .append('text')
                .attr('class', 'globe__label-name')
                .attr('text-anchor', 'middle')
              groupSelection
                .append('text')
                .attr('class', 'globe__label-detail')
                .attr('text-anchor', 'middle')
              groupSelection
                .append('image')
                .attr('class', 'globe__label-flag-image')
              groupSelection
                .append('text')
                .attr('class', 'globe__label-marker')
                .attr('text-anchor', 'middle')
            }),
        (update: Selection<SVGGElement, GlobeLabel, SVGGElement, unknown>) => update,
        (exit: Selection<SVGGElement, GlobeLabel, SVGGElement, unknown>) => exit.remove(),
      )
      .attr('transform', (label: GlobeLabel) => `translate(${label.x} ${label.y})`)
      .each(function (label: GlobeLabel) {
        // Moving a label does not change its text, flag, or styling. Rewriting
        // textContent every frame rebuilds SVG text layout in the browser.
        const painted = paintedLabels.get(this)
        if (
          painted &&
          painted.name === label.name &&
          painted.detail === label.detail &&
          painted.flagAssetUrl === label.flagAssetUrl &&
          painted.markerText === label.markerText &&
          painted.tone === label.tone
        ) {
          return
        }
        paintedLabels.set(this, label)
        const groupSelection = select(this)
        groupSelection
          .select<SVGTextElement>('.globe__label-name')
          .text(label.name ?? '')
          .attr('x', 0)
          .attr('y', MAP_LABEL_NAME_OFFSET_PX)
          .attr(
            'fill',
            label.tone === 'skipped'
              ? '#f0d8ff'
              : label.tone === 'prompt'
                ? '#ffe27a'
                : label.tone === 'answered'
                  ? '#fff4c8'
                  : 'rgba(219, 235, 248, 0.78)',
          )
          .attr(
            'stroke',
            label.tone === 'skipped'
              ? 'rgba(48, 16, 78, 0.96)'
              : label.tone === 'prompt'
                ? 'rgba(48, 34, 4, 0.98)'
                : label.tone === 'answered'
                  ? 'rgba(6, 15, 24, 0.92)'
                  : 'rgba(6, 15, 24, 0.78)',
          )
          .attr('font-size', label.tone === 'default' ? 11 : 13)
          .attr('font-weight', label.tone === 'default' ? 600 : 700)
          .attr('opacity', label.tone === 'default' ? 0.86 : 1)
          .attr('display', label.name ? null : 'none')
        groupSelection
          .select<SVGTextElement>('.globe__label-detail')
          .text(label.detail ?? '')
          .attr('x', 0)
          .attr('y', MAP_LABEL_DETAIL_OFFSET_PX)
          .attr('fill', label.tone === 'skipped' ? '#f0d8ff' : '#f6d67c')
          .attr('stroke', label.tone === 'skipped' ? 'rgba(48, 16, 78, 0.96)' : 'rgba(6, 15, 24, 0.92)')
          .attr('display', label.detail ? null : 'none')
        groupSelection
          .select<SVGImageElement>('.globe__label-flag-image')
          .attr('href', label.flagAssetUrl ?? '')
          .attr('x', -MAP_LABEL_FLAG_WIDTH_PX / 2)
          .attr('y', MAP_LABEL_FLAG_OFFSET_PX - MAP_LABEL_FLAG_HEIGHT_PX / 2)
          .attr('width', MAP_LABEL_FLAG_WIDTH_PX)
          .attr('height', MAP_LABEL_FLAG_HEIGHT_PX)
          .attr('preserveAspectRatio', 'xMidYMid meet')
          .attr('display', label.flagAssetUrl ? null : 'none')
        groupSelection
          .select<SVGTextElement>('.globe__label-marker')
          .text(label.markerText ?? '')
          .attr('x', 0)
          .attr('y', MAP_LABEL_FLAG_OFFSET_PX)
          .attr(
            'fill',
            label.tone === 'prompt'
              ? '#ffe27a'
              : 'rgba(231, 240, 248, 0.9)',
          )
          .attr('stroke', 'rgba(6, 15, 24, 0.92)')
          .attr('font-size', MAP_LABEL_MARKER_FONT_SIZE_PX)
          .attr('font-weight', 800)
          .attr('opacity', label.markerText ? 0.96 : 0)
          .attr('display', label.markerText ? null : 'none')
      })
  }

  function renderPlane(mostRecentAnsweredId: string | null): void {
    const activeSegment = flightSegments.find((segment) => segment.id === activeFlightSegmentId) ?? null
    const latestSegment = flightSegments.at(-1) ?? null
    const restingCountryId =
      renderMode === 'route'
        ? promptedCountryId ?? latestSegment?.toCountryId ?? mostRecentAnsweredId
        : mostRecentAnsweredId

    let anchorPoint: [number, number] | null = null
    let localOffsetY = 0
    let headingDegrees = latestSegment ? planeHeadingDegrees(latestSegment, 1) : 0

    if (activeSegment && planeCoordinates && isVisible(planeCoordinates)) {
      anchorPoint = correctedProjectedPlanePosition(activeSegment, activeFlightProgress)
      headingDegrees = planeHeadingDegrees(activeSegment, activeFlightProgress)
    } else if (restingCountryId) {
      anchorPoint = projectedPlaneLabelAnchor(restingCountryId)
    } else if (planeCoordinates && isVisible(planeCoordinates)) {
      const projected = projection(planeCoordinates)

      if (projected) {
        anchorPoint = [projected[0], projected[1]]
      }
    }

    if (!anchorPoint) {
      planeLayer.attr('display', 'none')
      return
    }

    planeLayer.attr('display', null)
    planeMarker
      .attr('transform', `translate(${anchorPoint[0]} ${anchorPoint[1]})`)
      .attr('data-moving', activeFlightSegmentId && activeFlightProgress < 1 ? 'true' : 'false')

    planeMarker
      .select<SVGCircleElement>('.globe__plane-halo')
      .attr('cx', 0)
      .attr('cy', localOffsetY)
      .attr('r', activeFlightSegmentId && activeFlightProgress < 1 ? 15 : 12)

    planeMarker
      .select<SVGTextElement>('.globe__plane-emoji')
      .attr('x', 0)
      .attr('y', localOffsetY)
      .attr('transform', `rotate(${headingDegrees} 0 ${localOffsetY})`)
  }

  function renderNow(): void {
    applyProjectionLayout()
    hemispherePath = currentProjectionKey === 'orthographic'
      ? createHemispherePath(projection, { width: cssWidth, height: cssHeight })
      : null
    projectedLabelPositions.clear()
    writeRenderState()
    const mostRecentAnsweredId = latestAnsweredId(answeredIds)
    const isFlightAnimating = Boolean(activeFlightSegmentId && activeFlightProgress < 1)
    const displayAtlas =
      outlineDetailMode === 'settled' && detailAtlas
        ? detailAtlas
        : atlas
    // The fill and coastline share exactly the same geometry and projection.
    const landPathData = projectedPathData(displayAtlas.landFeature)

    spherePath
      .attr('d', projectedPathData(currentSurfaceGeometry(), false))
      .attr('fill', SEA_FILL)
      .attr('stroke', 'rgba(180, 225, 255, 0.55)')
      .attr('stroke-width', 2.2)

    graticulePath
      .attr('d', projectedPathData(graticule, false))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(168, 212, 244, 0.2)')
      .attr('stroke-width', 0.7)

    countriesLayer
      .selectAll<SVGPathElement, GeoPermissibleObjects>('path')
      .data([displayAtlas.landFeature])
      .join('path')
      .attr('d', landPathData)
      .attr('fill', UNSOLVED_LAND_FILL)
      .attr('stroke', 'none')

    const promptedFeature =
      promptedCountryId && !answeredIds.has(promptedCountryId)
        ? (() => {
          const country = countryById.get(promptedCountryId)
          const countryFeature = displayFeatureForCountry(promptedCountryId, displayAtlas)
          const promptedCentroid = centroidForCountry(promptedCountryId)

          if (!country || !countryFeature) {
            return null
          }

          if (promptedCentroid && !isVisible(promptedCentroid)) {
            return null
          }

          return {
            appearanceFill: PROMPTED_COUNTRY_FILL,
            feature: countryFeature,
            id: promptedCountryId,
          }
        })()
        : null

    const visibleSolvedFeatures = [...answeredIds]
      .map((countryId) => {
        const country = countryById.get(countryId)
        const countryFeature = displayFeatureForCountry(countryId, displayAtlas)
        const solvedCentroid = centroidForCountry(countryId)

        if (!country || !countryFeature) {
          return null
        }

        if (solvedCentroid && !isVisible(solvedCentroid)) {
          return null
        }

        return {
          appearanceFill:
            renderMode === 'route'
              ? cheatedIds.has(countryId) || skippedIds.has(countryId)
                ? CHEATED_SOLVED_FILL
                : ROUTE_SOLVED_FILL
              : cheatedIds.has(countryId)
                ? CHEATED_SOLVED_FILL
                : countryId === mostRecentAnsweredId
                  ? LATEST_SOLVED_FILL
                  : SOLVED_COUNTRY_FILL,
          feature: countryFeature,
          id: countryId,
        }
      })
      .filter((entry): entry is { appearanceFill: string; feature: AtlasFeature; id: string } => Boolean(entry))

    const skippedFeatures =
      renderMode === 'route'
        ? [...skippedIds]
          .filter((countryId) => !answeredIds.has(countryId) && countryId !== promptedCountryId)
          .map((countryId) => {
            const countryFeature = displayFeatureForCountry(countryId, displayAtlas)
            const skippedCentroid = centroidForCountry(countryId)

            if (!countryFeature) {
              return null
            }

            if (skippedCentroid && !isVisible(skippedCentroid)) {
              return null
            }

            return {
              appearanceFill: ROUTE_SKIPPED_FILL,
              feature: countryFeature,
              id: countryId,
            }
          })
          .filter((entry): entry is { appearanceFill: string; feature: AtlasFeature; id: string } => Boolean(entry))
        : []

    solvedLayer
      .selectAll<SVGPathElement, { appearanceFill: string; feature: AtlasFeature; id: string }>('path')
      .data(
        promptedFeature
          ? [promptedFeature, ...skippedFeatures, ...visibleSolvedFeatures]
          : [...skippedFeatures, ...visibleSolvedFeatures],
        (entry) => entry.id,
      )
      .join('path')
      .attr('d', (entry) => projectedPathData(entry.feature))
      .each(function (entry) {
        const paintedFill = paintedCountryFills.get(this)
        if (paintedFill === entry.appearanceFill) return
        this.setAttribute('fill', entry.appearanceFill)
        if (paintedFill === undefined) {
          this.setAttribute('stroke', SOLVED_COUNTRY_OUTLINE_COLOR)
          this.setAttribute('stroke-width', String(SOLVED_COUNTRY_OUTLINE_WIDTH))
          this.setAttribute('stroke-linejoin', 'round')
          this.setAttribute('stroke-linecap', 'round')
        }
        paintedCountryFills.set(this, entry.appearanceFill)
      })

    renderFlights()

    coastlinePath
      .attr('d', landPathData)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(239, 247, 255, 0.76)')
      .attr('stroke-width', 1.3)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')

    borderPath
      .attr('d', projectedPathData(displayAtlas.borderMesh))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(227, 238, 247, 0.38)')
      .attr('stroke-width', 0.62)

    const fallbackOutlineData = [...fallbackFeatureByCountryId.entries()]
      .map(([countryId, fallbackFeature]) => {
        const country = countryById.get(countryId)
        const centroid = fallbackCentroidByCountryId.get(countryId) ?? centroidForCountry(countryId)

        if (centroid && !isVisible(centroid)) {
          return null
        }

        const answered = Boolean(country && answeredIds.has(countryId))
        return {
          answered,
          feature: fallbackFeature,
          id: countryId,
        }
      })
      .filter((entry): entry is { answered: boolean; feature: AtlasFeature; id: string } => Boolean(entry))

    fallbackOutlineLayer
      .selectAll<SVGPathElement, { answered: boolean; feature: AtlasFeature; id: string }>('path')
      .data(fallbackOutlineData, (entry) => entry.id)
      .join('path')
      .attr('d', (entry) => projectedPathData(entry.feature))
      .attr('fill', 'none')
      .attr('stroke', (entry) =>
        entry.answered
          ? 'rgba(174, 121, 255, 0.88)'
          : 'rgba(227, 238, 247, 0.7)',
      )
      .attr('stroke-width', (entry) => (entry.answered ? 0.85 : 0.95))

    if (isFlightAnimating) {
      hitTargetLayer.style('pointer-events', 'none')
    } else {
      const hitTargetData = countries
        .filter((country) => activeCountryIds.has(country.id))
        .map((country) => {
          const feature = interactionFeatureForCountry(country.id)
          const centroid = centroidForCountry(country.id)

          if (!feature) {
            return null
          }

          if (centroid && !isVisible(centroid)) {
            return null
          }

          return {
            feature,
            id: country.id,
          }
        })
        .filter((entry): entry is { feature: AtlasFeature; id: string } => Boolean(entry))

      hitTargetLayer
        .style('pointer-events', null)
        .selectAll<SVGPathElement, { feature: AtlasFeature; id: string }>('path')
        .data(hitTargetData, (entry) => entry.id)
        .join('path')
        .attr('class', 'globe__hit-target')
        .attr('data-country-id', (entry) => entry.id)
        .attr('d', (entry) => projectedPathData(entry.feature))
        .attr('fill', 'rgba(0, 0, 0, 0.001)')
        .attr('stroke', 'none')
        .on('click', function (event: MouseEvent, entry) {
          if (!event.shiftKey) {
            return
          }

          event.preventDefault()
          options?.onCountryCheat?.(entry.id)
        })
    }

    renderLabels()
    renderPlane(mostRecentAnsweredId)
  }

  function scheduleRender(): void {
    if (framePending) {
      return
    }

    framePending = true
    window.requestAnimationFrame(() => {
      framePending = false
      renderNow()
    })
  }

  function settleActiveFlight(): void {
    if (!activeFlightSegmentId) {
      return
    }

    const activeSegment = flightSegments.find((segment) => segment.id === activeFlightSegmentId)

    if (activeSegment) {
      planeCoordinates = activeSegment.toCoordinates
    }

    activeFlightSegmentId = null
    activeFlightProgress = 1
  }

  function cancelFlyAnimation(): void {
    const shouldCancelPerformance = flyFrame !== null || flightPerformanceAccumulator !== null

    if (flyFrame !== null) {
      window.cancelAnimationFrame(flyFrame)
      flyFrame = null
    }

    settleActiveFlight()
    endOutlineMotion('flight', 0)

    if (shouldCancelPerformance) {
      settleFlightPerformance('cancelled')
    }
  }

  function applyZoom(nextZoom: number): void {
    if (usesGlobeInteraction()) {
      currentZoom = clampZoom(nextZoom)
      scheduleRender()
      return
    }

    const viewportCenter =
      projection.invert?.([cssWidth / 2, cssHeight / 2]) ?? null
    currentZoom = clampZoom(nextZoom)

    if (viewportCenter) {
      setViewCenter(viewportCenter)
    }

    scheduleRender()
  }

  function clearTouchCheatState(): void {
    if (!touchCheatState) {
      return
    }

    window.clearTimeout(touchCheatState.timeoutId)
    touchCheatState = null
  }

  function startTouchCheat(countryId: string, touch: Touch): void {
    clearTouchCheatState()
    touchCheatState = {
      countryId,
      startX: touch.clientX,
      startY: touch.clientY,
      timeoutId: window.setTimeout(() => {
        const activeCountryId = touchCheatState?.countryId ?? null
        touchCheatState = null

        if (activeCountryId) {
          options?.onCountryCheat?.(activeCountryId)
        }
      }, MOBILE_CHEAT_HOLD_MS),
    }
  }

  function maintainTouchCheat(touch: Touch): void {
    if (!touchCheatState) {
      return
    }

    if (
      touch.clientX !== touchCheatState.startX ||
      touch.clientY !== touchCheatState.startY
    ) {
      clearTouchCheatState()
    }
  }

  function wheelZoomFactor(event: WheelEvent): number {
    const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1
    const clampedDelta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY * modeScale))
    return Math.exp(-clampedDelta * WHEEL_ZOOM_SENSITIVITY)
  }

  function snapToCountry(countryId: string): void {
    const centroid = centroidForCountry(countryId)

    if (!centroid) {
      return
    }

    currentZoom = zoomForCountry(countryId)
    setViewCenter(centroid)
  }

  function snapToRegion(countryIds: Iterable<string>): [number, number] | null {
    const view = regionView(countryIds)

    if (!view) {
      return null
    }

    currentZoom = view.zoom
    setViewCenter(view.center)
    return view.center
  }

  function applyStartView(): void {
    const centroid = centroidForCountry(FLIGHT_START_COUNTRY_ID)

    mapPanOffset = [0, 0]
    currentZoom = zoomForCountry(FLIGHT_START_COUNTRY_ID)

    if (centroid) {
      setViewCenter(centroid)
    }
  }

  function resetGlobeView(): void {
    cancelFlyAnimation()
    applyStartView()
    scheduleRender()
  }

  function animateFlight(
    segment: FlightSegment,
    onComplete?: (performance: GlobeFlightPerformance | null) => void,
  ): void {
    cancelFlyAnimation()

    if (!usesGlobeInteraction()) {
      const startCenter =
        projection.invert?.([cssWidth / 2, cssHeight / 2]) ?? segment.fromCoordinates
      const targetCenter = segment.toCoordinates
      const startZoom = currentZoom
      const targetZoom = zoomForCountry(segment.toCountryId)
      const startTime = performance.now()
      const interpolateCenter = geoInterpolate(startCenter, targetCenter)
      const interpolatePlaneCoordinates = geoInterpolate(
        segment.fromCoordinates,
        segment.toCoordinates,
      )

      pendingFlightCompletion = onComplete ?? null
      activeFlightSegmentId = segment.id
      activeFlightProgress = 0
      planeCoordinates = segment.fromCoordinates
      beginOutlineMotion('flight')
      startFlightPerformance(segment, startTime)

      const tick = (now: number) => {
        sampleFlightPerformance(now)
        const progress = Math.min(1, (now - startTime) / FLY_DURATION_MS)
        const eased = easeInOutCubic(progress)

        currentZoom = clampZoom(interpolateNumber(startZoom, targetZoom, eased))
        setViewCenter(interpolateCenter(eased) as [number, number])
        activeFlightProgress = eased
        planeCoordinates = interpolatePlaneCoordinates(eased) as [number, number]
        renderNow()

        if (progress < 1) {
          flyFrame = window.requestAnimationFrame(tick)
          return
        }

        planeCoordinates = segment.toCoordinates
        activeFlightProgress = 1
        activeFlightSegmentId = null
        flyFrame = null
        endOutlineMotion('flight')
        settleFlightPerformance('complete')
        renderNow()
      }

      flyFrame = window.requestAnimationFrame(tick)
      return
    }

    const [startLongitude, startLatitude, startGamma] = projection.rotate()
    const targetLongitude = shortestLongitudeTarget(startLongitude, -segment.toCoordinates[0])
    const targetLatitude = -clampProjectionLatitude(segment.toCoordinates[1])
    const startZoom = currentZoom
    const targetZoom = zoomForCountry(segment.toCountryId)
    const startTime = performance.now()
    const interpolatePlaneCoordinates = geoInterpolate(
      segment.fromCoordinates,
      segment.toCoordinates,
    )

    pendingFlightCompletion = onComplete ?? null
    activeFlightSegmentId = segment.id
    activeFlightProgress = 0
    planeCoordinates = segment.fromCoordinates
    beginOutlineMotion('flight')
    startFlightPerformance(segment, startTime)

    const tick = (now: number) => {
      sampleFlightPerformance(now)
      const progress = Math.min(1, (now - startTime) / FLY_DURATION_MS)
      const eased = easeInOutCubic(progress)

      projection.rotate([
        interpolateNumber(startLongitude, targetLongitude, eased),
        interpolateNumber(startLatitude, targetLatitude, eased),
        startGamma,
      ])
      currentZoom = clampZoom(interpolateNumber(startZoom, targetZoom, eased))
      activeFlightProgress = eased
      planeCoordinates = interpolatePlaneCoordinates(eased) as [number, number]
      renderNow()

      if (progress < 1) {
        flyFrame = window.requestAnimationFrame(tick)
        return
      }

      planeCoordinates = segment.toCoordinates
      activeFlightProgress = 1
      activeFlightSegmentId = null
      flyFrame = null
      endOutlineMotion('flight')
      settleFlightPerformance('complete')
      renderNow()
    }

    flyFrame = window.requestAnimationFrame(tick)
  }

  planeCoordinates = centroidForCountry(FLIGHT_START_COUNTRY_ID)
  applyStartView()
  desktopFlightTrailsMediaQuery.addEventListener('change', (event) => {
    showDesktopFlightTrails = event.matches
    scheduleRender()
  })

  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize()
  })
  resizeObserver.observe(container)
  syncCanvasSize()

  const dragBehavior = drag<SVGSVGElement, unknown>()
    .filter((event: MouseEvent | TouchEvent) => {
      if (event instanceof TouchEvent) {
        return event.touches.length <= 1
      }

      return !event.ctrlKey && event.button === 0
    })
    .on('start', () => {
      beginOutlineMotion('drag')
      cancelFlyAnimation()
    })
    .on('drag', (event: D3DragEvent<SVGSVGElement, unknown, unknown>) => {
      if (!usesGlobeInteraction()) {
        mapPanOffset = [mapPanOffset[0] + event.dx, mapPanOffset[1] + event.dy]
        scheduleRender()
        return
      }

      const [rotationLongitude, rotationLatitude, rotationGamma] = projection.rotate()
      const sensitivity = 72 / Math.max(currentScale(), 1)
      const nextLatitude = -clampProjectionLatitude(-rotationLatitude + event.dy * sensitivity)

      projection.rotate([
        rotationLongitude + event.dx * sensitivity,
        nextLatitude,
        rotationGamma,
      ])
      scheduleRender()
    })
    .on('end', () => {
      endOutlineMotion('drag')
    })

  mapSvg.call(dragBehavior)

  const mapSvgNode = mapSvg.node()

  if (!mapSvgNode) {
    throw new Error('Map SVG could not be created')
  }

  const countryIdFromTouchTarget = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) {
      return null
    }

    const hitTarget = target.closest('.globe__hit-target[data-country-id]')

    if (!(hitTarget instanceof SVGPathElement)) {
      return null
    }

    return hitTarget.dataset.countryId ?? null
  }

  mapSvgNode.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault()
      pulseWheelOutlineMotion()
      cancelFlyAnimation()
      applyZoom(currentZoom * wheelZoomFactor(event))
    },
    { passive: false },
  )

  mapSvgNode.addEventListener(
    'touchstart',
    (event: TouchEvent) => {
      const targetCountryId = countryIdFromTouchTarget(event.target)

      if (event.touches.length === 1 && targetCountryId) {
        startTouchCheat(targetCountryId, event.touches[0])
        pinchZoomState = null
        return
      }

      clearTouchCheatState()

      if (event.touches.length !== 2) {
        pinchZoomState = null
        return
      }

      const [firstTouch, secondTouch] = [event.touches[0], event.touches[1]]
      const distance = distanceBetweenTouches(firstTouch, secondTouch)

      if (distance < MIN_PINCH_DISTANCE_PX) {
        pinchZoomState = null
        return
      }

      event.preventDefault()
      beginOutlineMotion('pinch')
      cancelFlyAnimation()
      pinchZoomState = {
        distance,
        zoom: currentZoom,
      }
    },
    { capture: true, passive: false },
  )

  mapSvgNode.addEventListener(
    'touchmove',
    (event: TouchEvent) => {
      if (event.touches.length === 1) {
        maintainTouchCheat(event.touches[0])
        pinchZoomState = null
        return
      }

      clearTouchCheatState()

      if (event.touches.length !== 2) {
        return
      }

      const [firstTouch, secondTouch] = [event.touches[0], event.touches[1]]
      const distance = distanceBetweenTouches(firstTouch, secondTouch)

      if (distance < MIN_PINCH_DISTANCE_PX) {
        return
      }

      if (!pinchZoomState) {
        pinchZoomState = {
          distance,
          zoom: currentZoom,
        }
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      beginOutlineMotion('pinch')
      applyZoom(pinchZoomState.zoom * (distance / pinchZoomState.distance))
    },
    { capture: true, passive: false },
  )

  const clearPinchZoomState = (): void => {
    endOutlineMotion('pinch')
    pinchZoomState = null
  }

  mapSvgNode.addEventListener(
    'touchend',
    () => {
      clearPinchZoomState()
      clearTouchCheatState()
    },
    { capture: true },
  )
  mapSvgNode.addEventListener(
    'touchcancel',
    () => {
      clearPinchZoomState()
      clearTouchCheatState()
    },
    { capture: true },
  )

  return {
    benchmarkFlight(fromCountryId, toCountryId) {
      const segment = directFlightSegment(fromCountryId, toCountryId)

      cancelFlyAnimation()

      if (!segment) {
        flightSegments = []
        planeCoordinates =
          centroidForCountry(fromCountryId) ?? centroidForCountry(FLIGHT_START_COUNTRY_ID)
        scheduleRender()
        return Promise.resolve(null)
      }

      flightSegments = [segment]
      planeCoordinates = segment.fromCoordinates
      scheduleRender()

      return new Promise((resolve) => {
        animateFlight(segment, resolve)
      })
    },
    describeFlightPath(answerOrder) {
      return buildFlightSegments(answerOrder).status
    },
    setAnswered(nextAnsweredIds: Set<string>, options) {
      answeredIds = new Set(nextAnsweredIds)
      activeCountryIds = new Set(options?.activeCountryIds ?? countries.map((country) => country.id))
      cheatedIds = new Set(options?.cheatedIds ?? [])
      skippedIds = new Set(options?.skippedIds ?? [])
      answerKind = options?.answerKind ?? 'country'
      renderMode = options?.layoutMode ?? 'free'
      preAnswerLabelMode = options?.preAnswerLabelMode ?? 'none'
      showAllCountryLabels = options?.showAllCountryLabels ?? false
      showPreAnswerFlags = options?.showPreAnswerFlags ?? false
      showUnansweredMarkers = options?.showUnansweredMarkers ?? false

      if (options?.focusLatest) {
        const mostRecentAnsweredId = latestAnsweredId(answeredIds)

        if (mostRecentAnsweredId) {
          cancelFlyAnimation()
          snapToCountry(mostRecentAnsweredId)
        }
      }

      scheduleRender()
    },
    setPromptedCountry(countryId, options) {
      promptedCountryId = countryId

      if (options?.focus && countryId) {
        cancelFlyAnimation()
        snapToCountry(countryId)
      }

      scheduleRender()
    },
    syncFlightPath(answerOrder: string[], options) {
      const previousLastSegmentId = flightSegments.at(-1)?.id ?? null
      const nextFlightState = buildFlightSegments(answerOrder)
      const lastSegment = nextFlightState.segments.at(-1) ?? null

      cancelFlyAnimation()
      flightSegments = nextFlightState.segments
      planeCoordinates =
        nextFlightState.planePosition ?? centroidForCountry(FLIGHT_START_COUNTRY_ID)

      if (!lastSegment) {
        scheduleRender()
        return null
      }

      if (options?.animate && lastSegment.id !== previousLastSegmentId) {
        animateFlight(lastSegment)
        return nextFlightState.status
      }

      snapToCountry(lastSegment.toCountryId)
      scheduleRender()
      return nextFlightState.status
    },
    resetView(options) {
      flightSegments = []

      const regionCenter = options?.countryIds ? snapToRegion(options.countryIds) : null

      if (regionCenter) {
        cancelFlyAnimation()
        planeCoordinates = regionCenter
        scheduleRender()
        return
      }

      planeCoordinates = centroidForCountry(FLIGHT_START_COUNTRY_ID)
      resetGlobeView()
    },
    setProjection(projectionKey) {
      if (projectionKey === currentProjectionKey) {
        return
      }

      cancelFlyAnimation()
      currentProjectionKey = projectionKey
      projection = createProjection(
        projectionKey,
        projectionDefinition(projectionKey).defaultRotation,
      )
      measurementPath = geoPath(projection)
      mapPanOffset = [0, 0]
      applyProjectionLayout()

      const focusCountryId = promptedCountryId ?? latestAnsweredId(answeredIds)

      if (focusCountryId) {
        snapToCountry(focusCountryId)
      } else {
        applyStartView()
      }

      applyProjectionLayout()
      scheduleRender()
    },
    zoomBy(factor: number) {
      cancelFlyAnimation()
      applyZoom(currentZoom * factor)
    },
  }
}
