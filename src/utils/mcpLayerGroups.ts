/**
 * mcpLayerGroups
 *
 * Single source of truth for layer group category definitions.
 *
 * Used by:
 *  - mcpGeoJsonSynthesizer   — builds the LLM Phase 5 prompt section
 *                              and drives the fast-path inferLayerGroup()
 *  - mcpArbitraryRenderer    — color lookup for per-group GraphicsLayers
 *
 * Adding or renaming a group here automatically propagates to both the LLM
 * prompt examples and the renderer colours — no other files need to change.
 */

export interface LayerGroupDef {
  /** Canonical group name returned by the LLM and used as the layer title. */
  name: string;
  /** RGB colour triple used when rendering graphics for this group. */
  rgb: [number, number, number];
  /**
   * Human-readable description of what belongs here.
   * Injected verbatim into the LLM system prompt so the model knows which
   * group name to return for different feature types.
   */
  llmExamples: string;
  /**
   * Optional fast-path matcher for raw GeoJSON features (no LLM).
   * Called with a lower-cased concatenation of all property k/v pairs,
   * the geometry type string, and the list of STAC asset keys.
   * Return true if this group is the best fit; the first match wins.
   */
  match?: (combined: string, geomType: string, assetKeys: string[]) => boolean;
}

/**
 * Ordered priority list: more specific groups come before vaguer ones so the
 * first-match logic in inferLayerGroupFromFeature() gives sensible results.
 * "General" is always last and has no matcher (acts as the fallback).
 */
export const LAYER_GROUPS: LayerGroupDef[] = [
  {
    name: "Satellite Imagery",
    rgb: [92, 75, 138],
    llmExamples:
      "STAC items, COGs, satellite/aerial imagery, ortho photos, remote sensing footprints",
    match: (combined, _geomType, assetKeys) =>
      assetKeys.some((k) =>
        ["thumbnail", "visual", "b01", "b02", "red", "nir", "overview"].includes(k),
      ) ||
      /platform|constellation|sentinel|landsat|imagery|ortho|stac|item_type/.test(combined),
  },
  {
    name: "Events & Incidents",
    rgb: [200, 20, 0],
    llmExamples:
      "Fires, floods, earthquakes, storms, disasters, accidents, outbreaks, emergency/alert zones",
    match: (combined) =>
      /fire_|incid|disaster|flood|earthquake|hurricane|cyclone|perimeter|hazard|emergency|alert/.test(
        combined,
      ),
  },
  {
    name: "Administrative Boundaries",
    rgb: [0, 128, 128],
    llmExamples:
      "Countries, states, provinces, municipalities, districts, admin boundaries, census units",
    match: (combined) =>
      /capital|admin_level|country|province|municipality|district|boundary|admin/.test(combined),
  },
  {
    name: "Weather & Environment",
    rgb: [10, 124, 66],
    llmExamples:
      "Weather stations, forecasts, AQI sensors, temperature/humidity/precipitation readings",
    match: (combined) =>
      /temperature|humidity|precipitation|aqi|wind|forecast|weather|climate|rain|snow/.test(
        combined,
      ),
  },
  {
    name: "Infrastructure & Routes",
    rgb: [200, 80, 0],
    llmExamples:
      "Roads, highways, railways, pipelines, power lines, network routes, transit corridors",
    match: (combined) =>
      /road|highway|railway|pipeline|route|transit|path|track|corridor|network/.test(combined),
  },
  {
    name: "Coverage Areas",
    rgb: [60, 120, 180],
    llmExamples:
      "Bounding boxes, search extents, service areas, data footprints (not imagery)",
    match: (combined) =>
      /bbox|extent|coverage|footprint|service_area|search_area/.test(combined),
  },
  {
    name: "Points of Interest",
    rgb: [0, 100, 220],
    llmExamples:
      "Cities, landmarks, addresses, businesses, named locations, geocoded places",
    match: (_combined, geomType) =>
      geomType === "Point" || geomType === "MultiPoint",
  },
  {
    name: "General",
    rgb: [80, 80, 100],
    llmExamples: "Everything else not covered by the categories above",
    // no match fn — acts as the unconditional fallback
  },
];

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Assign a layer group to a raw GeoJSON feature using fast keyword / geometry
 * matching.  Iterates LAYER_GROUPS in order; first match wins; returns
 * "General" when nothing matches.
 */
export function inferLayerGroupFromFeature(
  combined: string,
  geomType: string,
  assetKeys: string[],
): string {
  for (const def of LAYER_GROUPS) {
    if (def.match?.(combined, geomType, assetKeys)) return def.name;
  }
  return "General";
}

/** RGB triple for a named group (falls back to General's colour). */
export function rgbForGroup(name: string | undefined): [number, number, number] {
  return (
    LAYER_GROUPS.find((g) => g.name === (name ?? "General"))?.rgb ?? [80, 80, 100]
  );
}

/**
 * Build the layer group list for the LLM Phase 5 system prompt section.
 * Each line is:  "Group Name" — description of what belongs here
 */
export function buildLayerGroupPromptSection(): string {
  return LAYER_GROUPS.map((g) => `  "${g.name}" — ${g.llmExamples}`).join("\n");
}
