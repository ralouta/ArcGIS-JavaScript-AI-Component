import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils";

// ── Service config ────────────────────────────────────────────────────────────

const BOUNDARIES_BASE =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/WOR_Boundaries_2024/FeatureServer";

/** Layer IDs inside WOR_Boundaries_2024 */
export const LAYER_REGION = 0;
export const LAYER_COUNTRY = 1;

/** The GraphicsLayer id we manage on the map */
export const MCP_GEO_LAYER_ID = "mcp-geo-results";

// ── Region name normalisation ─────────────────────────────────────────────────
// The service uses standard UN sub-region names.  Map common user-facing labels
// to the exact strings in the REGION field.

const REGION_ALIASES: Record<string, string> = {
  "middle east":          "Western Asia",
  "east asia":            "Eastern Asia",
  "southeast asia":       "Southeastern Asia",
  "south asia":           "Southern Asia",
  "central asia":         "Central Asia",
  "east africa":          "Eastern Africa",
  "west africa":          "Western Africa",
  "north africa":         "Northern Africa",
  "southern africa":      "Southern Africa",
  "central africa":       "Middle Africa",
  "sub-saharan africa":   "Eastern Africa",
  "europe":               "Western Europe",
  "eastern europe":       "Eastern Europe",
  "western europe":       "Western Europe",
  "northern europe":      "Northern Europe",
  "southern europe":      "Southern Europe",
  "latin america":        "South America",
  "south america":        "South America",
  "central america":      "Central America",
  "north america":        "Northern America",
  "caribbean":            "Caribbean",
  "oceania":              "Australia/New Zealand",
  "australia":            "Australia/New Zealand",
  "caucasus":             "Western Asia",
  "balkans":              "Southern Europe",
};

function normaliseRegionName(raw: string): string {
  return REGION_ALIASES[raw.toLowerCase()] ?? raw;
}

// ── Geo entity types ──────────────────────────────────────────────────────────

export interface GeoPoint {
  kind: "point";
  label: string;
  lat: number;
  lon: number;
  description?: string;
}

export interface GeoCountry {
  kind: "country";
  name: string;           // matches NAME field in Layer 1
  description?: string;
}

export interface GeoRegion {
  kind: "region";
  name: string;           // will be normalised to REGION field in Layer 0
  description?: string;
}

export type GeoEntity = GeoPoint | GeoCountry | GeoRegion;

// ── REST query helpers ────────────────────────────────────────────────────────

async function queryLayer(
  layerIndex: number,
  where: string,
  outFields: string,
): Promise<any[]> {
  const url = `${BOUNDARIES_BASE}/${layerIndex}/query`;
  const params = new URLSearchParams({
    where,
    outFields,
    outSR: "4326",
    f: "json",
    returnGeometry: "true",
  });

  try {
    const res = await fetch(`${url}?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.features) ? json.features : [];
  } catch {
    return [];
  }
}

// ── Graphic builders ──────────────────────────────────────────────────────────

const POLY_SYMBOL = {
  type: "simple-fill",
  color: [0, 122, 194, 0.12],
  outline: { color: [0, 122, 194, 0.85], width: 1.5 },
};

const POINT_SYMBOL = {
  type: "simple-marker",
  color: [0, 122, 194, 0.9],
  outline: { color: [255, 255, 255, 1], width: 1.5 },
  size: 12,
};

function esriFeatureToGraphic(
  feature: any,
  nameField: string,
  description?: string,
): Graphic | null {
  if (!feature?.geometry) return null;

  let geometry: any;
  try {
    geometry = geometryJsonUtils.fromJSON({
      ...feature.geometry,
      spatialReference: { wkid: 4326 },
    });
  } catch {
    return null;
  }

  const name: string =
    feature.attributes?.[nameField] ?? feature.attributes?.NAME ?? "";

  return new Graphic({
    geometry,
    symbol: POLY_SYMBOL as any,
    attributes: { name, description: description ?? "" },
    popupTemplate: {
      title: "{name}",
      content: description ? "<p>{description}</p>" : "",
    } as any,
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render a list of geographic entities onto the active ArcGIS MapView.
 * Replaces the previous MCP geo layer each call.
 */
export async function renderMcpGeoEntities(
  entities: GeoEntity[],
): Promise<void> {
  if (!entities.length) return;

  // Reach the MapView through the custom element's .view property.
  const mapEl = document.querySelector("#main-map") as any;
  const view: any = mapEl?.view;
  if (!view?.map) return;

  // Replace any previous MCP geo layer.
  const old = view.map.findLayerById(MCP_GEO_LAYER_ID);
  if (old) view.map.remove(old);

  const layer = new GraphicsLayer({
    id: MCP_GEO_LAYER_ID,
    title: "MCP Results",
    listMode: "hide",
  });
  view.map.add(layer);

  const countries = entities.filter((e): e is GeoCountry => e.kind === "country");
  const regions   = entities.filter((e): e is GeoRegion  => e.kind === "region");
  const points    = entities.filter((e): e is GeoPoint   => e.kind === "point");

  // ── Countries (Layer 1, NAME field) ───────────────────────────────────────
  if (countries.length) {
    const list = countries
      .map((c) => `'${c.name.replace(/'/g, "''")}'`)
      .join(",");
    const features = await queryLayer(LAYER_COUNTRY, `NAME IN (${list})`, "NAME");
    for (const feat of features) {
      const entity = countries.find(
        (c) => c.name.toLowerCase() === (feat.attributes?.NAME ?? "").toLowerCase(),
      );
      const g = esriFeatureToGraphic(feat, "NAME", entity?.description);
      if (g) layer.add(g);
    }
  }

  // ── Regions (Layer 0, REGION field) ───────────────────────────────────────
  if (regions.length) {
    const normalised = regions.map((r) => ({
      ...r,
      normalised: normaliseRegionName(r.name),
    }));
    const list = normalised
      .map((r) => `'${r.normalised.replace(/'/g, "''")}'`)
      .join(",");
    const features = await queryLayer(LAYER_REGION, `REGION IN (${list})`, "REGION");
    for (const feat of features) {
      const entity = normalised.find(
        (r) => r.normalised.toLowerCase() === (feat.attributes?.REGION ?? "").toLowerCase(),
      );
      const g = esriFeatureToGraphic(feat, "REGION", entity?.description);
      if (g) layer.add(g);
    }
  }

  // ── Points ────────────────────────────────────────────────────────────────
  for (const pt of points) {
    const g = new Graphic({
      geometry: new Point({ latitude: pt.lat, longitude: pt.lon }),
      symbol: POINT_SYMBOL as any,
      attributes: { name: pt.label, description: pt.description ?? "" },
      popupTemplate: {
        title: "{name}",
        content: pt.description ? "<p>{description}</p>" : "",
      } as any,
    });
    layer.add(g);
  }
}

/** Remove the MCP geo layer from the map (call on conversation reset etc.). */
export function clearMcpGeoLayer(): void {
  const mapEl = document.querySelector("#main-map") as any;
  const view: any = mapEl?.view;
  if (!view?.map) return;
  const old = view.map.findLayerById(MCP_GEO_LAYER_ID);
  if (old) view.map.remove(old);
}
