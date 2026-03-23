/**
 * mcpArbitraryRenderer
 *
 * Renders a SynthesizedGeoResult (produced by mcpGeoJsonSynthesizer) onto the
 * active ArcGIS MapView.  Handles every GeoJSON geometry type:
 *   Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
 *
 * Features with `geocodeTerm` instead of explicit coordinates are resolved via
 * the ArcGIS World Geocoder and rendered as Point markers.
 *
 * Navigation strategy:
 *   1. Navigate to explicit-geometry graphics immediately (fast visual feedback).
 *   2. Resolve geocode features in parallel, add to layer, re-navigate once.
 *
 * The layer uses the shared MCP_GEO_LAYER_ID so it always replaces any
 * previously rendered MCP result (from this renderer OR the entity renderer).
 */

import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import GroupLayer from "@arcgis/core/layers/GroupLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import Polygon from "@arcgis/core/geometry/Polygon";
import { MCP_GEO_LAYER_ID } from "./mcpGeoRenderer";
import type { SynthesizedFeature, SynthesizedGeoResult } from "./mcpGeoJsonSynthesizer";
import { rgbForGroup, LAYER_GROUPS } from "./mcpLayerGroups";
import { GEOCODER_URL, MAP_ELEMENT_SELECTOR } from "./arcgisConfig";

type SymbolTier = "high" | "medium" | "low";

// ── Symbols ───────────────────────────────────────────────────────────────────

function symbolForFeature(
  feature: SynthesizedFeature,
  tier: SymbolTier,
  isGeocoded = false,
): any {
  const rgb = rgbForGroup(feature.layerGroup);
  const opacity  = tier === "high" ? 0.95 : tier === "medium" ? 0.82 : 0.42;
  const markerSz = tier === "high" ? 16   : tier === "medium" ? 13   : 9;

  if (feature.renderHint === "line") {
    return {
      type: "simple-line",
      color: [...rgb, opacity],
      width: tier === "high" ? 3.4 : tier === "medium" ? 2.4 : 1.5,
      style: "solid",
    };
  }

  if (feature.renderHint === "polygon") {
    const fillOpacity = tier === "high" ? 0.22 : tier === "medium" ? 0.14 : 0.07;
    return {
      type: "simple-fill",
      color: [...rgb, fillOpacity],
      outline: { color: [...rgb, opacity], width: tier === "high" ? 2.2 : 1.6 },
    };
  }

  return {
    type: "simple-marker",
    style: isGeocoded ? "diamond" : "circle",
    color: [...rgb, opacity],
    size: isGeocoded ? markerSz - 1 : markerSz,
    outline: { color: [255, 255, 255, 0.95], width: 2 },
  };
}

// ── Popup builder ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CL = `style="color:#888;padding:2px 10px 2px 0;white-space:nowrap;font-size:0.82rem"`;
const CV = `style="font-weight:500;font-size:0.88rem"`;

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const s = String(value).trim();
  // Linkify bare URLs
  if (/^https?:\/\//.test(s)) {
    const label = (() => {
      try {
        return new URL(s).hostname.replace(/^www\./, "");
      } catch {
        return s.slice(0, 40);
      }
    })();
    return `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer"
      style="color:#005e95;font-size:0.82rem">${esc(label)}</a>`;
  }
  return esc(s);
}

function buildPopupContent(
  feature: SynthesizedFeature,
  tier: SymbolTier,
  isGeocoded = false,
): string {
  const desc = feature.description?.trim();

  // ── Image card (STAC thumbnails / MCP preview URLs) ─────────────────────────
  const imageHtml = feature.imageUrl
    ? `<figure style="margin:0 0 12px;border-radius:14px;overflow:hidden;border:1px solid #d9e5ee;background:linear-gradient(180deg,#f8fbfd 0%,#eef5f9 100%);box-shadow:0 10px 24px rgba(39,77,102,0.10)">
         <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid #e2edf3;background:rgba(255,255,255,0.75)">
           <div style="font-size:0.73rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#506473">Preview image</div>
           <a href="${esc(feature.imageUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:0.74rem;font-weight:600;color:#005e95;text-decoration:none">Open full image</a>
         </div>
         <img src="${esc(feature.imageUrl)}" alt="${esc(feature.title)} preview"
              loading="lazy" referrerpolicy="no-referrer"
              style="width:100%;max-height:220px;object-fit:cover;display:block;background:#edf3f7"
              onerror="var figure=this.closest('figure'); if(figure){figure.style.display='none';}" />
       </figure>`
    : "";

  // ── Properties table ───────────────────────────────────────────────────
  const displayProps = Object.entries(feature.properties).filter(([key]) => {
    if (key.startsWith("_")) return false;
    const lk = key.toLowerCase();
    return !["name", "title", "label", "description", "summary", "desc"].includes(lk);
  });

  const descHtml = desc
    ? `<p style="margin:0 0 8px;color:#2f3a45;font-size:0.84rem;line-height:1.5">${esc(desc)}</p>`
    : "";

  const tableHtml = displayProps.length
    ? `<table style="border-collapse:collapse;min-width:190px;background:#fbfdfe;border:1px solid #e0e9ef;border-radius:10px">
        ${displayProps
          .slice(0, 20)
          .map(
            ([key, value]) =>
              `<tr><td ${CL}>${esc(key)}</td><td ${CV}>${formatValue(value)}</td></tr>`,
          )
          .join("")}
       </table>`
    : "";

  // ── Badges ───────────────────────────────────────────────────────────────
  const BS =
    "display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;" +
    "font-size:0.72rem;font-weight:600;";
  const srcBadge = `<span style="${BS}${isGeocoded ? "background:#f3effe;color:#5a3a9a;border:1px solid #d4c4f5" : "background:#e7f1fb;color:#005e95;border:1px solid #bed7ea"}">${esc(isGeocoded ? "Geocoded" : "MCP Source")}</span>`;
  const tierBadge = tier === "high"
    ? `<span style="${BS}margin-left:5px;background:#fff7e0;color:#7a5a00;border:1px solid #f5d87a">★ Primary</span>`
    : "";
  const groupBadge = feature.layerGroup
    ? `<span style="${BS}margin-left:5px;background:#f0f4f8;color:#3d5066;border:1px solid #cdd8e4">${esc(feature.layerGroup)}</span>`
    : "";

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);font-size:0.88rem;line-height:1.5;min-width:220px;background:linear-gradient(180deg,rgba(247,250,252,0.96) 0%,rgba(255,255,255,0.99) 100%);padding:2px;border-radius:14px">
      ${imageHtml}
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">${srcBadge}${tierBadge}${groupBadge}</div>
      ${descHtml}
      ${tableHtml}
    </div>`;
}

// ── Geometry builders ─────────────────────────────────────────────────────────

/**
 * Converts a SynthesizedFeature to one or more ArcGIS Graphics.
 * Returns an empty array if the feature's coordinates are invalid.
 */
function buildGraphics(
  feature: SynthesizedFeature,
  tier: SymbolTier,
  overrideLat?: number,
  overrideLon?: number,
): Graphic[] {
  const isGeocoded = feature.geocodeTerm != null;
  const sym = symbolForFeature(feature, tier, isGeocoded);
  const popupContent = buildPopupContent(feature, tier, isGeocoded);
  const attrs = { name: feature.title, ...feature.properties };

  const mkGraphic = (geometry: Point | Polyline | Polygon) =>
    new Graphic({
      geometry,
      symbol: sym as any,
      attributes: attrs,
      popupTemplate: { title: "{name}", content: popupContent } as any,
    });

  // Geocoded / override point
  if (overrideLat !== undefined && overrideLon !== undefined) {
    return [
      mkGraphic(
        new Point({ longitude: overrideLon, latitude: overrideLat }),
      ),
    ];
  }

  const coords = feature.coordinates;
  if (!coords) return [];

  switch (feature.geometryType) {
    case "Point": {
      const [lon, lat] = coords as [number, number];
      return [mkGraphic(new Point({ longitude: lon, latitude: lat }))];
    }

    case "LineString": {
      const paths = coords as Array<[number, number]>;
      if (paths.length < 2) return [];
      return [
        mkGraphic(
          new Polyline({
            paths: [paths],
            spatialReference: { wkid: 4326 },
          }),
        ),
      ];
    }

    case "Polygon": {
      const rings = coords as Array<Array<[number, number]>>;
      if (!rings.length) return [];
      return [
        mkGraphic(
          new Polygon({ rings, spatialReference: { wkid: 4326 } }),
        ),
      ];
    }

    case "MultiPoint": {
      const pts = coords as Array<[number, number]>;
      return pts.map(([lon, lat]) =>
        mkGraphic(new Point({ longitude: lon, latitude: lat })),
      );
    }

    case "MultiLineString": {
      const paths = coords as Array<Array<[number, number]>>;
      const validPaths = paths.filter((p) => p.length >= 2);
      if (!validPaths.length) return [];
      return [
        mkGraphic(
          new Polyline({ paths: validPaths, spatialReference: { wkid: 4326 } }),
        ),
      ];
    }

    case "MultiPolygon": {
      const polys = coords as Array<Array<Array<[number, number]>>>;
      return polys
        .filter((p) => p.length > 0)
        .map((rings) =>
          mkGraphic(
            new Polygon({ rings, spatialReference: { wkid: 4326 } }),
          ),
        );
    }

    default:
      return [];
  }
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

async function geocodePlace(
  term: string,
): Promise<{ lat: number; lon: number } | null> {
  const params = new URLSearchParams({
    f: "json",
    SingleLine: term,
    maxLocations: "1",
    outFields: "Match_addr,Addr_type",
    forStorage: "false",
  });
  try {
    const res = await fetch(
      `${GEOCODER_URL}?${params}`,
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const c = Array.isArray(json?.candidates) ? json.candidates[0] : null;
    const x = Number(c?.location?.x);
    const y = Number(c?.location?.y);
    if (isNaN(x) || isNaN(y)) return null;
    return { lat: y, lon: x };
  } catch {
    return null;
  }
}

// ── Navigate helpers ──────────────────────────────────────────────────────────

async function goTo(view: any, graphics: Graphic[]): Promise<void> {
  if (!graphics.length) return;
  try {
    await view.goTo(graphics, {
      animate: true,
      duration: graphics.length === 1 ? 320 : 500,
    });
  } catch {
    // goTo may fail before the view is ready — silently ignore.
  }
}

function collectAllGraphics(group: GroupLayer): Graphic[] {
  const out: Graphic[] = [];
  (group.layers as any).forEach((sub: GraphicsLayer) => {
    ((sub.graphics as any).toArray?.() ?? []).forEach((g: Graphic) => out.push(g));
  });
  return out;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render synthesized GeoJSON features onto the active ArcGIS MapView grouped
 * into one named sub-layer per category.
 */
export async function renderArbitraryGeoJson(
  result: SynthesizedGeoResult,
  title = "MCP Results",
): Promise<void> {
  if (!result.features.length) return;

  const mapEl = document.querySelector(MAP_ELEMENT_SELECTOR) as any;
  const view: any = mapEl?.view;
  if (!view?.map) return;

  // Remove any previous MCP layer (may be a GroupLayer or GraphicsLayer)
  const old = view.map.findLayerById(MCP_GEO_LAYER_ID);
  if (old) view.map.remove(old);

  // Build a map of groupName → GraphicsLayer
  const subLayers = new Map<string, GraphicsLayer>();
  const getSubLayer = (groupName: string): GraphicsLayer => {
    if (!subLayers.has(groupName)) {
      subLayers.set(
        groupName,
        new GraphicsLayer({ title: groupName, listMode: "show", visible: true }),
      );
    }
    return subLayers.get(groupName)!;
  };

  // Pre-create sublayers for every group present in the synthesized result so
  // later geocode-only features cannot create layers that are missing from the
  // GroupLayer.
  for (const feature of result.features) {
    getSubLayer(feature.layerGroup ?? "General");
  }

  // ── Phase 1: explicit geometry (immediate) ────────────────────────────────
  const explicitFeatures = result.features.filter(
    (f) => f.coordinates != null && f.geometryType !== "none",
  );

  for (let i = 0; i < explicitFeatures.length; i++) {
    const f = explicitFeatures[i];
    const tier: SymbolTier = "medium";
    buildGraphics(f, tier).forEach((g) => getSubLayer(f.layerGroup ?? "General").add(g));
  }

  // Assemble GroupLayer in LAYER_GROUPS order.
  const orderedNames = [...LAYER_GROUPS.map((g) => g.name), ...subLayers.keys()];
  const seen = new Set<string>();
  const layerList = orderedNames
    .filter((n) => {
      if (seen.has(n) || !subLayers.has(n)) return false;
      seen.add(n);
      return true;
    })
    .map((n) => subLayers.get(n)!);

  const group = new GroupLayer({
    id: MCP_GEO_LAYER_ID,
    title,
    listMode: "show",
    visibilityMode: "independent",
    layers: layerList,
  });

  view.map.add(group);

  // Wait for the view to create and initialize the GroupLayer's layer view
  // before navigating.  Without this, goTo() completes while the sub-layer
  // views are still being set up, leaving the graphics invisible until the user
  // clicks or pans to trigger a repaint.
  try { await view.whenLayerView(group); } catch { /* view not ready — proceed anyway */ }

  await goTo(view, collectAllGraphics(group));

  // ── Phase 2: geocode-flagged features (parallel) ─────────────────────────
  const geocodeFeatures = result.features.filter(
    (f) => f.geocodeTerm != null && f.coordinates == null,
  );

  if (geocodeFeatures.length) {
    const beforeCount = collectAllGraphics(group).length;

    await Promise.all(
      geocodeFeatures.map(async (f, i) => {
        const geo = await geocodePlace(f.geocodeTerm!);
        if (!geo) return;
        const tier: SymbolTier = "medium";
        buildGraphics(f, tier, geo.lat, geo.lon).forEach((g) =>
          getSubLayer(f.layerGroup ?? "General").add(g),
        );
      }),
    );

    // Re-navigate only if new graphics were actually added
    if (collectAllGraphics(group).length > beforeCount) {
      await goTo(view, collectAllGraphics(group));
    }
  }
}
