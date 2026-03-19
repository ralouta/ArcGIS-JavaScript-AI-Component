import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import GroupLayer from "@arcgis/core/layers/GroupLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils";

// ── Service config ────────────────────────────────────────────────────────────

const BOUNDARIES_BASE =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/WOR_Boundaries_2024/FeatureServer";

/** Layer IDs inside WOR_Boundaries_2024 */
export const LAYER_REGION = 0;
export const LAYER_COUNTRY = 1;

/** The GroupLayer id we manage on the map */
export const MCP_GEO_LAYER_ID = "mcp-geo-results";
export const MCP_GEO_SOURCE_LAYER_ID = "mcp-geo-source-results";
export const MCP_GEO_CONTEXT_LAYER_ID = "mcp-geo-context-results";

// ── Region name normalisation ─────────────────────────────────────────────────

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

/** Contextual reason why this entity appeared in the MCP response. */
export interface GeoContext {
  summary: string;                              // sentence(s) from the response
  links: Array<{ url: string; label: string }>; // source URLs found near the mention
  mcpFields?: Array<{ label: string; value: string }>; // structured key-value pairs from MCP output
}

export type GeoOrigin = "source" | "context";

export interface GeoPoint {
  kind: "point";
  origin: GeoOrigin;
  label: string;
  lat: number;
  lon: number;
  description?: string;
  context?: GeoContext;
}

export interface GeoCountry {
  kind: "country";
  origin: GeoOrigin;
  name: string;           // matches NAME field in Layer 1
  description?: string;
  context?: GeoContext;
}

export interface GeoRegion {
  kind: "region";
  origin: GeoOrigin;
  name: string;           // will be normalised to REGION field in Layer 0
  description?: string;
  context?: GeoContext;
}

export type GeoEntity = GeoPoint | GeoCountry | GeoRegion;

// ── REST query helpers ────────────────────────────────────────────────────────

async function queryLayer(
  layerIndex: number,
  where: string,
  outFields = "*",
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

// ── Symbols ───────────────────────────────────────────────────────────────────

/** Country polygon — semi-opaque teal fill, solid stroke */
const COUNTRY_SYMBOL = {
  type: "simple-fill",
  color: [0, 139, 139, 0.18],
  outline: { color: [0, 139, 139, 0.9], width: 1.8 },
};

/** Region polygon — muted amber, dashed-look via slightly transparent stroke */
const REGION_SYMBOL = {
  type: "simple-fill",
  color: [194, 120, 0, 0.10],
  outline: { color: [194, 120, 0, 0.80], width: 1.4 },
};

/** Point marker — vivid blue with white halo */
const POINT_SYMBOL = {
  type: "simple-marker",
  style: "circle",
  color: [0, 100, 220, 0.92],
  outline: { color: [255, 255, 255, 1], width: 2 },
  size: 13,
};

/** Representative point for polygon-based locations when no explicit point exists */
const LOCATION_CENTER_SYMBOL = {
  type: "simple-marker",
  style: "diamond",
  color: [255, 106, 0, 0.95],
  outline: { color: [255, 255, 255, 1], width: 1.8 },
  size: 10,
};

// ── Popup builders ────────────────────────────────────────────────────────────

/** Sanitise a string for safe HTML embedding */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CL = `style="color:#888;padding:2px 10px 2px 0;white-space:nowrap;font-size:0.82rem"`;
const CV = `style="font-weight:500;font-size:0.88rem"`;

type PointSemanticType = "weather" | "air" | "news" | "catalog" | "place";

function badge(label: string, tone: "neutral" | "accent" = "neutral"): string {
  const style = tone === "accent"
    ? "background:#e7f1fb;color:#005e95;border:1px solid #bed7ea"
    : "background:#f4f5f7;color:#4d5965;border:1px solid #d8dde3";
  return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:0.72rem;font-weight:600;${style}">${esc(label)}</span>`;
}

function formatSectionTitle(ctx?: GeoContext, fallback = "Supporting Context"): string {
  const haystack = [
    ctx?.summary ?? "",
    ...(ctx?.mcpFields ?? []).map((field) => `${field.label} ${field.value}`),
  ].join(" ").toLowerCase();

  if (/forecast|temperature|humidity|wind|precipitation|weather/.test(haystack)) return "Forecast Snapshot";
  if (/air quality|aqi|pm2\.5|ozone|pollut/.test(haystack)) return "Air Quality Snapshot";
  if (/article|headline|news|coverage|times|reuters|independent|post/.test(haystack)) return "Related Coverage";
  if (/stac|collection|catalog|imagery|ortho|asset/.test(haystack)) return "Catalog Context";
  return fallback;
}

function normalizeSummary(summary: string): string {
  return summary
    .replace(/Tell me if you want[^.]*\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSummaryHtml(summary?: string): string {
  if (!summary?.trim()) return "";
  const normalized = normalizeSummary(summary);
  if (!normalized) return "";

  const candidateItems = normalized
    .split(/\s+-\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 24);

  if (candidateItems.length >= 2) {
    return `<ul style="margin:0;padding-left:1.05rem;color:#2f3a45;font-size:0.82rem;line-height:1.45">${candidateItems
      .slice(0, 4)
      .map((item) => `<li style="margin:0 0 4px">${esc(item)}</li>`)
      .join("")}</ul>`;
  }

  return `<p style="margin:0;color:#2f3a45;font-size:0.82rem;line-height:1.5">${esc(normalized)}</p>`;
}

function buildLinksHtml(links?: Array<{ url: string; label: string }>): string {
  if (!links?.length) return "";
  return `
    <div style="margin-top:8px">
      <div style="font-size:0.72rem;font-weight:700;color:#62707c;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Resource Links</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 8px">
        ${links
          .map((link) => `<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"
            style="display:inline-flex;align-items:center;gap:4px;font-size:0.78rem;color:#005e95;text-decoration:none;padding:4px 8px;border:1px solid #c7dbe8;border-radius:8px;background:#f6fbff">${esc(link.label)}</a>`)
          .join("")}
      </div>
    </div>`;
}

function inferPointSemanticType(pt: GeoPoint): PointSemanticType {
  const haystack = [
    pt.label,
    pt.description ?? "",
    pt.context?.summary ?? "",
    ...(pt.context?.mcpFields ?? []).map((field) => `${field.label} ${field.value}`),
  ].join(" ").toLowerCase();

  if (/forecast|temperature|humidity|precipitation|wind|timezone|weather/.test(haystack)) return "weather";
  if (/air quality|aqi|pm2\.5|ozone|pollut/.test(haystack)) return "air";
  if (/article|headline|news|coverage|times|reuters|independent|post/.test(haystack)) return "news";
  if (/stac|collection|catalog|imagery|orthos|asset|thumbnail/.test(haystack)) return "catalog";
  return "place";
}

function pointSymbolFor(pt: GeoPoint) {
  const semanticType = inferPointSemanticType(pt);
  switch (semanticType) {
    case "weather":
      return {
        type: "simple-marker",
        style: "circle",
        color: [35, 137, 218, 0.95],
        outline: { color: [255, 255, 255, 1], width: 2.4 },
        size: 14,
      };
    case "air":
      return {
        type: "simple-marker",
        style: "triangle",
        color: [0, 158, 96, 0.95],
        outline: { color: [255, 255, 255, 1], width: 2.1 },
        size: 15,
      };
    case "news":
      return {
        type: "simple-marker",
        style: "square",
        color: [208, 83, 54, 0.95],
        outline: { color: [255, 255, 255, 1], width: 2 },
        size: 13,
      };
    case "catalog":
      return {
        type: "simple-marker",
        style: "diamond",
        color: [0, 123, 146, 0.95],
        outline: { color: [255, 255, 255, 1], width: 2 },
        size: 13,
      };
    default:
      return POINT_SYMBOL;
  }
}

function hasValue(value: unknown): boolean {
  return value != null && String(value).trim() !== "";
}

function firstValue(attrs: Record<string, any>, keys: string[]): unknown {
  for (const key of keys) {
    const value = attrs[key];
    if (hasValue(value)) return value;
  }
  return undefined;
}

function formatDisplayValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  return String(value);
}

function buildRows(rows: Array<{ label: string; value: unknown }>): string {
  const visible = rows.filter((row) => hasValue(row.value));
  if (!visible.length) return "";
  return `<table style="border-collapse:collapse;min-width:190px">` +
    visible.map((row) => `<tr><td ${CL}>${esc(row.label)}</td><td ${CV}>${esc(formatDisplayValue(row.value))}</td></tr>`).join("") +
    `</table>`;
}

/** Render the MCP data section: structured fields + source links + summary */
function buildContextHtml(ctx?: GeoContext): string {
  if (!ctx?.summary && !ctx?.links?.length && !ctx?.mcpFields?.length) return "";

  const SL = `style="color:#888;padding:2px 8px 2px 0;white-space:nowrap;font-size:0.8rem"`;
  const SV = `style="font-size:0.8rem;font-weight:500"`;

  const fieldsHtml = ctx.mcpFields?.length
    ? `<table style="border-collapse:collapse;min-width:190px;margin-bottom:6px">` +
      ctx.mcpFields.map(f =>
        `<tr><td ${SL}>${esc(f.label)}</td><td ${SV}>${esc(f.value)}</td></tr>`
      ).join("") +
      `</table>`
    : "";

  const summaryHtml = buildSummaryHtml(ctx.summary);
  const linksHtml = buildLinksHtml(ctx.links);
  const heading = formatSectionTitle(ctx);

  return `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e7ec">
      <div style="font-size:0.74rem;font-weight:700;color:#62707c;text-transform:uppercase;
                  letter-spacing:0.05em;margin-bottom:7px">${esc(heading)}</div>
      ${fieldsHtml}${summaryHtml}${linksHtml}
    </div>`;
}

function buildCountryPopupContent(attrs: Record<string, any>, ctx?: GeoContext): string {
  const details = buildRows([
    { label: "Capital", value: firstValue(attrs, ["CAPITAL", "CAPNAME"]) },
    { label: "Region", value: firstValue(attrs, ["SUBREGION", "SUB_REGION", "REGION"]) },
    { label: "ISO", value: firstValue(attrs, ["ISO_3DIGIT", "ISO3", "ISO"]) },
  ]);

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);line-height:1.5">
      ${details}
      ${buildContextHtml(ctx)}
    </div>`;
}

function buildRegionPopupContent(attrs: Record<string, any>, ctx?: GeoContext): string {
  const details = buildRows([
    { label: "Country", value: firstValue(attrs, ["NAME"]) },
    { label: "Sub-region", value: firstValue(attrs, ["SUBREGION", "CONTINENT"]) },
    { label: "Region", value: firstValue(attrs, ["REGION"]) },
  ]);

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);line-height:1.5">
      ${details}
      ${buildContextHtml(ctx)}
    </div>`;
}

function buildPointPopupContent(pt: GeoPoint): string {
  const semanticType = inferPointSemanticType(pt);
  const summaryBadge = badge(semanticType === "air" ? "Air quality" : semanticType.charAt(0).toUpperCase() + semanticType.slice(1), "accent");
  const originBadge = badge(pt.origin === "source" ? "Source geometry" : "Context geometry");
  const desc = pt.description ? `<p style="margin:8px 0 0;font-size:0.84rem;color:#2f3a45;line-height:1.45">${esc(pt.description)}</p>` : "";
  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);font-size:0.88rem;line-height:1.5">
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${summaryBadge}${originBadge}</div>
      <table style="border-collapse:collapse;min-width:170px">
        <tr><td ${CL}>Lat / Lon</td><td ${CV}>${pt.lat.toFixed(4)}&deg;, ${pt.lon.toFixed(4)}&deg;</td></tr>
      </table>
      ${desc}
      ${buildContextHtml(pt.context)}
    </div>`;
}

function buildLocationPointPopupContent(
  attrs: Record<string, any>,
  label: string,
  ctx?: GeoContext,
): string {
  const details = buildRows([
    { label: "Name", value: firstValue(attrs, ["NAME", "COUNTRY"]) ?? label },
    { label: "Capital", value: firstValue(attrs, ["CAPITAL", "CAPNAME"]) },
    { label: "Region", value: firstValue(attrs, ["REGION", "SUBREGION", "SUB_REGION"]) },
  ]);

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);line-height:1.5">
      <div style="font-size:0.84rem;color:#666;margin-bottom:6px">Representative point for ${esc(label)}</div>
      ${details}
      ${buildContextHtml(ctx)}
    </div>`;
}

function centerPointFromGeometry(geometry: any): Point | null {
  const center = geometry?.extent?.center;
  if (!center) return null;
  if (typeof center.latitude !== "number" || typeof center.longitude !== "number") return null;
  return new Point({ latitude: center.latitude, longitude: center.longitude });
}

// ── Graphic factories ─────────────────────────────────────────────────────────

function countryFeatureToGraphic(feature: any, entity?: GeoCountry): Graphic | null {
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

  const attrs = feature.attributes ?? {};
  const name  = attrs.NAME ?? "Country";

  return new Graphic({
    geometry,
    symbol: COUNTRY_SYMBOL as any,
    attributes: { ...attrs, _displayName: name },
    popupTemplate: {
      title: `{NAME}`,
      content: buildCountryPopupContent(attrs, entity?.context),
    } as any,
  });
}

function countryCenterPointGraphic(feature: any, entity?: GeoCountry): Graphic | null {
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

  const center = centerPointFromGeometry(geometry);
  if (!center) return null;

  const attrs = feature.attributes ?? {};
  const name = attrs.NAME ?? entity?.name ?? "Location";

  return new Graphic({
    geometry: center,
    symbol: LOCATION_CENTER_SYMBOL as any,
    attributes: { ...attrs, name },
    popupTemplate: {
      title: `{name}`,
      content: buildLocationPointPopupContent(attrs, String(name), entity?.context),
    } as any,
  });
}

function regionFeatureToGraphic(feature: any, entity?: GeoRegion): Graphic | null {
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

  const attrs  = feature.attributes ?? {};
  const region = attrs.REGION ?? "Region";
  const name   = attrs.NAME ?? "";

  return new Graphic({
    geometry,
    symbol: REGION_SYMBOL as any,
    attributes: { ...attrs },
    popupTemplate: {
      title: name ? `${name} — ${region}` : region,
      content: buildRegionPopupContent(attrs, entity?.context),
    } as any,
  });
}

function regionCenterPointGraphic(feature: any, entity?: GeoRegion): Graphic | null {
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

  const center = centerPointFromGeometry(geometry);
  if (!center) return null;

  const attrs = feature.attributes ?? {};
  const region = attrs.REGION ?? entity?.name ?? "Region";

  return new Graphic({
    geometry: center,
    symbol: LOCATION_CENTER_SYMBOL as any,
    attributes: { ...attrs, name: region },
    popupTemplate: {
      title: `{name}`,
      content: buildLocationPointPopupContent(attrs, String(region), entity?.context),
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

  const mapEl = document.querySelector("#main-map") as any;
  const view: any = mapEl?.view;
  if (!view?.map) return;

  // Replace any previous MCP geo layer.
  const old = view.map.findLayerById(MCP_GEO_LAYER_ID);
  if (old) view.map.remove(old);

  const sourceLayer = new GraphicsLayer({
    id: MCP_GEO_SOURCE_LAYER_ID,
    title: "Source Geometry",
    listMode: "show",
  });
  const contextLayer = new GraphicsLayer({
    id: MCP_GEO_CONTEXT_LAYER_ID,
    title: "Context Geometry",
    listMode: "show",
  });

  const sourceEntities = entities.filter((entity) => entity.origin === "source");
  const contextEntities = entities.filter((entity) => entity.origin === "context");

  async function addEntitiesToLayer(targetLayer: GraphicsLayer, layerEntities: GeoEntity[]): Promise<void> {
    const countries = layerEntities.filter((e): e is GeoCountry => e.kind === "country");
    const regions = layerEntities.filter((e): e is GeoRegion => e.kind === "region");
    const points = layerEntities.filter((e): e is GeoPoint => e.kind === "point");
    const addRepresentativePoints = points.length === 0;

    for (const pt of points) {
      const g = new Graphic({
        geometry: new Point({ latitude: pt.lat, longitude: pt.lon }),
        symbol: pointSymbolFor(pt) as any,
        attributes: { name: pt.label },
        popupTemplate: {
          title: `{name}`,
          content: buildPointPopupContent(pt),
        } as any,
      });
      targetLayer.add(g);
    }

    if (countries.length) {
      const list = countries
        .map((c) => `'${c.name.replace(/'/g, "''")}'`)
        .join(",");
      const features = await queryLayer(LAYER_COUNTRY, `NAME IN (${list})`);
      for (const feat of features) {
        const name = (feat.attributes?.NAME ?? "").toLowerCase();
        const entity = countries.find((c) => c.name.toLowerCase() === name);
        const g = countryFeatureToGraphic(feat, entity);
        if (g) targetLayer.add(g);
        if (addRepresentativePoints) {
          const center = countryCenterPointGraphic(feat, entity);
          if (center) targetLayer.add(center);
        }
      }
    }

    if (regions.length) {
      const normalised = regions.map((r) => ({
        ...r,
        normalised: normaliseRegionName(r.name),
      }));
      const list = normalised
        .map((r) => `'${r.normalised.replace(/'/g, "''")}'`)
        .join(",");
      const features = await queryLayer(LAYER_REGION, `REGION IN (${list})`);
      for (const feat of features) {
        const featureRegion = normaliseRegionName(feat.attributes?.REGION ?? "");
        const entity = normalised.find((r) => r.normalised === featureRegion);
        const g = regionFeatureToGraphic(feat, entity);
        if (g) targetLayer.add(g);
        if (addRepresentativePoints) {
          const center = regionCenterPointGraphic(feat, entity);
          if (center) targetLayer.add(center);
        }
      }
    }
  }

  const layersToAdd = [] as GraphicsLayer[];
  if (sourceEntities.length) layersToAdd.push(sourceLayer);
  if (contextEntities.length) layersToAdd.push(contextLayer);
  if (!layersToAdd.length) return;

  const group = new GroupLayer({
    id: MCP_GEO_LAYER_ID,
    title: "MCP Results",
    visibilityMode: "independent",
    listMode: "show",
    layers: layersToAdd,
  });
  view.map.add(group);

  const loadingTasks = [
    addEntitiesToLayer(sourceLayer, sourceEntities),
    addEntitiesToLayer(contextLayer, contextEntities),
  ];

  const initialGraphics = [
    ...((sourceLayer.graphics as any).toArray?.() ?? []),
    ...((contextLayer.graphics as any).toArray?.() ?? []),
  ];
  if (initialGraphics.length) {
    try {
      await view.goTo(initialGraphics, {
        animate: true,
        duration: initialGraphics.length === 1 ? 280 : 420,
      });
    } catch {
      // goTo may fail if the view is not ready; ignore silently.
    }
  }

  await Promise.all(loadingTasks);

  const allGraphics = [
    ...((sourceLayer.graphics as any).toArray?.() ?? []),
    ...((contextLayer.graphics as any).toArray?.() ?? []),
  ];
  if (allGraphics.length && allGraphics.length !== initialGraphics.length) {
    try {
      await view.goTo(allGraphics, {
        animate: true,
        duration: allGraphics.length === 1 ? 320 : 520,
      });
    } catch {
      // goTo may fail if the view is not ready; ignore silently.
    }
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
