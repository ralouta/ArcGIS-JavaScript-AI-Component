/**
 * mcpGeoJsonSynthesizer
 *
 * Converts arbitrary MCP server output into a structured list of features
 * ready for ArcGIS map rendering using a zero-LLM fast path:
 *
 *  1. Parse each tool output text with safeParseJson.
 *  2. Recursively search the parsed object for any GeoJSON FeatureCollection
 *     or Feature (handles custom server envelopes like {status:"ok",data:{...}}).
 *  3. Convert matched features to SynthesizedFeature records.
 *  4. Return null if nothing found — caller falls back to entity pipeline.
 */

import { inferLayerGroupFromFeature } from "./mcpLayerGroups";
import { MAX_SYNTHESIZED_FEATURES } from "./arcgisConfig";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SynthGeometryType =
  | "Point"
  | "LineString"
  | "Polygon"
  | "MultiPoint"
  | "MultiLineString"
  | "MultiPolygon"
  | "none";

export type RenderHint = "point" | "line" | "polygon";

export interface SynthesizedFeature {
  title: string;
  description?: string;
  geometryType: SynthGeometryType;
  /** Flat [lon,lat] for Point; [[lon,lat],...] for Line; [[[lon,lat],...]] for Polygon */
  coordinates?: unknown;
  /** When set the renderer should geocode this term and create a Point at the result */
  geocodeTerm?: string;
  /** All original MCP data fields — shown in the popup */
  properties: Record<string, unknown>;
  renderHint: RenderHint;
  /** Semantic layer group — determines which sub-layer this feature lands in */
  layerGroup?: string;
  /** Direct thumbnail / preview image URL (STAC assets, MCP image endpoints) */
  imageUrl?: string;
}

export interface SynthesizedGeoResult {
  features: SynthesizedFeature[];
  /** True when ≥1 feature has explicit (non-geocode) coordinates */
  hasExplicitGeometry: boolean;
}

const MAX_STAC_URL_FETCHES = 8;

// ── System Prompt ─────────────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch {}
  // Code-fenced JSON block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1]); } catch {} }
  return undefined;
}

function extractEmbeddedJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const seen = new Set<string>();

  const pushCandidate = (snippet: string): void => {
    const trimmed = snippet.trim();
    if (!trimmed || seen.has(trimmed)) return;
    try {
      candidates.push(JSON.parse(trimmed));
      seen.add(trimmed);
    } catch {
      // Ignore non-JSON substrings.
    }
  };

  const whole = safeParseJson(text);
  if (whole !== undefined) {
    candidates.push(whole);
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        pushCandidate(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function normalizeCandidateUrl(raw: string): string {
  return raw.replace(/[),.;]+$/g, "").trim();
}

function extractStacItemUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'<>]+\/collections\/[^\s"'<>/]+\/items\/[^\s"'<>/]+(?:\?[^\s"'<>]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const normalized = normalizeCandidateUrl(match[0]);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  return urls;
}

function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s"'<>]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const normalized = normalizeCandidateUrl(match[0]);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  return urls;
}

function isDirectImageUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/\S+/i.test(url) && /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(url);
}

function hasImageMediaType(value: unknown): boolean {
  return typeof value === "string" && /^image\//i.test(value.trim());
}

function gatherFeatureSearchTerms(feature: SynthesizedFeature): string[] {
  const terms = new Set<string>();

  const push = (value: unknown): void => {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text || text.length < 4) return;
    terms.add(text);
  };

  push(feature.title);
  push(feature.properties.id);
  push(feature.properties.name);
  push(feature.properties.title);
  push(feature.properties.label);
  push(feature.properties.datetime);
  push(feature.properties.product_id);
  push(feature.properties.safe_name);
  push(feature.properties.identifier);

  return [...terms];
}

function enrichFeaturesWithImageUrls(
  features: SynthesizedFeature[],
  texts: string[],
): SynthesizedFeature[] {
  if (!features.length) return features;

  const contexts = texts
    .flatMap((text) => text.split(/\n+/))
    .map((line) => line.trim())
    .filter(Boolean);
  const allImageUrls = extractImageUrls(texts.join("\n\n"));

  let fallbackIndex = 0;

  return features.map((feature) => {
    if (feature.imageUrl) return feature;

    const searchTerms = gatherFeatureSearchTerms(feature);
    const matchingContext = contexts.find((line) => {
      const lower = line.toLowerCase();
      return searchTerms.some((term) => lower.includes(term)) && extractImageUrls(line).length > 0;
    });

    const matchedImage = matchingContext
      ? extractImageUrls(matchingContext)[0]
      : allImageUrls.length === features.length
        ? allImageUrls[fallbackIndex++]
        : features.length === 1 && allImageUrls.length === 1
          ? allImageUrls[0]
          : undefined;

    return matchedImage
      ? { ...feature, imageUrl: matchedImage }
      : feature;
  });
}

function isValidLon(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= -180 && v <= 180;
}

function isValidLat(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= -90 && v <= 90;
}

export function renderHintFor(type: string): RenderHint {
  if (type === "LineString" || type === "MultiLineString") return "line";
  if (type === "Polygon" || type === "MultiPolygon") return "polygon";
  return "point";
}

// ── Fast path: detect raw GeoJSON in tool outputs ────────────────────────────

/** Extract a preview/thumbnail image URL from a raw GeoJSON feature object. */
function extractImageUrl(feature: any): string | undefined {
  const assets: Record<string, any> = feature.assets ?? {};
  const links: any[] = feature.links ?? [];
  const props: Record<string, any> = feature.properties ?? {};

  // STAC assets (thumbnail → overview/rendered_preview → visual)
  for (const key of ["thumbnail", "overview", "rendered_preview", "visual"]) {
    const href = assets[key]?.href;
    const mediaType = assets[key]?.type ?? assets[key]?.mediaType ?? assets[key]?.mimeType;
    if (isDirectImageUrl(href) || (typeof href === "string" && /^https?:\/\//i.test(href) && hasImageMediaType(mediaType))) {
      return href;
    }
  }

  // STAC links with image rel
  for (const link of links) {
    if (
      typeof link?.href === "string" &&
      /^https?:\/\//i.test(link.href) &&
      ["thumbnail", "preview", "overview"].includes(link?.rel) &&
      (isDirectImageUrl(link.href) || hasImageMediaType(link?.type ?? link?.mediaType ?? link?.mimeType))
    ) {
      return link.href;
    }
  }

  // Direct property image URLs
  for (const key of [
    "thumbnail_url", "image_url", "preview_url", "photo_url",
    "thumbnail", "preview", "picture", "icon", "image",
  ]) {
    const val = props[key];
    if (isDirectImageUrl(val)) return val;
  }
  return undefined;
}

/** Infer the layer group for a raw GeoJSON feature based on its content. */
function inferLayerGroup(feature: any): string {
  const props: Record<string, any> = feature.properties ?? {};
  const assets = feature.assets ?? {};
  const combined = [
    ...Object.keys(assets),
    ...Object.entries(props).map(([k, v]) => `${k} ${String(v ?? "")}`),
  ]
    .join(" ")
    .toLowerCase();
  return inferLayerGroupFromFeature(
    combined,
    String(feature?.geometry?.type ?? ""),
    Object.keys(assets),
  );
}

/**
 * Convert a STAC / GeoJSON bbox array [west,south,east,north] to a closed
 * Polygon ring so features with geometry:null can still be rendered.
 */
function bboxToPolygonRings(bbox: number[]): Array<Array<[number, number]>> | null {
  if (bbox.length < 4) return null;
  const [w, s, e, n] = bbox;
  if (!isValidLon(w) || !isValidLat(s) || !isValidLon(e) || !isValidLat(n)) return null;
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
}

function extentToPolygonRings(extent: Record<string, unknown>): Array<Array<[number, number]>> | null {
  const xmin = Number(extent.xmin);
  const ymin = Number(extent.ymin);
  const xmax = Number(extent.xmax);
  const ymax = Number(extent.ymax);
  if (!isValidLon(xmin) || !isValidLat(ymin) || !isValidLon(xmax) || !isValidLat(ymax)) return null;
  return [[[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin]]];
}

function toSynthFeature(
  source: any,
  geometryType: SynthGeometryType,
  coordinates: unknown,
): SynthesizedFeature {
  const props: Record<string, unknown> = source.properties && typeof source.properties === "object"
    ? { ...(source.properties as Record<string, unknown>) }
    : {};

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (["type", "geometry", "coordinates", "bbox", "extent", "properties"].includes(key)) continue;
    if (props[key] == null) props[key] = value;
  }

  const title = String(
    props.name ?? props.title ?? props.label ?? props.id ?? source.id ?? "Feature",
  ).trim() || "Feature";
  const description = props.description ?? props.summary ?? props.desc;

  return {
    title,
    description: description ? String(description) : undefined,
    geometryType,
    coordinates,
    properties: props,
    renderHint: renderHintFor(geometryType),
    layerGroup: inferLayerGroup(source),
    imageUrl: extractImageUrl(source),
  };
}

function convertGeoJsonFeature(f: any): SynthesizedFeature | null {
  let geomType: string = f?.geometry?.type ?? "";
  const validTypes = ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon"];

  // STAC items often have geometry:null but carry a bbox — synthesise a
  // footprint polygon from it so users immediately see the tile extents.
  let coordinates: unknown = f?.geometry?.coordinates ?? undefined;
  if ((!validTypes.includes(geomType) || !coordinates) && Array.isArray(f?.bbox)) {
    const rings = bboxToPolygonRings(f.bbox as number[]);
    if (rings) {
      geomType = "Polygon";
      coordinates = rings;
    }
  }

  if (!validTypes.includes(geomType) || !coordinates) return null;

  const props: Record<string, unknown> = f.properties ?? {};
  const title = String(
    props.name ?? props.title ?? props.label ?? props.id ?? f.id ?? "Feature"
  ).trim() || "Feature";
  const description = props.description ?? props.summary ?? props.desc;

  return {
    title,
    description: description ? String(description) : undefined,
    geometryType: geomType as SynthGeometryType,
    coordinates,
    properties: { ...props },
    renderHint: renderHintFor(geomType),
    layerGroup: inferLayerGroup(f),
    imageUrl: extractImageUrl(f),
  };
}

function convertSpatialObject(value: unknown): SynthesizedFeature | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const geomType = typeof (obj.geometry as any)?.type === "string" ? String((obj.geometry as any).type) : "";
  const coords = (obj.geometry as any)?.coordinates;
  if (["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon"].includes(geomType) && coords) {
    return toSynthFeature(obj, geomType as SynthGeometryType, coords);
  }

  if (Array.isArray(obj.bbox)) {
    const rings = bboxToPolygonRings(obj.bbox as number[]);
    if (rings) {
      return toSynthFeature(obj, "Polygon", rings);
    }
  }

  if (obj.extent && typeof obj.extent === "object") {
    const rings = extentToPolygonRings(obj.extent as Record<string, unknown>);
    if (rings) {
      return toSynthFeature(obj, "Polygon", rings);
    }
  }

  return null;
}

function featureKey(feature: SynthesizedFeature): string {
  return [
    feature.title,
    feature.geometryType,
    JSON.stringify(feature.coordinates ?? null),
    feature.geocodeTerm ?? "",
    feature.layerGroup ?? "",
  ].join("|");
}

function appendUniqueFeatures(target: SynthesizedFeature[], incoming: SynthesizedFeature[]): void {
  const seen = new Set(target.map(featureKey));
  for (const feature of incoming) {
    const key = featureKey(feature);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(feature);
    if (target.length >= MAX_SYNTHESIZED_FEATURES) return;
  }
}

/**
 * Recursively search an already-parsed JSON value for GeoJSON FeatureCollections
 * and Features. Handles MCP server responses that wrap results in a custom
 * envelope (e.g. {status:"ok", data:{type:"FeatureCollection",...}}).
 *
 * depth is capped to avoid scanning deeply-nested STAC property objects.
 */
function collectGeoResults(
  value: unknown,
  collected: SynthesizedFeature[],
  depth = 0,
): void {
  if (depth > 5 || value == null || typeof value !== "object") return;
  if (collected.length >= MAX_SYNTHESIZED_FEATURES) return;

  if (Array.isArray(value)) {
    const directFeatures = (value as any[])
      .filter((f) => f?.type === "Feature" && (
        (f?.geometry?.type && f?.geometry?.coordinates) ||
        Array.isArray(f?.bbox)
      ))
      .slice(0, MAX_SYNTHESIZED_FEATURES - collected.length)
      .map(convertGeoJsonFeature)
      .filter((f): f is SynthesizedFeature => f !== null);
    if (directFeatures.length) {
      appendUniqueFeatures(collected, directFeatures);
    }

    for (const item of (value as unknown[]).slice(0, 30)) {
      if (collected.length >= MAX_SYNTHESIZED_FEATURES) return;
      if ((item as any)?.type === "Feature") continue;
      collectGeoResults(item, collected, depth + 1);
    }
    return;
  }

  const obj = value as Record<string, unknown>;

  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    const features = (obj.features as any[])
      .filter((f) => f?.type === "Feature" && (
        (f?.geometry?.type && f?.geometry?.coordinates) ||
        Array.isArray(f?.bbox)
      ))
      .slice(0, MAX_SYNTHESIZED_FEATURES - collected.length)
      .map(convertGeoJsonFeature)
      .filter((f): f is SynthesizedFeature => f !== null);
    if (features.length) {
      appendUniqueFeatures(collected, features);
    }
    return;
  }

  if (obj.type === "Feature" && (obj as any)?.geometry?.type) {
    const feature = convertGeoJsonFeature(obj);
    if (feature) appendUniqueFeatures(collected, [feature]);
    return;
  }

  const spatialObjectFeature = convertSpatialObject(obj);
  if (spatialObjectFeature) {
    appendUniqueFeatures(collected, [spatialObjectFeature]);
  }

  if (depth < 4) {
    for (const val of Object.values(obj)) {
      if (collected.length >= MAX_SYNTHESIZED_FEATURES) return;
      if (!val || typeof val !== "object") continue;
      collectGeoResults(val, collected, depth + 1);
    }
  }
}

function tryDirectGeoJson(toolOutputTexts: string[]): SynthesizedGeoResult | null {
  const collected: SynthesizedFeature[] = [];
  for (const text of toolOutputTexts) {
    if (collected.length >= MAX_SYNTHESIZED_FEATURES) break;
    const candidates = extractEmbeddedJsonCandidates(text);
    for (const candidate of candidates) {
      if (collected.length >= MAX_SYNTHESIZED_FEATURES) break;
      collectGeoResults(candidate, collected);
    }
  }
  return collected.length
    ? { features: enrichFeaturesWithImageUrls(collected, toolOutputTexts), hasExplicitGeometry: true }
    : null;
}

async function tryHydrateGeoFromStacItemUrls(
  texts: string[],
): Promise<SynthesizedGeoResult | null> {
  const collected: SynthesizedFeature[] = [];
  const urls = texts.flatMap(extractStacItemUrls).slice(0, MAX_STAC_URL_FETCHES);
  if (!urls.length) return null;

  await Promise.all(
    urls.map(async (url) => {
      if (collected.length >= MAX_SYNTHESIZED_FEATURES) return;
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/geo+json, application/json;q=0.9, */*;q=0.1",
          },
        });
        if (!response.ok) return;
        const json = await response.json();
        const features: SynthesizedFeature[] = [];
        collectGeoResults(json, features);
        if (!features.length) return;
        const enriched = enrichFeaturesWithImageUrls(features, [url, ...texts]).map((feature) => ({
          ...feature,
          properties: {
            item_url: url,
            ...feature.properties,
          },
        }));
        appendUniqueFeatures(collected, enriched);
      } catch {
        // Ignore fetch/parse failures and continue with any other URLs.
      }
    }),
  );

  return collected.length ? { features: collected, hasExplicitGeometry: true } : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Synthesizes a GeoJSON-style feature list from raw MCP tool outputs.
 *
 * Uses only the zero-LLM fast path: scans each tool output for GeoJSON
 * FeatureCollections/Features (including deeply nested inside server envelopes).
 * Returns null if nothing found — caller falls back to entity pipeline.
 */
export async function synthesizeGeoJson(
  toolOutputTexts: string[],
  _toolArgsList: Record<string, unknown>[],
  responseText: string,
): Promise<SynthesizedGeoResult | null> {
  if (!toolOutputTexts.length) return null;

  const result = tryDirectGeoJson(toolOutputTexts);
  if (result) {
    console.debug(
      "[Synthesizer] fast path hit:",
      result.features.length,
      "features",
      result.features.map((f) => `${f.title}[${f.geometryType}/${f.layerGroup ?? "?"}]`)
    );
    return result;
  }

  const hydrated = await tryHydrateGeoFromStacItemUrls([
    ...toolOutputTexts,
    responseText,
  ]);
  if (hydrated) {
    console.debug(
      "[Synthesizer] hydrated STAC item URLs:",
      hydrated.features.length,
      "features",
      hydrated.features.map((f) => `${f.title}[${f.geometryType}/${f.layerGroup ?? "?"}]`),
    );
    return hydrated;
  }

  console.debug("[Synthesizer] no GeoJSON found in tool outputs");
  return null;
}
