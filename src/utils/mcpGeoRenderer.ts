import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GroupLayer from "@arcgis/core/layers/GroupLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";
import Polygon from "@arcgis/core/geometry/Polygon";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils";

// ── Service config ────────────────────────────────────────────────────────────

const BOUNDARIES_BASE =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/WOR_Boundaries_2024/FeatureServer";
const WORLD_GEOCODER_URL =
  "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

/** Layer IDs inside WOR_Boundaries_2024 */
export const LAYER_REGION = 0;
export const LAYER_COUNTRY = 1;

/** Managed ids for client-rendered MCP result layers */
export const MCP_GEO_LAYER_ID = "mcp-geo-results";
export const MCP_GEO_SOURCE_LAYER_ID = "mcp-geo-source-results";
export const MCP_GEO_CONTEXT_LAYER_ID = "mcp-geo-context-results";

interface RenderLayerCollection {
  prefix: string;
  label: string;
  layers: Map<string, { id: string; title: string; geometryType: "point" | "polygon"; renderer: any; graphics: Graphic[] }>;
  order: string[];
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

export interface GeoNamedPlace {
  kind: "named";
  origin: GeoOrigin;
  name: string;
  description?: string;
  context?: GeoContext;
}

export interface GeoExtent {
  kind: "extent";
  origin: GeoOrigin;
  label: string;
  west: number;
  south: number;
  east: number;
  north: number;
  description?: string;
  context?: GeoContext;
}

export type GeoEntity = GeoPoint | GeoCountry | GeoRegion | GeoNamedPlace | GeoExtent;

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

const geocodeCache = new Map<string, { latitude: number; longitude: number; label: string } | null>();

async function geocodeSingleLine(singleLine: string): Promise<{ latitude: number; longitude: number; label: string } | null> {
  const cacheKey = singleLine.trim().toLowerCase();
  if (!cacheKey) return null;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey) ?? null;

  const params = new URLSearchParams({
    f: "json",
    SingleLine: singleLine,
    maxLocations: "1",
    outFields: "Match_addr,Addr_type,City,Region",
    forStorage: "false",
  });

  try {
    const response = await fetch(`${WORLD_GEOCODER_URL}?${params.toString()}`);
    if (!response.ok) {
      geocodeCache.set(cacheKey, null);
      return null;
    }
    const json: any = await response.json();
    const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : null;
    const latitude = Number(candidate?.location?.y);
    const longitude = Number(candidate?.location?.x);
    if (isNaN(latitude) || isNaN(longitude)) {
      geocodeCache.set(cacheKey, null);
      return null;
    }
    const value = {
      latitude,
      longitude,
      label: String(candidate?.attributes?.Match_addr ?? singleLine),
    };
    geocodeCache.set(cacheKey, value);
    return value;
  } catch {
    geocodeCache.set(cacheKey, null);
    return null;
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

const EXTENT_SYMBOL = {
  type: "simple-fill",
  color: [20, 131, 92, 0.08],
  outline: { color: [20, 131, 92, 0.92], width: 1.8 },
};

/** Point marker — vivid blue with white halo */
const POINT_SYMBOL = {
  type: "simple-marker",
  style: "circle",
  color: [0, 100, 220, 0.92],
  outline: { color: [255, 255, 255, 1], width: 2 },
  size: 13,
};

const CONTEXT_POINT_SYMBOL = {
  ...POINT_SYMBOL,
  color: [255, 106, 0, 0.92],
};

// ── Popup builders ────────────────────────────────────────────────────────────

/** Sanitise a string for safe HTML embedding */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function badge(label: string, tone: "neutral" | "accent" = "neutral"): string {
  const style = tone === "accent"
    ? "background:#edf6f4;color:#14624a;border:1px solid #cde4db"
    : "background:#f4f5f7;color:#4d5965;border:1px solid #d8dde3";
  return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:0.72rem;font-weight:600;${style}">${esc(label)}</span>`;
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function labelForUrl(url: string, explicitLabel?: string): string {
  const candidate = explicitLabel?.trim();
  if (candidate && !isLikelyUrl(candidate) && !/^(?:https?)$/i.test(candidate)) {
    return candidate;
  }

  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Open resource";
  }
}

function buildLinkButton(url: string, label?: string): string {
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"
            style="display:inline-flex;align-items:center;gap:4px;font-size:0.78rem;color:#005e95;text-decoration:none;padding:4px 8px;border:1px solid #c7dbe8;border-radius:8px;background:#f6fbff">${esc(labelForUrl(url, label))}</a>`;
}

function reconstructUrlFromField(label: string, value: string): string | null {
  if (isLikelyUrl(value)) return value.trim();
  if (/^(?:https?)$/i.test(label.trim()) && value.trim().startsWith("//")) {
    return `${label.trim()}:${value.trim()}`;
  }
  return null;
}

function isSummaryLabelText(value: string): boolean {
  const trimmed = value.trim();
  return /^[\p{L}][\p{L}\p{N} '&/-]{1,40}$/u.test(trimmed)
    && !/[/.]/.test(trimmed)
    && !/^(?:https?|www)$/i.test(trimmed);
}

function normalizeSummary(summary: string): string {
  return summary
    .replace(/Tell me if you want[^.]*\.?/gi, "")
    .replace(/Would you like[^.]*\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPopupTitleText(value: string): string {
  return value
    .replace(/^\s*\d+\s*[.)-]?\s*/, "")
    .replace(/^id\s*:\s*/i, "")
    .trim();
}

function findContextFieldValue(ctx: GeoContext | undefined, labelPattern: RegExp): string | undefined {
  return ctx?.mcpFields?.find((field) => labelPattern.test(field.label))?.value?.trim();
}

function buildExtentPopupTitle(extent: GeoExtent): string {
  const itemId = findContextFieldValue(extent.context, /^id$/i);
  const titleText = cleanPopupTitleText(itemId || extent.label);

  if (extent.origin === "source") {
    return titleText ? `Map Footprint: ${titleText}` : "Map Footprint";
  }

  return titleText ? `Context Geometry: ${titleText}` : "Context Geometry";
}

function buildSummaryHtml(summary?: string): string {
  if (!summary?.trim()) return "";
  const normalized = normalizeSummary(summary);
  if (!normalized) return "";

  const renderSummaryItem = (item: string): string => {
    const trimmed = item.trim();
    if (isLikelyUrl(trimmed)) {
      return `<li style="margin:0 0 8px;line-height:1.45">${buildLinkButton(trimmed)}</li>`;
    }
    const quotedTitleMatch = trimmed.match(/^(.*?)\s+[—-]\s+["“](.+?)["”](.*)$/);
    if (quotedTitleMatch) {
      const source = quotedTitleMatch[1].trim().replace(/[—:\-]\s*$/, "");
      const title = quotedTitleMatch[2].trim();
      const tail = quotedTitleMatch[3].trim().replace(/^[-:;,]\s*/, "");
      return `<li style="margin:0 0 8px;line-height:1.45">`
        + `${source ? `<div style="font-size:0.74rem;font-weight:700;color:#6a7783;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">${esc(source)}</div>` : ""}`
        + `<div style="font-size:0.85rem;font-weight:700;color:#23313d">${esc(title)}</div>`
        + `${tail ? `<div style="font-size:0.8rem;color:#4d5965;margin-top:2px">${esc(tail)}</div>` : ""}`
        + `</li>`;
    }

    const sentenceMatch = trimmed.match(/^([^:]{2,80}):\s*(.+)$/);
    if (sentenceMatch && isSummaryLabelText(sentenceMatch[1])) {
      return `<li style="margin:0 0 6px;line-height:1.45"><span style="font-weight:700;color:#23313d">${esc(sentenceMatch[1].trim())}</span><span style="color:#4d5965">: ${esc(sentenceMatch[2].trim())}</span></li>`;
    }

    return `<li style="margin:0 0 6px;color:#2f3a45;line-height:1.45">${esc(trimmed)}</li>`;
  };

  const labeledItems = normalized
    .split(/(?=\bSummary\b\s*:?)|(?=\bHeadline\b\s*:?)|(?=\bArticle\b\s*:?)|(?=\b-\s+[A-Z])/)
    .map((item) => item.trim().replace(/^(Summary|Headline|Article)\s*:?\s*/i, ""))
    .map((item) => item.replace(/^[-*•]\s*/, "").trim())
    .filter((item) => item.length > 24);

  if (labeledItems.length >= 2) {
    return `<ul style="margin:0;padding-left:1.05rem;color:#2f3a45;font-size:0.82rem;line-height:1.45">${labeledItems
      .slice(0, 3)
      .map((item) => renderSummaryItem(item))
      .join("")}</ul>`;
  }

  const candidateItems = normalized
    .split(/\s+-\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 24);

  if (candidateItems.length >= 2) {
    return `<ul style="margin:0;padding-left:1.05rem;color:#2f3a45;font-size:0.82rem;line-height:1.45">${candidateItems
      .slice(0, 3)
      .map((item) => renderSummaryItem(item))
      .join("")}</ul>`;
  }

  return `<p style="margin:0;color:#2f3a45;font-size:0.82rem;line-height:1.5"><span style="font-weight:700;color:#23313d">Summary</span><span style="color:#4d5965">: ${esc(normalized)}</span></p>`;
}

function buildLinksHtml(links?: Array<{ url: string; label: string }>): string {
  if (!links?.length) return "";
  return `
    <div style="margin-top:10px">
      <div style="font-size:0.72rem;font-weight:700;color:#62707c;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Resource Links</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 8px">
        ${links
          .map((link) => buildLinkButton(link.url, link.label))
          .join("")}
      </div>
    </div>`;
}

function isPreviewImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url) || /thumbnail|preview|browse|quicklook/i.test(url);
}

function findPreviewImageUrl(ctx?: GeoContext): string | null {
  const fieldMatch = ctx?.mcpFields?.find((field) => /thumbnail|preview|image/i.test(field.label) && /^https?:\/\//i.test(field.value));
  if (fieldMatch) return fieldMatch.value;

  const linkMatch = ctx?.links?.find((link) => isPreviewImageUrl(link.url) || /thumbnail|preview|image/i.test(link.label));
  return linkMatch?.url ?? null;
}

function buildImageCardHtml(ctx?: GeoContext): string {
  const imageUrl = findPreviewImageUrl(ctx);
  if (!imageUrl) return "";

  return `
    <div style="margin-top:10px">
      <div style="font-size:0.72rem;font-weight:700;color:#62707c;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Preview</div>
      <a href="${esc(imageUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none">
        <img src="${esc(imageUrl)}" alt="Preview image" loading="lazy" referrerpolicy="no-referrer" style="display:block;width:100%;max-width:260px;max-height:180px;object-fit:cover;border-radius:10px;border:1px solid #d8dde3;background:#f4f6f8" onerror="this.style.display='none'" />
      </a>
    </div>`;
}

function pointSymbolFor(pt: GeoPoint) {
  return pt.origin === "source"
    ? POINT_SYMBOL
    : CONTEXT_POINT_SYMBOL;
}

function normalizePlaceKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function placeKeysMatch(left: string, right: string): boolean {
  const leftKey = normalizePlaceKey(left);
  const rightKey = normalizePlaceKey(right);
  if (!leftKey || !rightKey) return false;
  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function createRenderLayerCollection(origin: GeoOrigin): RenderLayerCollection {
  return {
    prefix: origin === "source" ? MCP_GEO_SOURCE_LAYER_ID : MCP_GEO_CONTEXT_LAYER_ID,
    label: origin === "source" ? "Source" : "Context",
    layers: new Map<string, { id: string; title: string; geometryType: "point" | "polygon"; renderer: any; graphics: Graphic[] }>(),
    order: [],
  };
}

function ensureRenderLayer(
  collection: RenderLayerCollection,
  key: string,
  title: string,
  geometryType: "point" | "polygon",
  symbol: any,
): { id: string; title: string; geometryType: "point" | "polygon"; renderer: any; graphics: Graphic[] } {
  const existing = collection.layers.get(key);
  if (existing) return existing;

  const layer = {
    id: `${collection.prefix}-${key}`,
    title: `${collection.label} ${title}`,
    geometryType,
    renderer: {
      type: "simple",
      symbol,
    },
    graphics: [],
  };
  collection.layers.set(key, layer);
  collection.order.push(key);
  return layer;
}

function collectionLayers(collection: RenderLayerCollection): Array<{ id: string; title: string; geometryType: "point" | "polygon"; renderer: any; graphics: Graphic[] }> {
  return collection.order
    .map((key) => collection.layers.get(key))
    .filter((layer): layer is { id: string; title: string; geometryType: "point" | "polygon"; renderer: any; graphics: Graphic[] } => Boolean(layer));
}

function buildLayerFields(): Array<{ name: string; alias: string; type: "oid" | "string" }> {
  return [
    { name: "OBJECTID", alias: "OBJECTID", type: "oid" },
    { name: "name", alias: "name", type: "string" },
    { name: "_popupTitle", alias: "_popupTitle", type: "string" },
    { name: "_popupContentHtml", alias: "_popupContentHtml", type: "string" },
  ];
}

async function createRenderFeatureLayer(layer: { id: string; title: string; geometryType: "point" | "polygon"; renderer: any; graphics: Graphic[] }): Promise<FeatureLayer | null> {
  if (!layer.graphics.length) return null;

  const source = layer.graphics.map((graphic, index) => {
    const popupTitle = typeof graphic.popupTemplate?.title === "string"
      ? graphic.popupTemplate.title
      : String(graphic.attributes?.name ?? layer.title);
    const popupContentHtml = typeof graphic.popupTemplate?.content === "string"
      ? graphic.popupTemplate.content
      : "";
    const attributes = {
      OBJECTID: index + 1,
      name: String(graphic.attributes?.name ?? layer.title),
      _popupTitle: popupTitle,
      _popupContentHtml: popupContentHtml,
    };
    return new Graphic({
      geometry: graphic.geometry,
      attributes,
    });
  });

  return new FeatureLayer({
    id: layer.id,
    title: layer.title,
    listMode: "show",
    legendEnabled: true,
    source,
    objectIdField: "OBJECTID",
    fields: buildLayerFields(),
    displayField: "name",
    geometryType: layer.geometryType,
    spatialReference: { wkid: 4326 },
    renderer: layer.renderer,
    outFields: ["*"],
    popupEnabled: true,
    popupTemplate: {
      title: "{_popupTitle}",
      content: (feature: any) => String(feature?.graphic?.attributes?._popupContentHtml ?? ""),
    } as any,
  } as any);
}

async function nonEmptyCollectionLayers(collection: RenderLayerCollection): Promise<FeatureLayer[]> {
  const layers = await Promise.all(collectionLayers(collection).map((layer) => createRenderFeatureLayer(layer)));
  return layers.filter((layer): layer is FeatureLayer => Boolean(layer));
}

function collectionGraphics(collection: RenderLayerCollection): Graphic[] {
  return collectionLayers(collection).flatMap((layer) => layer.graphics);
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
  return `<div style="display:flex;flex-direction:column;gap:6px">` +
    visible.map((row) => `<div style="font-size:0.83rem;line-height:1.45"><span style="font-weight:700;color:#23313d">${esc(row.label)}</span><span style="color:#4d5965">: ${esc(formatDisplayValue(row.value))}</span></div>`).join("") +
    `</div>`;
}

/** Render the MCP data section: structured fields + source links + summary */
function buildContextHtml(ctx?: GeoContext): string {
  if (!ctx?.summary && !ctx?.links?.length && !ctx?.mcpFields?.length) return "";

  const fieldsHtml = ctx.mcpFields?.length
    ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">` +
      ctx.mcpFields.map((field) => {
        const url = reconstructUrlFromField(field.label, field.value);
        if (url) {
          const label = /^(?:https?)$/i.test(field.label.trim()) ? "Resource Link" : field.label;
          return `<div style="font-size:0.82rem;line-height:1.45"><span style="font-weight:700;color:#23313d">${esc(label)}</span><span style="color:#4d5965">: </span>${buildLinkButton(url, field.value)}</div>`;
        }
        return `<div style="font-size:0.82rem;line-height:1.45"><span style="font-weight:700;color:#23313d">${esc(field.label)}</span><span style="color:#4d5965">: ${esc(field.value)}</span></div>`;
      }).join("") +
      `</div>`
    : "";

  const summaryHtml = buildSummaryHtml(ctx.summary);
  const linksHtml = buildLinksHtml(ctx.links);
  const imageHtml = buildImageCardHtml(ctx);
  const heading = "Supporting Context";

  return `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e7ec">
      <div style="font-size:0.74rem;font-weight:700;color:#62707c;text-transform:uppercase;
                  letter-spacing:0.05em;margin-bottom:7px">${esc(heading)}</div>
      ${imageHtml}${fieldsHtml}${summaryHtml}${linksHtml}
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
  const summaryBadge = badge(pt.origin === "source" ? "Source point" : "Context point", "accent");
  const desc = pt.description ? `<p style="margin:8px 0 0;font-size:0.84rem;color:#2f3a45;line-height:1.45">${esc(pt.description)}</p>` : "";
  const metadata = buildRows([
    { label: "Place", value: pt.label },
    { label: "Geometry", value: pt.origin === "source" ? "Source-derived point" : "Context-derived point" },
    { label: "Lat / Lon", value: `${pt.lat.toFixed(4)}°, ${pt.lon.toFixed(4)}°` },
  ]);

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);font-size:0.88rem;line-height:1.5">
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${summaryBadge}</div>
      ${desc}
      ${buildContextHtml(pt.context)}
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e7ec">${metadata}</div>
    </div>`;
}

function buildExtentPopupContent(extent: GeoExtent): string {
  const summaryBadge = badge("Extent", "accent");
  const originBadge = badge(extent.origin === "source" ? "Map footprint" : "Context geometry");
  const desc = extent.description ? `<p style="margin:8px 0 0;font-size:0.84rem;color:#2f3a45;line-height:1.45">${esc(extent.description)}</p>` : "";
  const bounds = buildRows([
    { label: "West / South", value: `${extent.west.toFixed(4)}, ${extent.south.toFixed(4)}` },
    { label: "East / North", value: `${extent.east.toFixed(4)}, ${extent.north.toFixed(4)}` },
  ]);

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);font-size:0.88rem;line-height:1.5">
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${summaryBadge}${originBadge}</div>
      ${desc}
      ${buildContextHtml(extent.context)}
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e7ec">
        ${bounds}
      </div>
    </div>`;
}

function bboxToPolygon(extent: GeoExtent): Polygon {
  return new Polygon({
    spatialReference: { wkid: 4326 },
    rings: [[
      [extent.west, extent.south],
      [extent.east, extent.south],
      [extent.east, extent.north],
      [extent.west, extent.north],
      [extent.west, extent.south],
    ]],
  });
}

function extentGraphic(extent: GeoExtent): Graphic | null {
  if (
    [extent.west, extent.south, extent.east, extent.north].some((value) => !Number.isFinite(value)) ||
    Math.abs(extent.west) > 180 ||
    Math.abs(extent.east) > 180 ||
    Math.abs(extent.south) > 90 ||
    Math.abs(extent.north) > 90 ||
    extent.west >= extent.east ||
    extent.south >= extent.north
  ) {
    return null;
  }

  return new Graphic({
    geometry: bboxToPolygon(extent),
    symbol: EXTENT_SYMBOL as any,
    attributes: { name: buildExtentPopupTitle(extent) },
    popupTemplate: {
      title: buildExtentPopupTitle(extent),
      content: buildExtentPopupContent(extent),
    } as any,
  });
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
      title: String(name),
      content: buildCountryPopupContent(attrs, entity?.context),
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

  clearMcpGeoLayer();

  const sourceCollection = createRenderLayerCollection("source");
  const contextCollection = createRenderLayerCollection("context");

  const sourceEntities = entities.filter((entity) => entity.origin === "source");
  const contextEntities = entities.filter((entity) => entity.origin === "context");

  async function addEntitiesToCollection(targetCollection: RenderLayerCollection, layerEntities: GeoEntity[]): Promise<void> {
    const countries = layerEntities.filter((e): e is GeoCountry => e.kind === "country");
    const regions = layerEntities.filter((e): e is GeoRegion => e.kind === "region");
    const namedPlaces = layerEntities.filter((e): e is GeoNamedPlace => e.kind === "named");
    const extents = layerEntities.filter((e): e is GeoExtent => e.kind === "extent");
    const points = layerEntities.filter((e): e is GeoPoint => e.kind === "point");
    const polygonEntityCount = countries.length + regions.length + namedPlaces.length;
    const hasExplicitGeometry = points.length > 0 || extents.length > 0 || countries.length > 0 || regions.length > 0;
    const areaPlaceNames = [
      ...countries.map((entity) => entity.name),
      ...regions.map((entity) => entity.name),
      ...namedPlaces.map((entity) => entity.name),
    ];
    const filteredPoints = polygonEntityCount > 0
      ? points.filter((point) => !areaPlaceNames.some((name) => placeKeysMatch(point.label, name)))
      : points;

    for (const extent of extents) {
      const g = extentGraphic(extent);
      if (g) ensureRenderLayer(targetCollection, "extents", "Extents", "polygon", EXTENT_SYMBOL).graphics.push(g);
    }

    for (const pt of filteredPoints) {
      const g = new Graphic({
        geometry: new Point({ latitude: pt.lat, longitude: pt.lon }),
        symbol: pointSymbolFor(pt) as any,
        attributes: { name: pt.label },
        popupTemplate: {
          title: pt.label,
          content: buildPointPopupContent(pt),
        } as any,
      });
      ensureRenderLayer(targetCollection, "points", "Points", "point", pointSymbolFor(pt)).graphics.push(g);
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
        if (g) ensureRenderLayer(targetCollection, "countries", "Countries", "polygon", COUNTRY_SYMBOL).graphics.push(g);
      }
    }

    if (regions.length) {
      const list = regions
        .map((r) => `'${r.name.replace(/'/g, "''")}'`)
        .join(",");
      const features = await queryLayer(LAYER_REGION, `REGION IN (${list})`);
      for (const feat of features) {
        const featureRegion = String(feat.attributes?.REGION ?? "");
        const entity = regions.find((r) => r.name === featureRegion);
        const g = regionFeatureToGraphic(feat, entity);
        if (g) ensureRenderLayer(targetCollection, "regions", "Regions", "polygon", REGION_SYMBOL).graphics.push(g);
      }
    }

    if (namedPlaces.length && !hasExplicitGeometry) {
      const candidateGroups = namedPlaces.map((entity) => ({
        entity,
        candidates: buildNamedPlaceCandidates(entity.name),
      }));
      const resolvedGroups = new Set<number>();

      const countryNames = [...new Set(candidateGroups.flatMap((group) => group.candidates))];
      if (countryNames.length) {
        const list = countryNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
        const features = await queryLayer(LAYER_COUNTRY, `NAME IN (${list})`);
        for (const feat of features) {
          const featureName = String(feat.attributes?.NAME ?? "").trim().toLowerCase();
          const matchedIndex = candidateGroups.findIndex((group) =>
            group.candidates.some((candidate) => candidate.toLowerCase() === featureName),
          );
          const matched = matchedIndex >= 0 ? candidateGroups[matchedIndex] : null;
          if (!matched) continue;
          resolvedGroups.add(matchedIndex);
          const countryEntity: GeoCountry = {
            kind: "country",
            origin: matched.entity.origin,
            name: String(feat.attributes?.NAME ?? matched.entity.name),
            description: matched.entity.description,
            context: matched.entity.context,
          };
          const g = countryFeatureToGraphic(feat, countryEntity);
          if (g) ensureRenderLayer(targetCollection, "countries", "Countries", "polygon", COUNTRY_SYMBOL).graphics.push(g);
        }
      }

      const regionNames = [...new Set(candidateGroups.flatMap((group) => group.candidates))];
      if (regionNames.length) {
        const list = regionNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
        const features = await queryLayer(LAYER_REGION, `REGION IN (${list})`);
        for (const feat of features) {
          const featureRegion = String(feat.attributes?.REGION ?? "");
          const matchedIndex = candidateGroups.findIndex((group) =>
            group.candidates.some((candidate) => candidate === featureRegion),
          );
          const matched = matchedIndex >= 0 ? candidateGroups[matchedIndex] : null;
          if (!matched) continue;
          resolvedGroups.add(matchedIndex);
          const regionEntity: GeoRegion = {
            kind: "region",
            origin: matched.entity.origin,
            name: String(feat.attributes?.REGION ?? matched.entity.name),
            description: matched.entity.description,
            context: matched.entity.context,
          };
          const g = regionFeatureToGraphic(feat, regionEntity);
          if (g) ensureRenderLayer(targetCollection, "regions", "Regions", "polygon", REGION_SYMBOL).graphics.push(g);
        }
      }

      for (let index = 0; index < candidateGroups.length; index += 1) {
        if (resolvedGroups.has(index)) continue;
        const group = candidateGroups[index];
        const preferredCandidate = group.candidates[0] ?? group.entity.name;
        const geocoded = await geocodeSingleLine(preferredCandidate);
        if (!geocoded) continue;

        const pointEntity: GeoPoint = {
          kind: "point",
          origin: group.entity.origin,
          label: geocoded.label || group.entity.name,
          lat: geocoded.latitude,
          lon: geocoded.longitude,
          description: group.entity.description,
          context: group.entity.context,
        };

        const g = new Graphic({
          geometry: new Point({ latitude: pointEntity.lat, longitude: pointEntity.lon }),
          symbol: pointSymbolFor(pointEntity) as any,
          attributes: { name: pointEntity.label },
          popupTemplate: {
            title: pointEntity.label,
            content: buildPointPopupContent(pointEntity),
          } as any,
        });
        ensureRenderLayer(targetCollection, "points", "Points", "point", pointSymbolFor(pointEntity)).graphics.push(g);
      }
    }
  }

  const loadingTasks = [
    addEntitiesToCollection(sourceCollection, sourceEntities),
    addEntitiesToCollection(contextCollection, contextEntities),
  ];

  await Promise.all(loadingTasks);

  const layersToAdd = [
    ...(await nonEmptyCollectionLayers(sourceCollection)),
    ...(await nonEmptyCollectionLayers(contextCollection)),
  ];
  if (!layersToAdd.length) return;

  const group = new GroupLayer({
    id: MCP_GEO_LAYER_ID,
    title: "MCP Results",
    listMode: "show",
    visibilityMode: "independent",
    layers: layersToAdd,
  });
  view.map.add(group);

  const allGraphics = [
    ...collectionGraphics(sourceCollection),
    ...collectionGraphics(contextCollection),
  ];
  if (allGraphics.length) {
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
  const idsToRemove = new Set<string>([
    MCP_GEO_LAYER_ID,
    MCP_GEO_SOURCE_LAYER_ID,
    MCP_GEO_CONTEXT_LAYER_ID,
  ]);
  const layers = view.map.layers?.toArray?.() ?? [];
  for (const layer of layers) {
    const layerId = String(layer?.id ?? "");
    if (
      idsToRemove.has(layerId)
      || layerId.startsWith(`${MCP_GEO_SOURCE_LAYER_ID}-`)
      || layerId.startsWith(`${MCP_GEO_CONTEXT_LAYER_ID}-`)
    ) {
      view.map.remove(layer);
    }
  }
}

function buildNamedPlaceCandidates(raw: string): string[] {
  const cleaned = raw
    .replace(/^\d+\s*[.)-]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const values = new Set<string>([cleaned]);
  const withoutParens = cleaned.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (withoutParens) values.add(withoutParens);

  for (const part of cleaned.split(",").map((value) => value.trim()).filter(Boolean)) {
    values.add(part);
  }

  return [...values].filter((value) => value.length >= 2 && value.length <= 120);
}
