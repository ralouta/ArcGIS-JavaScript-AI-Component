/**
 * arcgisConfig
 *
 * Central config for ArcGIS service URLs and app-level DOM selectors.
 *
 * All files that previously inlined these strings now import from here.
 * Updating a URL or selector ID is a one-line change in one place.
 */

// ── ArcGIS service URLs ───────────────────────────────────────────────────────

/** ArcGIS World Geocoder REST endpoint (findAddressCandidates operation). */
export const GEOCODER_URL =
  "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

/**
 * WOR_Boundaries_2024 FeatureServer hosted on the Esri demographics server.
 * Layer 0 = World Regions, Layer 1 = World Countries.
 */
export const BOUNDARIES_SERVICE_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/WOR_Boundaries_2024/FeatureServer";

// ── DOM selectors ─────────────────────────────────────────────────────────────

/**
 * CSS selector for the main ArcGIS MapView `<arcgis-map>` custom element.
 * Must match the `id` attribute set in App.tsx.
 */
export const MAP_ELEMENT_SELECTOR = "#main-map";

// ── Synthesis limits ──────────────────────────────────────────────────────────

/**
 * Maximum number of features the GeoJSON Synthesis pipeline will render per
 * query.  Applies to both the fast path (raw GeoJSON) and the LLM path.
 * Raise this if users need more — lower it if rendering gets slow.
 */
export const MAX_SYNTHESIZED_FEATURES = 100;
