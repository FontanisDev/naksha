/**
 * Naksha — Constants
 * Central place for design tokens, network colors, storage keys,
 * layer definitions, and other immutable configuration.
 */

import type { MapLayerConfig, MapLayerKey, NodeTag } from './types';
import { DEFAULT_THEME_ID } from './themes';

/** localStorage keys — all prefixed `naksha_` */
export const STORAGE_KEYS = {
  filesystem: 'naksha_fs',
  carespace: 'naksha_care',
  history: 'naksha_history',
  settings: 'naksha_settings',
  aliases: 'naksha_aliases',
  views: 'naksha_views',
  focusDesk: 'naksha_focus_desk',
  undo: 'naksha_undo',
  /* Task 82 — the redo stack persists beside the slot: a reload no
   * longer forfeits the future. Same Storage, same snapshots, same
   * trust the undo entry always carried. */
  redo: 'naksha_redo',
  workspace: 'naksha_workspace',
  pins: 'naksha_pins',
} as const;

/** Hard cap on CareSpace networks (the 3-river rule). */
export const MAX_NETWORKS = 3;

/** Network colors — orchid, rose, aqua */
export const NETWORK_COLORS = ['#b78cff', '#ff9bb5', '#7fe7d6'] as const;

/** Default network names (first one is auto-created). */
export const DEFAULT_NETWORK_NAME = 'Main Purpose';

/** Map layers — multiple free providers, HOT is default (no API key, no 403s). */
export const MAP_LAYERS: Record<MapLayerKey, MapLayerConfig> = {
  standard: {
    name: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    subdomains: ['a', 'b', 'c'],
  },
  hot: {
    name: 'Humanitarian',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://hot.openstreetmap.org/">HOT</a>',
    maxZoom: 19,
    subdomains: ['a', 'b'],
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 19,
  },
  topographic: {
    name: 'Topographic',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17,
    subdomains: ['a', 'b', 'c'],
  },
  dark: {
    name: 'Dark',
    // ESRI World Dark — free, no API key required.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 16,
  },
};

/** Default basemap: ESRI dark gray — fits the warm-dark glass theme, easier
 *  on the eyes in dark rooms, and cheaper to composite on CPU-only devices
 *  (low-chroma tiles = less paint work per frame). */
export const DEFAULT_MAP_LAYER: MapLayerKey = 'dark';

/** Default map center — Tehran (matches the original). */
export const DEFAULT_MAP_CENTER: [number, number] = [35.7058, 51.4213];
export const DEFAULT_MAP_ZOOM = 12;

/** Tag colors — small palette for node color tags. */
export const TAG_COLORS: Record<string, string> = {
  red: '#c05b4d',
  orange: '#d4843e',
  yellow: '#d4a017',
  green: '#7dba6a',
  blue: '#7a9ec2',
  purple: '#9b7ec8',
  none: 'transparent',
};

/** Task 79 — the palette as one ORDERED list, the single source every
 *  tag surface speaks (fix picker's suggestions + validation, the `tag`
 *  CLI's receipts, the details panel's swatches). Kept adjacent to
 *  TAG_COLORS so the two can't drift — 'none' is the absence, not a
 *  color, and lives only in the map above. */
export const TAG_PALETTE: NodeTag[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/** Particle flow animation — sleeps after this many ms of inactivity. */
export const PARTICLE_SLEEP_MS = 2500;
/** How long a particle takes to traverse a link (ms). */
export const PARTICLE_TRAVEL_MS = 3200;
/** Number of particles per visible link (kept low for perf). */
export const PARTICLES_PER_LINK = 1;

/** Terminal line cap (we trim oldest beyond this to keep DOM light). */
export const MAX_TERM_LINES = 500;

/** Command history cap (persisted). */
export const MAX_HISTORY = 200;

/** Default settings. Task 112 — no `theme` key: the dead warm-dark |
 * warm-light field is retired (nothing ever read it; themeId is the
 * single theme truth), and init()'s migration strips it from old saves. */
export const DEFAULT_SETTINGS: import('./types').NakshaSettings = {
  themeId: DEFAULT_THEME_ID,
  terminalFont: 'mono',
  mapDefaultLayer: DEFAULT_MAP_LAYER,
  caresolution: 38, // terminal width %
  mapsplit: 50, // map width %
  particlesEnabled: true,
  perfMode: undefined, // auto-detect on init
  showNodesOnMap: false, // opt-in via `mapnodes` / `pinnode` (Task 34)
  /* Phase 3 — stays undefined until the user (or an explicit connect /
   * disconnect action) picks a world: the resolver then reports the
   * honest 'default' reason instead of a 'chosen' nobody made. */
  storageContext: undefined,
  /* Phase 8 — direction auto-follows the user's own writing (RTL
   * detection over CareSpace content); Persian chrome labels are an
   * explicit opt-in via `settings lang fa`. */
  direction: 'auto',
  uiLang: 'en',
};

/** Wikipedia API endpoints. */
export const WIKI_API = {
  summary: (title: string, lang = 'en') =>
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  search: (q: string, lang = 'en') =>
    `https://${lang}.wikipedia.org/w/rest_v1/search/page?q=${encodeURIComponent(q)}&limit=1`,
};

/** Open-Meteo endpoints (free, no key). */
export const WEATHER_API = {
  geocode: (place: string) =>
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`,
  forecast: (lat: number, lng: number) =>
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`,
};

/** Nominatim (geocoding). */
export const NOMINATIM = {
  search: (q: string) =>
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1`,
  reverse: (lat: number, lng: number) =>
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2`,
};

/** OSRM routing. */
export const OSRM = {
  route: (fromLat: number, fromLng: number, toLat: number, toLng: number) =>
    `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`,
};

/** Overpass (POI search). Task 71 — the mirror is not a spare: the
 * primary's DNS has been flapping all week (success windows come and
 * go within minutes), so the fetch-level fallback below asks the
 * mirror when the primary never ANSWERS at all (fetch throws) — the
 * 504 retry in map-engine covers gateway timeouts, this covers
 * dead air. */
export const OVERPASS = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter';

/** Open-Meteo Elevation API (free, no key). */
export const ELEVATION_API = {
  elevation: (lat: number, lng: number) =>
    `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(6)}&longitude=${lng.toFixed(6)}`,
};

/** POI category presets for the `search` command. */
export const POI_CATEGORIES: Record<string, string> = {
  food: 'amenity~restaurant|cafe|fast_food|bar|pub',
  fuel: 'amenity~fuel',
  health: 'amenity~hospital|clinic|pharmacy|doctors',
  money: 'amenity~bank|atm',
  shop: 'shop~supermarket|convenience|bakery',
  transport: 'amenity~bus_station|parking|bicycle_parking',
  tourism: 'tourism~hotel|museum|attraction|viewpoint',
  nature: 'leisure~park|nature_reserve|garden',
};
