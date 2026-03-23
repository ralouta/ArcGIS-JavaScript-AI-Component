import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import Graphic from "@arcgis/core/Graphic";
import ImageryLayer from "@arcgis/core/layers/ImageryLayer";
import ImageryTileLayer from "@arcgis/core/layers/ImageryTileLayer";
import MapImageLayer from "@arcgis/core/layers/MapImageLayer";
import type {
  AssistantGeoMemorySnapshot,
  AssistantResultEntity,
} from "./assistantState";
import { GEOCODER_URL, MAP_ELEMENT_SELECTOR } from "./arcgisConfig";

export type AddableLayerKind = "feature" | "imagery" | "geotiff" | "map-image";

export interface AddableLayerSpec {
  url: string;
  title?: string;
  kind?: AddableLayerKind;
}

export interface PointFeatureDraft {
  geometry: { type: "point"; longitude: number; latitude: number };
  attributes: Record<string, unknown>;
}

export interface FeatureEditSummary {
  success: boolean;
  message: string;
  addedCount?: number;
  updatedCount?: number;
  deletedCount?: number;
}

function toSafeFieldName(label: string, usedNames: Set<string>): string {
  const cleaned = label
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([^A-Za-z_])/, "_$1")
    .slice(0, 48);

  const baseName = cleaned || "Field";
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${baseName.slice(0, Math.max(1, 48 - String(suffix).length - 1))}_${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function parseScalarFieldValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed) ? 1 : 0;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (/^-?\d*\.\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return trimmed;
}

function normalizeLayerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /\/\d+$/.test(trimmed) ? trimmed : `${trimmed}/0`;
}

function normalizeGenericLayerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function inferLayerKind(url: string, explicitKind?: AddableLayerKind): AddableLayerKind {
  if (explicitKind) return explicitKind;
  const normalizedUrl = normalizeGenericLayerUrl(url).toLowerCase();
  if (/\.(tif|tiff)(\?|$)/i.test(normalizedUrl)) return "geotiff";
  if (/\/imageserver$/i.test(normalizedUrl)) return "imagery";
  if (/\/(mapserver)(\/\d+)?$/i.test(normalizedUrl)) return "map-image";
  return "feature";
}

function toWhereSafeValue(value: string): string {
  return value.replace(/'/g, "''");
}

async function loadLayer(layerUrl: string): Promise<FeatureLayer> {
  const layer = new FeatureLayer({ url: normalizeLayerUrl(layerUrl) });
  await layer.load();
  return layer;
}

function buildDefaultAttributes(entity: AssistantResultEntity): Record<string, unknown> {
  const usedNames = new Set<string>(["name"]);
  const attributes: Record<string, unknown> = {
    Name: entity.label,
  };

  if (entity.fields?.length) {
    for (const field of entity.fields) {
      const fieldName = toSafeFieldName(field.label, usedNames);
      attributes[fieldName] = parseScalarFieldValue(field.value);
    }

    if (entity.description?.trim() && attributes.Description == null) {
      attributes.Description = entity.description.trim();
    }
    return attributes;
  }

  attributes.Category = entity.kind;
  attributes.Origin = entity.origin;
  attributes.Description = entity.description ?? "";
  attributes.Summary = entity.summary ?? "";
  attributes.ResourceLinks = (entity.links ?? []).map((link) => link.url).join(" | ");
  return attributes;
}

async function geocodeSingleLine(singleLine: string): Promise<{ latitude: number; longitude: number } | null> {
  const params = new URLSearchParams({
    f: "json",
    SingleLine: singleLine,
    maxLocations: "1",
    outFields: "Match_addr,Addr_type,City,Region",
    forStorage: "false",
  });

  try {
    const response = await fetch(
      `${GEOCODER_URL}?${params.toString()}`,
    );
    if (!response.ok) return null;
    const json: any = await response.json();
    const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : null;
    const latitude = Number(candidate?.location?.y);
    const longitude = Number(candidate?.location?.x);
    if (isNaN(latitude) || isNaN(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

export async function buildPointFeatureDraftsFromMemory(
  snapshot: AssistantGeoMemorySnapshot | null,
): Promise<PointFeatureDraft[]> {
  if (!snapshot?.entities?.length) return [];

  const drafts: PointFeatureDraft[] = [];
  const seen = new Set<string>();

  for (const entity of snapshot.entities) {
    let latitude = entity.lat;
    let longitude = entity.lon;

    if ((latitude == null || longitude == null) && entity.kind !== "point") {
      const geocoded = await geocodeSingleLine(entity.label);
      if (geocoded) {
        latitude = geocoded.latitude;
        longitude = geocoded.longitude;
      }
    }

    if (latitude == null || longitude == null) continue;

    const key = `${entity.label.toLowerCase()}:${latitude.toFixed(3)}:${longitude.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    drafts.push({
      geometry: { type: "point", latitude, longitude },
      attributes: buildDefaultAttributes(entity),
    });
  }

  return drafts;
}

export function inferFieldsFromPointFeatureDrafts(
  drafts: PointFeatureDraft[],
): Array<{ name: string; type: string; alias?: string; length?: number }> {
  const definitions = new Map<string, { name: string; type: string; alias?: string; length?: number }>();

  for (const draft of drafts) {
    for (const [name, value] of Object.entries(draft.attributes)) {
      if (!name || name.toUpperCase() === "OBJECTID") continue;
      if (definitions.has(name)) continue;
      if (typeof value === "number") {
        definitions.set(name, { name, alias: name, type: Number.isInteger(value) ? "esriFieldTypeInteger" : "esriFieldTypeDouble" });
        continue;
      }
      definitions.set(name, {
        name,
        alias: name,
        type: "esriFieldTypeString",
        length: Math.min(Math.max(String(value ?? "").length + 64, 128), 2000),
      });
    }
  }

  return [...definitions.values()];
}

function sanitizeAttributes(layer: FeatureLayer, attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldMap = new Map(
    (layer.fields ?? []).map((field) => [field.name.toLowerCase(), field.name]),
  );

  for (const [name, value] of Object.entries(attributes)) {
    const matched = fieldMap.get(name.toLowerCase());
    if (!matched) continue;
    out[matched] = value;
  }

  return out;
}

export async function addPointFeaturesToLayer(
  layerUrl: string,
  drafts: PointFeatureDraft[],
): Promise<FeatureEditSummary> {
  if (!drafts.length) {
    return { success: false, message: "No point features were available to add." };
  }

  const layer = await loadLayer(layerUrl);
  const addFeatures = drafts.map((draft) =>
    new Graphic({
      geometry: draft.geometry as any,
      attributes: sanitizeAttributes(layer, draft.attributes),
    }),
  );
  const result = await layer.applyEdits({ addFeatures });
  const addedCount = Array.isArray(result.addFeatureResults)
    ? result.addFeatureResults.filter((item: any) => item?.objectId != null && !item?.error).length
    : 0;
  return {
    success: addedCount > 0,
    message: addedCount > 0 ? `Added ${addedCount} feature${addedCount === 1 ? "" : "s"}.` : "No features were added.",
    addedCount,
  };
}

export async function addFeatureLayerToCurrentMap(layerUrl: string, title?: string): Promise<void> {
  const mapEl = document.querySelector(MAP_ELEMENT_SELECTOR) as any;
  const view = mapEl?.view;
  if (!view?.map) return;
  const normalized = normalizeLayerUrl(layerUrl);
  const existing = view.map.layers.find((layer: any) => layer?.url === normalized);
  if (existing) return;
  const layer = new FeatureLayer({ url: normalized, title: title?.trim() || undefined });
  view.map.add(layer);
}

export async function addLayerToCurrentMap(spec: AddableLayerSpec): Promise<void> {
  const mapEl = document.querySelector(MAP_ELEMENT_SELECTOR) as any;
  const view = mapEl?.view;
  if (!view?.map) return;

  const kind = inferLayerKind(spec.url, spec.kind);
  const title = spec.title?.trim() || undefined;
  const normalizedUrl = kind === "feature" ? normalizeLayerUrl(spec.url) : normalizeGenericLayerUrl(spec.url);
  const existing = view.map.layers.find((layer: any) => layer?.url === normalizedUrl);
  if (existing) return;

  const layer = (() => {
    switch (kind) {
      case "geotiff":
        return new ImageryTileLayer({ url: normalizedUrl, title });
      case "imagery":
        return new ImageryLayer({ url: normalizedUrl, title });
      case "map-image":
        return new MapImageLayer({ url: normalizedUrl, title });
      default:
        return new FeatureLayer({ url: normalizedUrl, title });
    }
  })();

  view.map.add(layer as any);
}

export async function deleteFeaturesByName(layerUrl: string, name: string): Promise<FeatureEditSummary> {
  const layer = await loadLayer(layerUrl);
  const fieldNames = new Set((layer.fields ?? []).map((field) => field.name.toLowerCase()));
  const nameField = fieldNames.has("name") ? "Name" : fieldNames.has("title") ? "Title" : null;
  if (!nameField) {
    return { success: false, message: "The target layer does not have a Name or Title field." };
  }

  const where = `${nameField} = '${toWhereSafeValue(name)}'`;
  const featureSet = await layer.queryFeatures({ where, outFields: [layer.objectIdField], returnGeometry: false });
  if (!featureSet.features.length) {
    return { success: false, message: `No features named ${name} were found.` };
  }

  const result = await layer.applyEdits({ deleteFeatures: featureSet.features });
  const deletedCount = Array.isArray(result.deleteFeatureResults)
    ? result.deleteFeatureResults.filter((item: any) => item?.objectId != null && !item?.error).length
    : 0;
  return {
    success: deletedCount > 0,
    message: deletedCount > 0 ? `Deleted ${deletedCount} feature${deletedCount === 1 ? "" : "s"} named ${name}.` : `No features named ${name} were deleted.`,
    deletedCount,
  };
}

export async function updateFeaturesByName(
  layerUrl: string,
  name: string,
  attributes: Record<string, unknown>,
): Promise<FeatureEditSummary> {
  const layer = await loadLayer(layerUrl);
  const fieldNames = new Set((layer.fields ?? []).map((field) => field.name.toLowerCase()));
  const nameField = fieldNames.has("name") ? "Name" : fieldNames.has("title") ? "Title" : null;
  if (!nameField) {
    return { success: false, message: "The target layer does not have a Name or Title field." };
  }

  const where = `${nameField} = '${toWhereSafeValue(name)}'`;
  const featureSet = await layer.queryFeatures({ where, outFields: ["*"], returnGeometry: true });
  if (!featureSet.features.length) {
    return { success: false, message: `No features named ${name} were found.` };
  }

  const updates = featureSet.features.map((feature) => {
    const sanitized = sanitizeAttributes(layer, attributes);
    feature.attributes = { ...feature.attributes, ...sanitized };
    return feature;
  });
  const result = await layer.applyEdits({ updateFeatures: updates });
  const updatedCount = Array.isArray(result.updateFeatureResults)
    ? result.updateFeatureResults.filter((item: any) => item?.objectId != null && !item?.error).length
    : 0;
  return {
    success: updatedCount > 0,
    message: updatedCount > 0 ? `Updated ${updatedCount} feature${updatedCount === 1 ? "" : "s"} named ${name}.` : `No features named ${name} were updated.`,
    updatedCount,
  };
}

export async function upsertPointFeaturesByName(
  layerUrl: string,
  drafts: PointFeatureDraft[],
): Promise<FeatureEditSummary> {
  if (!drafts.length) {
    return { success: false, message: "No point features were available to sync." };
  }

  const layer = await loadLayer(layerUrl);
  const fieldNames = new Set((layer.fields ?? []).map((field) => field.name.toLowerCase()));
  const nameField = fieldNames.has("name") ? "Name" : fieldNames.has("title") ? "Title" : null;
  if (!nameField) {
    return { success: false, message: "The target layer does not have a Name or Title field." };
  }

  const addFeatures: Graphic[] = [];
  const updateFeatures: Graphic[] = [];

  for (const draft of drafts) {
    const name = String(draft.attributes[nameField] ?? draft.attributes.Name ?? draft.attributes.Title ?? "").trim();
    if (!name) continue;

    const where = `${nameField} = '${toWhereSafeValue(name)}'`;
    const featureSet = await layer.queryFeatures({ where, outFields: ["*"], returnGeometry: true });
    if (featureSet.features.length) {
      const feature = featureSet.features[0];
      feature.geometry = draft.geometry as any;
      feature.attributes = {
        ...feature.attributes,
        ...sanitizeAttributes(layer, draft.attributes),
      };
      updateFeatures.push(feature);
      continue;
    }

    addFeatures.push(
      new Graphic({
        geometry: draft.geometry as any,
        attributes: sanitizeAttributes(layer, draft.attributes),
      }),
    );
  }

  const result = await layer.applyEdits({ addFeatures, updateFeatures });
  const addedCount = Array.isArray(result.addFeatureResults)
    ? result.addFeatureResults.filter((item: any) => item?.objectId != null && !item?.error).length
    : 0;
  const updatedCount = Array.isArray(result.updateFeatureResults)
    ? result.updateFeatureResults.filter((item: any) => item?.objectId != null && !item?.error).length
    : 0;

  return {
    success: addedCount + updatedCount > 0,
    message:
      addedCount + updatedCount > 0
        ? `Synced ${updatedCount} existing feature${updatedCount === 1 ? "" : "s"} and added ${addedCount} new feature${addedCount === 1 ? "" : "s"}.`
        : "No features were synced.",
    addedCount,
    updatedCount,
  };
}