/**
 * Naksha — Map Engine
 *
 * A thin wrapper around Leaflet. The MapPane component creates the
 * Leaflet instance and registers it here via `MapEngine.attach(map)`.
 * Commands then call `MapEngine.flyTo(...)` etc. without caring
 * about React lifecycle.
 *
 * Performance:
 *  - mousemove is throttled to 100ms (status bar coord updates)
 *  - we invalidateSize() on container resize (debounced in component)
 *  - we never hold big references in closures
 */

import L from 'leaflet';
import type { MapLayerKey, MapPin, MapView } from './types';
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  DEFAULT_MAP_LAYER,
  MAP_LAYERS,
  NOMINATIM,
  OSRM,
  OVERPASS,
  OVERPASS_MIRROR,
} from './constants';
import { formatDistance, formatDuration, haversineKm } from './utils';
import { Storage } from './storage';
import { STORAGE_KEYS } from './constants';

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

/* Task 72 — sticky Overpass endpoint: whichever mirror answered last is
 * where the next ask starts (flips on evidence — a fetch throw — never
 * on assumption). Session-scoped on purpose: a flap that outlives the
 * page is a different flap. */
let activeOverpass = OVERPASS;

class MapEngineImpl {
  map: L.Map | null = null;
  currentLayer: MapLayerKey = DEFAULT_MAP_LAYER;
  private currentLayerObj: L.TileLayer | null = null;
  private routeGroup: L.LayerGroup | null = null;
  private measureLayer: L.LayerGroup | null = null;
  markers: MapPin[] = [];
  /** CareSpace node markers (Task 34) — keyed by nodeId so syncs are DIFFED:
   *  unchanged markers are never touched (no DOM churn on careRevision bumps).
   *  Empty when the layer is off → zero rendering cost. */
  private nodeMarkers: Map<string, L.Marker> = new Map();
  private nodeMarkerClickHandler: ((nodeId: string) => void) | null = null;
  /** Per-key tint of the rendered marker icon (Task 37) — lets the diff
   *  path re-icon ONLY when a marker's provenance color actually changes
   *  (e.g. a workspace sketch bridge set the node's tag), instead of on
   *  every careRevision bump. */
  private nodeMarkerColors: Map<string, string | undefined> = new Map();
  /** saved views keyed by name */
  savedViews: Map<string, MapView> = new Map();
  /** center crosshair marker */
  private crosshair: L.Marker | null = null;
  private mouseMoveLast = 0;

  attach(container: HTMLElement): L.Map {
    if (this.map) {
      // Already attached. If to a different container, detach first.
      this.map.remove();
      this.map = null;
    }
    const map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      preferCanvas: true,
      /* CPU-only tuning: tile fade/zoom animations composite every tile
       * layer each frame. Skipping them costs nothing but smoothness of a
       * 200ms transition, and removes the #1 map-side repaint source. */
      fadeAnimation: false,
      markerZoomAnimation: false,
      zoomAnimation: false,
    }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    // Crosshair center marker (a transparent pin that stays centered)
    const crosshairIcon = L.divIcon({
      className: '',
      html: `<div style="width:0;height:0;"></div>`,
      iconSize: [0, 0],
    });
    this.crosshair = L.marker(map.getCenter(), {
      icon: crosshairIcon,
      interactive: false,
      keyboard: false,
    }).addTo(map);
    // Keep crosshair centered on move/zoom
    map.on('move zoom', () => {
      if (this.crosshair) this.crosshair.setLatLng(map.getCenter());
    });

    this.map = map;
    this.setLayer(DEFAULT_MAP_LAYER);
    this.restorePins();
    this.restoreViews();

    // Throttled mousemove coord reporting
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const now = Date.now();
      if (now - this.mouseMoveLast < 100) return;
      this.mouseMoveLast = now;
      const { lat, lng } = e.latlng;
      const latStr = `${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'N' : 'S'}`;
      const lngStr = `${Math.abs(lng).toFixed(3)}${lng >= 0 ? 'E' : 'W'}`;
      // Notify via custom event (the component subscribes)
      container.dispatchEvent(
        new CustomEvent('naksha:mapcoord', { detail: `${latStr} ${lngStr}` }),
      );
    });

    map.on('zoomend', () => {
      container.dispatchEvent(
        new CustomEvent('naksha:mapzoom', { detail: map.getZoom() }),
      );
      /* Thought-marker density fade (Task 35) — one style write per
         marker, only on zoom settle. */
      this.applyNodeMarkerZoomFade();
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      container.dispatchEvent(
        new CustomEvent('naksha:mapcenter', {
          detail: { lat: c.lat, lng: c.lng, zoom: map.getZoom() },
        }),
      );
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      /* Task 38: the click now carries the LatLng — the pane's
       * place-by-click mode (card "✛ Place by click") needs WHERE the
       * user clicked, not just that a click happened. Existing listeners
       * that ignore `detail` are unaffected. */
      container.dispatchEvent(
        new CustomEvent('naksha:mapclick', {
          detail: { lat: e.latlng.lat, lng: e.latlng.lng },
        }),
      );
    });

    return map;
  }

  detach(): void {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.currentLayerObj = null;
    this.routeGroup = null;
    this.measureLayer = null;
    this.markers = [];
    this.nodeMarkers.clear();
  }

  invalidateSize(): void {
    if (this.map) this.map.invalidateSize();
  }

  setLayer(layerName: MapLayerKey): { success: boolean; error?: string } {
    if (!this.map) return { success: false, error: 'Map not ready' };
    const cfg = MAP_LAYERS[layerName];
    if (!cfg) return { success: false, error: `Unknown layer: ${layerName}` };
    if (this.currentLayerObj) this.map.removeLayer(this.currentLayerObj);
    /* Task 41 — CPU-only tile budget. On the low tier (html[data-perf],
     * set before the map mounts and re-read per layer switch) the tile
     * layer keeps a smaller off-screen buffer (Leaflet default 2 rows in
     * each direction → 1) and skips the intermediate-zoom tile requests
     * (updateWhenZooming) that fire a burst of extra decodes during every
     * pinch/zoom even with zoomAnimation off. Invisible on screen, real
     * savings in tile decode + composite on 4GB CPU boxes. */
    const lowTier = document.documentElement.getAttribute('data-perf') === 'low';
    this.currentLayerObj = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: cfg.maxZoom,
      subdomains: cfg.subdomains ?? ['a', 'b', 'c'],
      ...(lowTier ? { keepBuffer: 1, updateWhenZooming: false } : {}),
    }).addTo(this.map);
    this.currentLayer = layerName;
    return { success: true };
  }

  setZoom(zoom: number): void {
    if (this.map) this.map.setZoom(zoom);
  }

  getCenter(): { lat: number; lng: number } {
    if (!this.map) return { lat: DEFAULT_MAP_CENTER[0], lng: DEFAULT_MAP_CENTER[1] };
    const c = this.map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  getZoom(): number {
    return this.map ? this.map.getZoom() : DEFAULT_MAP_ZOOM;
  }

  flyToCoords(lat: number, lng: number, zoom?: number, duration = 2): void {
    if (!this.map) return;
    this.map.flyTo([lat, lng], zoom ?? Math.max(this.map.getZoom(), 13), {
      duration,
      easeLinearity: 0.25,
    });
  }

  async geocode(query: string): Promise<GeocodeResult | null> {
    const res = await fetch(NOMINATIM.search(query));
    if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
    const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!data || data.length === 0) return null;
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      displayName: data[0].display_name,
    };
  }

  async flyTo(query: string): Promise<{ success: boolean; result?: GeocodeResult; error?: string }> {
    if (!query) return { success: false, error: 'Usage: goto <place>' };
    try {
      const result = await this.geocode(query);
      if (!result) return { success: false, error: 'Location not found' };
      this.flyToCoords(result.lat, result.lng);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async reverseGeocode(lat?: number, lng?: number): Promise<{ success: boolean; displayName?: string; error?: string }> {
    if (!this.map) return { success: false, error: 'Map not ready' };
    const c = lat != null && lng != null ? { lat, lng } : this.getCenter();
    try {
      const res = await fetch(NOMINATIM.reverse(c.lat, c.lng));
      if (!res.ok) throw new Error(`Reverse geocoding failed: ${res.status}`);
      const data = (await res.json()) as { display_name?: string };
      if (data && data.display_name) return { success: true, displayName: data.display_name };
      return { success: false, error: 'No location data for this point' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async route(fromQuery: string, toQuery: string): Promise<{
    success: boolean;
    distanceKm?: number;
    durationSec?: number;
    from?: GeocodeResult;
    to?: GeocodeResult;
    error?: string;
  }> {
    if (!fromQuery || !toQuery) return { success: false, error: 'Usage: route <from> to <to>' };
    try {
      const [from, to] = await Promise.all([this.geocode(fromQuery), this.geocode(toQuery)]);
      if (!from) return { success: false, error: `Cannot find: ${fromQuery}` };
      if (!to) return { success: false, error: `Cannot find: ${toQuery}` };
      const res = await fetch(OSRM.route(from.lat, from.lng, to.lat, to.lng));
      if (!res.ok) throw new Error(`Routing failed: ${res.status}`);
      const data = (await res.json()) as { routes?: Array<{ geometry: unknown; distance: number; duration: number }> };
      if (!data.routes || data.routes.length === 0) return { success: false, error: 'No route found' };
      const r = data.routes[0];
      if (this.routeGroup) this.map!.removeLayer(this.routeGroup);
      this.routeGroup = L.layerGroup().addTo(this.map!);
      L.geoJSON(r.geometry as GeoJSON.Geometry, {
        style: {
          color: '#d4a017',
          weight: 3,
          opacity: 0.8,
          dashArray: '8, 6',
        },
      }).addTo(this.routeGroup);
      L.circleMarker([from.lat, from.lng], {
        radius: 6, color: '#d4a017', fillColor: '#1a1611', fillOpacity: 1, weight: 2,
      }).addTo(this.routeGroup);
      L.circleMarker([to.lat, to.lng], {
        radius: 6, color: '#d4a017', fillColor: '#d4a017', fillOpacity: 1, weight: 2,
      }).addTo(this.routeGroup);
      this.map!.flyToBounds((this.routeGroup as L.FeatureGroup).getBounds(), { padding: [50, 50], duration: 2 });
      return {
        success: true,
        distanceKm: r.distance / 1000,
        durationSec: r.duration,
        from,
        to,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async measure(fromQuery: string, toQuery: string): Promise<{
    success: boolean;
    km?: number;
    from?: GeocodeResult;
    to?: GeocodeResult;
    error?: string;
  }> {
    if (!fromQuery || !toQuery) return { success: false, error: 'Usage: measure <A> to <B>' };
    try {
      const [from, to] = await Promise.all([this.geocode(fromQuery), this.geocode(toQuery)]);
      if (!from) return { success: false, error: `Cannot find: ${fromQuery}` };
      if (!to) return { success: false, error: `Cannot find: ${toQuery}` };
      const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
      // Draw a straight line on the map
      if (this.measureLayer) this.map!.removeLayer(this.measureLayer);
      /* Task 87 — featureGroup, not layerGroup: the flyToBounds below
       * calls getBounds(), which LayerGroup does not carry (the old cast
       * to FeatureGroup compiled but crashed at runtime — QA caught it
       * live on the first `measure` run). Same fix in loadMeasurement. */
      this.measureLayer = L.featureGroup().addTo(this.map!);
      L.polyline(
        [
          [from.lat, from.lng],
          [to.lat, to.lng],
        ],
        { color: '#7a9ec2', weight: 2, opacity: 0.7, dashArray: '4, 6' },
      ).addTo(this.measureLayer);
      L.circleMarker([from.lat, from.lng], { radius: 5, color: '#7a9ec2', fillColor: '#7a9ec2', fillOpacity: 1 }).addTo(this.measureLayer);
      L.circleMarker([to.lat, to.lng], { radius: 5, color: '#7a9ec2', fillColor: '#7a9ec2', fillOpacity: 1 }).addTo(this.measureLayer);
      this.map!.flyToBounds((this.measureLayer as L.FeatureGroup).getBounds(), { padding: [60, 60], duration: 1.5 });
      return { success: true, km, from, to };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /* ─── Saved measurements ─── */
  savedMeasurements: Map<string, { name: string; fromLabel: string; toLabel: string; km: number; fromLat: number; fromLng: number; toLat: number; toLng: number; createdAt: number }> = new Map();

  saveMeasurement(name: string, fromLabel: string, toLabel: string, km: number, fromLat: number, fromLng: number, toLat: number, toLng: number): void {
    this.savedMeasurements.set(name, { name, fromLabel, toLabel, km, fromLat, fromLng, toLat, toLng, createdAt: Date.now() });
  }

  listMeasurements(): Array<{ name: string; fromLabel: string; toLabel: string; km: number }> {
    return Array.from(this.savedMeasurements.values()).map((m) => ({
      name: m.name,
      fromLabel: m.fromLabel,
      toLabel: m.toLabel,
      km: m.km,
    }));
  }

  loadMeasurement(name: string): { success: boolean; km?: number; error?: string } {
    const m = this.savedMeasurements.get(name);
    if (!m) return { success: false, error: `No measurement named "${name}"` };
    // Redraw the measurement line
    if (this.measureLayer) this.map!.removeLayer(this.measureLayer);
    /* Task 87 — featureGroup for getBounds() (see the measure verb). */
    this.measureLayer = L.featureGroup().addTo(this.map!);
    L.polyline(
      [[m.fromLat, m.fromLng], [m.toLat, m.toLng]],
      { color: '#7a9ec2', weight: 2, opacity: 0.7, dashArray: '4, 6' },
    ).addTo(this.measureLayer);
    L.circleMarker([m.fromLat, m.fromLng], { radius: 5, color: '#7a9ec2', fillColor: '#7a9ec2', fillOpacity: 1 }).addTo(this.measureLayer);
    L.circleMarker([m.toLat, m.toLng], { radius: 5, color: '#7a9ec2', fillColor: '#7a9ec2', fillOpacity: 1 }).addTo(this.measureLayer);
    this.map!.flyToBounds((this.measureLayer as L.FeatureGroup).getBounds(), { padding: [60, 60], duration: 1.5 });
    return { success: true, km: m.km };
  }

  removeMeasurement(name: string): { success: boolean; error?: string } {
    if (!this.savedMeasurements.has(name)) return { success: false, error: `No measurement named "${name}"` };
    this.savedMeasurements.delete(name);
    return { success: true };
  }

  async searchNearby(term: string, place?: string): Promise<{
    success: boolean;
    count?: number;
    error?: string;
    /* Task 43 — result rows for the terminal's click-to-fly list. The
     * pins are still created (same behavior as before); this parallel
     * array lets the command print aligned rows that fly on click. */
    results?: Array<{ num: number; label: string; lat: number; lng: number }>;
    /* Task 70 — how many results matched an existing pin (label + spot)
     * and REUSED its number instead of seeding a twin marker. */
    reused?: number;
    /* Task 71 — true when the primary was dead air and the MIRROR
     * answered; the receipt names the detour. */
    mirrored?: boolean;
  }> {
    // Determine center
    let lat: number;
    let lng: number;
    if (place && place !== 'here') {
      try {
        const g = await this.geocode(place);
        if (!g) return { success: false, error: `Cannot find: ${place}` };
        lat = g.lat; lng = g.lng;
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    } else {
      const c = this.getCenter();
      lat = c.lat; lng = c.lng;
    }
    const radius = 2000;
    // Build the Overpass query. If the term contains '~' it's an expanded
    // category preset (e.g. "amenity~restaurant|cafe"). Otherwise treat it
    // as a plain text search across amenity/shop/tourism.
    let query: string;
    /* Task 68 — the case-insensitive regex flag is `,i` in Overpass QL —
     * UNQUOTED. `,"i"` parses as a second string argument and the server
     * answers 400. Latent since the query was written: every earlier
     * test died in DNS resolution ("Failed to fetch") before the request
     * ever reached the server — the first round the network opened, the
     * syntax bug surfaced (search cafe → "Overpass error: 400"). */
    if (term.includes('~')) {
      // Parse "key~val1|val2|val3" format
      const parts = term.split('~');
      const key = parts[0];
      const values = parts[1] || '';
      query = `[out:json][timeout:25];(
        node["${key}"~"${values}",i](around:${radius},${lat},${lng});
        way["${key}"~"${values}",i](around:${radius},${lat},${lng});
      );out center 20;`;
    } else {
      query = `[out:json][timeout:25];(
        node["amenity"~"${term}",i](around:${radius},${lat},${lng});
        node["shop"~"${term}",i](around:${radius},${lat},${lng});
        node["tourism"~"${term}",i](around:${radius},${lat},${lng});
      );out 20;`;
    }
    try {
      /* Task 71 — the ask is ENDPOINT-AWARE: the primary's DNS has been
       * flapping all week ("Failed to fetch" windows lasting minutes),
       * and the 504 retry only covers gateway timeouts. When the primary
       * never answers at all (fetch throws — DNS, connection refused),
       * ONE ask goes to the mirror before giving up. HTTP errors do NOT
       * trigger the mirror: a 400/429/504 is the server speaking, and
       * the mirror would just answer the same thing (504s already have
       * their own retry). The receipt names the detour.
       * Task 72 — the endpoint is STICKY: whichever endpoint ANSWERED
       * last is where the next ask starts. Flap windows last minutes,
       * so a mirror that just worked probably still works — and a
       * primary that just threw probably still throws. Flips on
       * evidence only (a throw), never on assumption; session-scoped,
       * because persistence would outlive the flap. */
      const askAt = (endpoint: string) =>
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
      let used = activeOverpass;
      let res: Response;
      try {
        res = await askAt(used);
      } catch (primaryErr) {
        const other = used === OVERPASS ? OVERPASS_MIRROR : OVERPASS;
        try {
          res = await askAt(other);
          used = other; // reachable — the sticky hand flips here
        } catch {
          /* Both endpoints dead air — report the FIRST endpoint's
           * failure; the second's error would be the same DNS story
           * twice. */
          throw primaryErr;
        }
      }
      activeOverpass = used;
      /* Task 69 — one honest retry on 504: the public instance sheds
       * load with gateway timeouts; a single 1.5s-backed re-ask recovers
       * the flaky window. Exactly ONE retry — never a loop — and the
       * error names the retry so the receipt stays honest. */
      let retried = false;
      if (!res.ok && res.status === 504) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await askAt(used);
        retried = true;
      }
      const mirrored = used === OVERPASS_MIRROR;
      if (!res.ok) return { success: false, error: `Overpass error: ${res.status}${retried ? ' (retried once)' : ''}${mirrored ? ' (via mirror)' : ''}` };
      const data = (await res.json()) as { elements?: Array<{ id: number; lat: number; lon: number; tags?: Record<string, string> }> };
      const els = data.elements ?? [];
      if (els.length === 0) return { success: false, error: `No results for "${term}" nearby` };
      const results: Array<{ num: number; label: string; lat: number; lng: number }> = [];
      /* Task 70 — repeated searches used to seed twin pins: every run
       * pushed all 20 elements again (three runs = 60 markers, 40 of
       * them duplicates). A result whose label matches an existing pin
       * AND sits within 30 m of it (same OSM node round-trips exactly;
       * 30 m absorbs formatting noise but never merges two distinct
       * venues) REUSES that pin number — no new marker, and nodefrom's
       * planted-guard stays the single source of truth for thoughts. */
      let reused = 0;
      els.forEach((el, i) => {
        const label = el.tags?.name || el.tags?.amenity || el.tags?.shop || `${term} ${i + 1}`;
        const existing = this.markers.find(
          (m) =>
            m.label.toLowerCase() === label.toLowerCase() &&
            Math.hypot((m.lat - el.lat) * 111, (m.lng - el.lon) * 111 * Math.cos((el.lat * Math.PI) / 180)) <= 0.03,
        );
        if (existing) {
          reused++;
          results.push({ num: existing.number, label: existing.label, lat: existing.lat, lng: existing.lng });
          return;
        }
        const num = this.markers.length + 1;
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:4px;background:#d4a017;border-radius:50%;box-shadow:0 0 8px rgba(212,160,23,0.5);"></div><div style="position:relative;z-index:1;font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;color:#1a1611;">${num}</div></div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });
        const marker = L.marker([el.lat, el.lon], { icon }).addTo(this.map!);
        marker.bindTooltip(label, { direction: 'top', offset: [0, -10] });
        this.markers.push({ number: num, label, lat: el.lat, lng: el.lon, marker });
        results.push({ num, label, lat: el.lat, lng: el.lon });
      });
      return { success: true, count: els.length, results, reused, mirrored };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  addPin(label = ''): { success: boolean; pinNumber?: number } {
    if (!this.map) return { success: false };
    const c = this.map.getCenter();
    return this.addPinAt(label, c.lat, c.lng);
  }

  /** Add a pin at explicit coordinates (workspace shape → map bridge). */
  addPinAt(label: string, lat: number, lng: number): { success: boolean; pinNumber?: number } {
    if (!this.map) return { success: false };
    const num = this.markers.length + 1;
    const marker = this.createPinMarker(num, lat, lng);
    const shown = label || `pin ${num}`;
    marker.bindTooltip(shown, { direction: 'top', offset: [0, -10] });
    this.markers.push({ number: num, label, lat, lng, marker });
    this.persistPins();
    return { success: true, pinNumber: num };
  }

  /** Numbered gold dot marker (shared by pins and POI results). */
  private createPinMarker(num: number, lat: number, lng: number): L.Marker {
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:4px;background:#d4a017;border-radius:50%;box-shadow:0 0 8px rgba(212,160,23,0.5);"></div><div style="position:relative;z-index:1;font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;color:#1a1611;">${num}</div></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    return L.marker([lat, lng], { icon }).addTo(this.map!);
  }

  /** Re-create persisted pins after attach (reload survival). */
  private restorePins(): void {
    const saved = Storage.get<Array<{ number: number; label: string; lat: number; lng: number }>>(
      STORAGE_KEYS.pins,
      [],
    );
    if (!Array.isArray(saved) || saved.length === 0) return;
    for (const p of saved) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
      const num = this.markers.length + 1;
      const marker = this.createPinMarker(num, p.lat, p.lng);
      const shown = p.label || `pin ${num}`;
      marker.bindTooltip(shown, { direction: 'top', offset: [0, -10] });
      this.markers.push({ number: num, label: p.label, lat: p.lat, lng: p.lng, marker });
    }
  }

  /** Write pin list (marker refs stripped) to localStorage. */
  private persistPins(): void {
    Storage.set(
      STORAGE_KEYS.pins,
      this.markers.map((p) => ({ number: p.number, label: p.label, lat: p.lat, lng: p.lng })),
    );
  }

  /* Task 72 — views persist too: saveView only ever filled the in-memory
   * map, so `saveview tehran` died on every reload while pins survived —
   * STORAGE_KEYS.views existed and was never written. Same contract as
   * pins: write on mutation, restore on attach. */
  private persistViews(): void {
    Storage.set(STORAGE_KEYS.views, Array.from(this.savedViews.values()));
  }

  private restoreViews(): void {
    const saved = Storage.get<MapView[]>(STORAGE_KEYS.views, []);
    if (!Array.isArray(saved)) return;
    for (const v of saved) {
      if (!v || typeof v.name !== 'string' || typeof v.lat !== 'number' || typeof v.lng !== 'number') continue;
      this.savedViews.set(v.name, v);
    }
  }

  /** Delete one pin by number; remaining pins keep their numbers. */
  removePin(num: number): { success: boolean; error?: string } {
    const idx = this.markers.findIndex((p) => p.number === num);
    if (idx === -1) return { success: false, error: `Pin ${num} not found` };
    const pin = this.markers[idx];
    if (pin.marker && this.map) this.map.removeLayer(pin.marker as L.Layer);
    this.markers.splice(idx, 1);
    this.persistPins();
    return { success: true };
  }

  listPins(): Array<{ number: number; label: string; lat: number; lng: number }> {
    return this.markers.map((p) => ({ number: p.number, label: p.label, lat: p.lat, lng: p.lng }));
  }

  /** Fly the map to explicit coordinates (goto <node>, node markers). */
  flyToLatLng(lat: number, lng: number, zoom?: number): void {
    this.flyToCoords(lat, lng, zoom, 1.6);
  }

  /* ═══ Task 43 — arrival pulse ═══
   * Click-to-fly terminal rows land BLIND on a busy map: which dot is
   * the thought I just flew to? flyAndPulse wraps flyToLatLng and, on
   * the fly's own moveend (no magic timers — Leaflet fires it exactly
   * once per animation), pulses the marker nearest the destination
   * (node markers AND pins, ≤34 container-px). One CSS animation, twice
   * through, then the class is removed; perf-low machines skip the
   * pulse entirely (html[data-perf] gate inside pulseNearestMarker). */
  flyAndPulse(lat: number, lng: number, zoom?: number): void {
    this.flyToLatLng(lat, lng, zoom);
    if (!this.map) return;
    this.map.once('moveend', () => this.pulseNearestMarker(lat, lng));
  }

  /** One-time visual pulse on the marker nearest (lat, lng) — node
   *  markers and numbered pins both scanned, pure projection math
   *  (latLngToContainerPoint), no DOM walks. No-op when: no marker in
   *  range, or perf tier is low (zero-animation contract). */
  pulseNearestMarker(lat: number, lng: number): void {
    if (!this.map) return;
    if (typeof document !== 'undefined' && document.documentElement.dataset.perf === 'low') return;
    const target = this.map.latLngToContainerPoint([lat, lng]);
    let bestEl: HTMLElement | null = null;
    let bestD = 34;
    const scan = (m: L.Marker) => {
      const el = m.getElement();
      if (!el) return;
      const p = this.map!.latLngToContainerPoint(m.getLatLng());
      const d = Math.hypot(p.x - target.x, p.y - target.y);
      if (d < bestD) {
        bestD = d;
        bestEl = el;
      }
    };
    this.nodeMarkers.forEach(scan);
    /* MapPin.marker is `unknown` by design (keeps L types out of the
     * persistence shape) — the runtime value is always a Leaflet marker. */
    this.markers.forEach((m) => scan(m.marker as L.Marker));
    if (!bestEl) return;
    const el = bestEl as HTMLElement;
    el.classList.remove('naksha-marker-pulse');
    void el.offsetWidth; // restart the animation if the class lingered
    el.classList.add('naksha-marker-pulse');
    window.setTimeout(() => el.classList.remove('naksha-marker-pulse'), 2000);
  }

  jumpToPin(num: number): { success: boolean; error?: string } {
    const pin = this.markers.find((p) => p.number === num);
    if (!pin) return { success: false, error: `Pin ${num} not found` };
    this.flyToCoords(pin.lat, pin.lng, Math.max(this.getZoom(), 14), 1.5);
    /* Task 44 — the pin you jumped to pulses on arrival (same moveend
     * gate as flyAndPulse; perf-low machines stay silent). */
    if (this.map) this.map.once('moveend', () => this.pulseNearestMarker(pin.lat, pin.lng));
    return { success: true };
  }

  clearPins(): void {
    this.markers.forEach((p) => {
      if (p.marker && this.map) this.map.removeLayer(p.marker as L.Layer);
    });
    this.markers = [];
    Storage.remove(STORAGE_KEYS.pins);
  }

  /* ═══ CareSpace node markers (Task 34) ═══
   *  Violet thought-markers for nodes that carry a location — visually
   *  distinct from numbered gold pins. Sync is DIFFED by the composite
   *  key (Task 36): only new/removed/moved markers mutate the DOM, so
   *  live updates during CareSpace editing stay cheap on CPU-only
   *  machines. */

  /** Replace the marker set with `nodes`; `onClick` fires on marker click
   *  (open the thought's info card). Call with an empty array to hide the
   *  layer. Task 35: tooltips carry the note count; markers FADE at low
   *  zoom so a dense region reads as a haze instead of a pile of rings.
   *  Task 36: markers are keyed by the CALLER-SUPPLIED composite `key`
   *  (netId:nodeId) — the same backup caremerge --rename'd twice produces
   *  two networks with IDENTICAL node ids, and a bare-nodeId key silently
   *  dropped the second network's markers (seen-set dedupe) and resolved
   *  every click to the first matching river. */
  syncNodeMarkers(
    nodes: Array<{ key: string; label: string; netName: string; lat: number; lng: number; notes?: number; color?: string }>,
    onClick: (key: string) => void,
  ): void {
    if (!this.map) return;
    this.nodeMarkerClickHandler = onClick;
    const seen = new Set<string>();
    for (const n of nodes) {
      seen.add(n.key);
      const existing = this.nodeMarkers.get(n.key);
      const tooltip = `${n.netName} · ${n.label}${n.notes ? ` · ${n.notes} note${n.notes === 1 ? '' : 's'}` : ''}`;
      if (existing) {
        existing.setLatLng([n.lat, n.lng]);
        existing.setTooltipContent(tooltip);
        /* Task 37: provenance tint — re-icon ONLY when the color actually
         * changed (untagged = undefined violet). One setIcon per change,
         * nothing on untouched markers. */
        const prevColor = this.nodeMarkerColors.get(n.key);
        if (prevColor !== n.color) {
          existing.setIcon(MapEngineImpl.nodeIcon(n.color));
          this.nodeMarkerColors.set(n.key, n.color);
        }
      } else {
        const marker = L.marker([n.lat, n.lng], { icon: MapEngineImpl.nodeIcon(n.color) }).addTo(this.map);
        marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -10] });
        marker.on('click', () => this.nodeMarkerClickHandler?.(n.key));
        this.nodeMarkers.set(n.key, marker);
        this.nodeMarkerColors.set(n.key, n.color);
      }
    }
    for (const [id, marker] of this.nodeMarkers) {
      if (!seen.has(id)) {
        marker.remove();
        this.nodeMarkers.delete(id);
        this.nodeMarkerColors.delete(id);
      }
    }
    this.applyNodeMarkerZoomFade();
  }

  /** Thought-marker density aid: below zoom 10 the rings fade to 45%
   *  (many thoughts over a wide area read as a constellation haze);
   *  from zoom 12 up they are fully opaque. One style write per marker
   *  on zoomend — no re-layout, no redraw loop. */
  private applyNodeMarkerZoomFade(): void {
    if (!this.map) return;
    const opacity = this.map.getZoom() < 10 ? '0.45' : this.map.getZoom() < 12 ? '0.75' : '1';
    this.nodeMarkers.forEach((m) => {
      const el = m.getElement();
      if (el) el.style.opacity = opacity;
    });
  }

  /** Remove every node marker (layer toggled off / map teardown). */
  clearNodeMarkers(): void {
    this.nodeMarkers.forEach((m) => m.remove());
    this.nodeMarkers.clear();
  }

  get nodeMarkerCount(): number {
    return this.nodeMarkers.size;
  }

  /** Task 40 — magnetic placement: CONTAINER-space positions of every
   *  thought marker, computed with latLngToContainerPoint (pure projection
   *  math — no DOM reads, no layout thrash, safe to call from a throttled
   *  mousemove). The place-mode ghost scans this for the nearest marker
   *  within its snap radius and locks onto it; the commit then writes the
   *  CAPTURED coordinates so co-locating a thought with another is a
   *  deliberate, pixel-precise act instead of a "close enough" click. */
  getNodeMarkerScreenPositions(): Array<{ key: string; x: number; y: number; lat: number; lng: number }> {
    if (!this.map) return [];
    const out: Array<{ key: string; x: number; y: number; lat: number; lng: number }> = [];
    this.nodeMarkers.forEach((m, key) => {
      const ll = m.getLatLng();
      const p = this.map!.latLngToContainerPoint(ll);
      out.push({ key, x: p.x, y: p.y, lat: ll.lat, lng: ll.lng });
    });
    return out;
  }

  /** Ring + core — a "thought at a place". Static paint. Task 37: an
   *  optional tint color (from the node's first tag — set by workspace
   *  sketch bridges) recolors the RING + GLOW while the core stays gold,
   *  so the marker reads as "a thought painted in its sketch's color".
   *  Untagged nodes keep the violet identity of the layer. */
  private static nodeIcon(color?: string): L.DivIcon {
    /* hex → rgba glow string without a color-math lib: parse 6-digit hex.
     * Task 91 — the untagged ring/glow ride the THEMED accent: the html
     * string is parsed by the browser (Leaflet divIcon = DOM), so
     * color-mix(var(--naksha-purple)) works — light themes get their
     * readable violet, dark themes keep the heritage hue. Exact-alpha
     * equivalents of the old rgba(154,140,225,X) literals. */
    let ringStyle = 'color-mix(in srgb, var(--naksha-purple) 95%, transparent)';
    let glowStyle = 'color-mix(in srgb, var(--naksha-purple) 50%, transparent)';
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      ringStyle = color;
      glowStyle = `rgba(${r},${g},${b},0.5)`;
    }
    const html =
      '<div style="width:18px;height:18px;position:relative;display:flex;align-items:center;justify-content:center;">' +
      '<div style="position:absolute;inset:0;border:1.5px solid ' + ringStyle + ';border-radius:50%;' +
      'box-shadow:0 0 6px ' + glowStyle + ';background:rgba(26,22,17,0.6);"></div>' +
      '<div style="position:relative;width:5px;height:5px;background:#d4a017;border-radius:50%;"></div>' +
      '</div>';
    return L.divIcon({ className: '', html, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  /* ─── saved views ─── */
  saveView(name: string): { success: boolean; error?: string } {
    if (!this.map) return { success: false, error: 'Map not ready' };
    const c = this.map.getCenter();
    this.savedViews.set(name, {
      name,
      lat: c.lat,
      lng: c.lng,
      zoom: this.map.getZoom(),
      layer: this.currentLayer,
      createdAt: Date.now(),
    });
    this.persistViews(); // Task 72 — reload survival (pins' parity)
    return { success: true };
  }

  listViews(): MapView[] {
    return Array.from(this.savedViews.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /* Task 97 — view names resolve like every other name in the dialect:
   * exact key first, then a case-folded pass ('view Paris' flies to the
   * saved 'paris' — the node cascade has matched case-insensitively all
   * along). Only a UNIQUE case-folded hit applies; a genuine miss still
   * returns the honest error the command layer corrects from. */
  private resolveViewKey(name: string): string | null {
    if (this.savedViews.has(name)) return name;
    const lower = name.toLowerCase();
    const hits = Array.from(this.savedViews.keys()).filter((k) => k.toLowerCase() === lower);
    return hits.length === 1 ? hits[0] : null;
  }

  flyToView(name: string): { success: boolean; error?: string } {
    const key = this.resolveViewKey(name);
    const v = key ? this.savedViews.get(key) : undefined;
    if (!v) return { success: false, error: `No view named "${name}"` };
    this.setLayer(v.layer);
    this.flyToCoords(v.lat, v.lng, v.zoom, 1.5);
    return { success: true };
  }

  removeView(name: string): { success: boolean; error?: string } {
    const key = this.resolveViewKey(name);
    if (!key) return { success: false, error: `No view named "${name}"` };
    this.savedViews.delete(key);
    this.persistViews(); // Task 72 — keep storage in step with removals
    return { success: true };
  }

  /* Task 54 — undo parity for the kill chip: a ✕ on a pins or views row
   * snapshots BOTH collections (cheap: a handful of plain entries), and
   * `undo` restores them wholesale. One kind ('mapdata') covers both
   * destructive map-side verbs — no CareSpace snapshot involved.
   * Task 87 — measurements ride the same snapshot (rmmeasure's parity
   * costs one array copy; they are memory-only, the undo slot already
   * outlives them). The field is OPTIONAL in the shape: snapshots
   * parked before this change carry no measurements — absence means
   * "not mine", and the live map keeps them untouched on restore. */
  snapshotMapData(): { pins: Array<{ number: number; label: string; lat: number; lng: number }>; views: MapView[]; measurements?: Array<{ name: string; fromLabel: string; toLabel: string; km: number; fromLat: number; fromLng: number; toLat: number; toLng: number; createdAt: number }> } {
    return {
      pins: this.markers.map((p) => ({ number: p.number, label: p.label, lat: p.lat, lng: p.lng })),
      views: this.listViews(),
      measurements: Array.from(this.savedMeasurements.values()),
    };
  }

  /** Rebuild pins + saved views from a snapshotMapData snapshot. Pins are
   * re-created at their ORIGINAL numbers (the gold dots re-number the same
   * way removePin left them — contiguous 1..N); saved views rebuild the
   * whole keyed map. Persisted state follows. */
  replaceMapData(snap: { pins: Array<{ number: number; label: string; lat: number; lng: number }>; views: MapView[]; measurements?: Array<{ name: string; fromLabel: string; toLabel: string; km: number; fromLat: number; fromLng: number; toLat: number; toLng: number; createdAt: number }> }): void {
    for (const p of this.markers) {
      if (p.marker && this.map) this.map.removeLayer(p.marker as L.Layer);
    }
    this.markers = [];
    for (const p of snap.pins) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
      const marker = this.createPinMarker(p.number, p.lat, p.lng);
      marker.bindTooltip(p.label || `pin ${p.number}`, { direction: 'top', offset: [0, -10] });
      this.markers.push({ number: p.number, label: p.label, lat: p.lat, lng: p.lng, marker });
    }
    this.persistPins();
    this.savedViews = new Map(snap.views.map((v) => [v.name, v]));
    /* Task 87 — measurements rebuild only when the snapshot carries
     * them (pre-Task-87 snapshots predate the field; restoring one
     * leaves the live measurements exactly as they are). */
    if (snap.measurements) {
      this.savedMeasurements = new Map(snap.measurements.map((m) => [m.name, m]));
    }
  }

  /* ─── geolocation ─── */
  whereAmI(): Promise<{ success: boolean; lat?: number; lng?: number; error?: string }> {
    return new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        resolve({ success: false, error: 'Geolocation not available' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          this.flyToCoords(latitude, longitude, 14, 2);
          resolve({ success: true, lat: latitude, lng: longitude });
        },
        (err) => resolve({ success: false, error: err.message }),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
      );
    });
  }

  getState(): { lat: number; lng: number; zoom: number; layer: MapLayerKey } {
    const c = this.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: this.getZoom(), layer: this.currentLayer };
  }

  /** Pretty-print a route result for the terminal. */
  formatRouteReport(r: { distanceKm: number; durationSec: number; from: GeocodeResult; to: GeocodeResult }): string[] {
    return [
      `Distance: ${formatDistance(r.distanceKm)}`,
      `Duration: ~${formatDuration(r.durationSec)}`,
      `From: ${r.from.displayName.split(',')[0]}`,
      `To: ${r.to.displayName.split(',')[0]}`,
    ];
  }

  formatMeasureReport(r: { km: number; from: GeocodeResult; to: GeocodeResult }): string[] {
    return [
      `Straight-line: ${formatDistance(r.km)}`,
      `From: ${r.from.displayName.split(',')[0]}`,
      `To: ${r.to.displayName.split(',')[0]}`,
    ];
  }
}

export const MapEngine = new MapEngineImpl();
