/**
 * Naksha — Reader service
 * Fetches Wikipedia summaries, weather (Open-Meteo), and provides
 * an iframe-friendly URL for the "open" command.
 *
 * All requests are server-side fetches from the browser (no API
 * key needed for any of these free services). We never expose the
 * user's IP or data beyond the public API call.
 */

import { WIKI_API, WEATHER_API } from './constants';
import { weatherDescription, windDirection } from './utils';
import type { WeatherReport, WikiArticle } from './types';

export async function fetchWiki(topic: string, lang = 'en'): Promise<WikiArticle | null> {
  try {
    // Try direct summary first.
    const summaryRes = await fetch(WIKI_API.summary(topic, lang));
    if (summaryRes.ok) {
      const data = (await summaryRes.json()) as {
        title?: string;
        description?: string;
        extract?: string;
        thumbnail?: { source?: string };
        content_urls?: { desktop?: { page?: string } };
        /* Task 46 — present on geo-articles (places, cities, mountains). */
        coordinates?: { lat?: number; lon?: number };
      };
      if (data && data.title && data.extract) {
        /* Task 46 — keep the coordinates when they exist so the terminal
         * receipt can offer a click-to-fly row (same delegated listener
         * as `near`). Wikipedia lat/lon are WGS84 — directly usable. */
        const lat = typeof data.coordinates?.lat === 'number' ? data.coordinates.lat : undefined;
        const lon = typeof data.coordinates?.lon === 'number' ? data.coordinates.lon : undefined;
        return {
          title: data.title,
          description: data.description ?? '',
          extract: data.extract,
          thumbnail: data.thumbnail?.source,
          url: data.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(topic)}`,
          ...(lat != null && lon != null ? { lat, lon } : {}),
        };
      }
    }
    // Fall back to search.
    const searchRes = await fetch(WIKI_API.search(topic, lang));
    if (!searchRes.ok) return null;
    const searchData = (await searchRes.json()) as { pages?: Array<{ key?: string; title?: string; description?: string; excerpt?: string }> };
    const first = searchData.pages?.[0];
    if (!first || !first.key) return null;
    return fetchWiki(first.key, lang);
  } catch (err) {
    console.warn('[naksha] wiki fetch error:', err);
    return null;
  }
}

/* Task 100 — the coords-based core. `weather` bare means "at the
 * crosshair" (the sibling `elevation` already does), which knows its
 * coordinates and must NOT pay for (or fail on) a geocode round-trip.
 * `fetchWeather(place)` is now just geocode → here, one forecast body. */
export async function fetchWeatherAt(lat: number, lng: number, label: string): Promise<WeatherReport | null> {
  try {
    const wxRes = await fetch(WEATHER_API.forecast(lat, lng));
    if (!wxRes.ok) return null;
    const wx = (await wxRes.json()) as {
      current_weather?: { temperature: number; windspeed: number; winddirection: number; weathercode: number };
      /* Open-Meteo signals quota/param problems on a 200 with an error body. */
      error?: boolean;
      reason?: string;
    };
    /* Task 46 — surface the API's own reason (e.g. "Daily API request
     * limit exceeded") in the console instead of failing silently; the
     * terminal keeps its one-line graceful message. */
    if (wx?.error) {
      console.warn('[naksha] weather API error:', wx.reason ?? 'unknown');
      return null;
    }
    const cw = wx.current_weather;
    if (!cw) return null;
    return {
      place: label,
      temperature: cw.temperature,
      windspeed: cw.windspeed,
      winddir: cw.winddirection,
      weatherCode: cw.weathercode,
      description: `${weatherDescription(cw.weathercode)} · wind ${windDirection(cw.winddirection)} ${cw.windspeed.toFixed(0)} km/h`,
      /* Task 46 — the geocode hit already knows where it is; carrying the
       * coordinates costs one object spread and lets the receipt fly. */
      lat,
      lon: lng,
    };
  } catch (err) {
    console.warn('[naksha] weather fetch error:', err);
    return null;
  }
}

/* Task 109 — the named path now reports WHERE it failed instead of a
 * bare null: 'geocode' (nothing by that name — retype it) vs
 * 'forecast' (the geocoder hit, the forecast API refused — wait out
 * the quota). Two failures with different remedies; the verb can't
 * write an honest receipt from an undifferentiated null. The forecast
 * branch carries the hit's name and coords so the receipt can still
 * fly the map to the confirmed place. */
export type WeatherOutcome =
  | { ok: true; report: WeatherReport }
  | { ok: false; reason: 'geocode'; query: string }
  | { ok: false; reason: 'forecast'; query: string; label: string; lat: number; lng: number };

export async function fetchWeather(place: string): Promise<WeatherOutcome> {
  let hit: { latitude: number; longitude: number; name: string } | null = null;
  try {
    const geoRes = await fetch(WEATHER_API.geocode(place));
    if (!geoRes.ok) return { ok: false, reason: 'geocode', query: place };
    const geo = (await geoRes.json()) as { results?: Array<{ latitude: number; longitude: number; name: string }> };
    hit = geo.results?.[0] ?? null;
    if (!hit) return { ok: false, reason: 'geocode', query: place };
    const report = await fetchWeatherAt(hit.latitude, hit.longitude, hit.name);
    if (!report) {
      return { ok: false, reason: 'forecast', query: place, label: hit.name, lat: hit.latitude, lng: hit.longitude };
    }
    return { ok: true, report };
  } catch (err) {
    console.warn('[naksha] weather fetch error:', err);
    /* A network throw is attributed by what had resolved: a geocode hit
     * in hand means the failure happened at the forecast call. */
    return hit
      ? { ok: false, reason: 'forecast', query: place, label: hit.name, lat: hit.latitude, lng: hit.longitude }
      : { ok: false, reason: 'geocode', query: place };
  }
}

/** Pick a safe URL for the `open` command (we just pass through, the iframe handles X-Frame-Options). */
export function normalizeUrl(input: string): string {
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[a-z]+:/i.test(input)) return input;
  // Bare domain — prepend https.
  return `https://${input}`;
}
