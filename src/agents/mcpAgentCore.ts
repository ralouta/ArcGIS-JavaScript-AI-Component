import type { GeoContext, GeoEntity, GeoExtent, GeoNamedPlace, GeoPoint } from "../utils/mcpGeoRenderer";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface HubServerLike {
  label: string;
}

export function normalizeUrl(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\b0\.0\.0\.0\b/, "127.0.0.1");
}

export function resolveHubServersUrl(endpointUrl: string): string | null {
  const normalized = normalizeUrl(endpointUrl);
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      if (/\/mcp\/?$/i.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/servers`;
      } else {
        url.pathname = `${url.pathname.replace(/\/+$/, "") || ""}/servers`;
      }
      url.search = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  if (/\/mcp\/?$/i.test(normalized)) {
    return `${normalized.replace(/\/+$/, "")}/servers`;
  }
  return null;
}

export function buildToolPromptText(
  serverLabel: string,
  hubServers: HubServerLike[],
  totalTools: number,
  priorToolRounds: number,
): string {
  const sourceSummary = hubServers.length
    ? `Connected MCP sources: ${hubServers.map((server) => server.label).join(", ")}.`
    : `Connected MCP source: ${serverLabel}.`;

  return [
    `You are connected to the ${serverLabel} server.`,
    "Answer only by using the available MCP tools when external data is required.",
    sourceSummary,
    `All ${totalTools} discovered MCP tools in this session are available to you.`,
    `You have already used ${priorToolRounds} MCP tool round(s) in this run.`,
    "Inspect the server tags in the tool descriptions, choose the most relevant source and tools yourself, and do not invent results.",
    "Prefer the fewest tool calls needed to answer the request. If a tool response already answers the question, stop.",
    "If no tool is relevant, say that clearly instead of fabricating an answer.",
  ].join(" ");
}

export function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  return undefined;
}

export function collectGeoHintsFromJson(
  value: unknown,
  out: {
    coords: Array<{ lat: number; lon: number; label?: string }>;
    extents: Array<{ label: string; west: number; south: number; east: number; north: number }>;
    names: string[];
  },
  depth = 0,
): void {
  if (depth > 8 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectGeoHintsFromJson(item, out, depth + 1);
    return;
  }

  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  const primaryLabelKey = keys.find((key) =>
    ["name", "location", "city", "country", "region", "place", "title", "id"].includes(key.toLowerCase()),
  );
  const primaryLabel = primaryLabelKey && typeof obj[primaryLabelKey] === "string"
    ? String(obj[primaryLabelKey]).trim()
    : undefined;

  const findNum = (candidates: string[]): number | undefined => {
    for (const key of keys) {
      if (candidates.includes(key.toLowerCase())) {
        const n = Number(obj[key]);
        if (!isNaN(n)) return n;
      }
    }
    return undefined;
  };

  const lat = findNum(["lat", "latitude", "y"]);
  const lon = findNum(["lon", "lng", "long", "longitude", "x"]);
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.coords.push({ lat, lon, label: primaryLabel });
  }

  const directBbox = Array.isArray(obj.bbox) ? obj.bbox : undefined;
  const extentBbox = Array.isArray((obj.extent as any)?.spatial?.bbox)
    ? (obj.extent as any).spatial.bbox
    : undefined;
  const bboxSource = extentBbox ?? directBbox;
  const bbox = Array.isArray(bboxSource?.[0]) ? bboxSource?.[0] : bboxSource;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const west = Number(bbox[0]);
    const south = Number(bbox[1]);
    const east = Number(bbox[2]);
    const north = Number(bbox[3]);
    const lonSpan = Math.abs(east - west);
    const latSpan = Math.abs(north - south);
    if (
      [west, south, east, north].every((n) => !isNaN(n)) &&
      lonSpan <= 300 &&
      latSpan <= 160
    ) {
      const label = primaryLabel?.trim();
      if (label) {
        out.extents.push({ label, west, south, east, north });
      }
      out.coords.push({
        lat: (south + north) / 2,
        lon: (west + east) / 2,
        label,
      });
    }
  }

  for (const key of keys) {
    const lower = key.toLowerCase();
    const val = obj[key];

    if (
      typeof val === "string" &&
      ["name", "location", "city", "country", "region", "state", "province", "place", "title"].includes(lower)
    ) {
      const name = val.trim();
      if (name.length >= 2 && name.length <= 80) out.names.push(name);
    }

    if (typeof val === "object" && val !== null) {
      collectGeoHintsFromJson(val, out, depth + 1);
    }
  }
}

export function collectGeoHintsFromText(
  text: string,
  out: { coords: Array<{ lat: number; lon: number; label?: string }>; names: string[] },
): void {
  const sections = text.split(/\n\s*---\s*\n/g).map((section) => section.trim()).filter(Boolean);

  for (const section of sections) {
    const heading = section.match(/^##\s+(.+)$/m)?.[1]?.trim();
    const fullName = section.match(/\*\*Full Name:\*\*\s*(.+)$/m)?.[1]?.trim();
    const locationLine = section.match(/(?:\*\*Location:\*\*|(?:^|\n)location:)\s*(.+)$/im)?.[1]?.trim();
    const placeLine = section.match(/(?:^|\n)(?:place|city|country|region|state|province|name|title):\s*(.+)$/im)?.[1]?.trim();
    const label = fullName || heading || locationLine;

    const latLonMatch = section.match(/Latitude:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*Longitude:\s*(-?\d{1,3}(?:\.\d+)?)/i);
    if (latLonMatch) {
      const lat = Number(latLonMatch[1]);
      const lon = Number(latLonMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.coords.push({ lat, lon, label });
      }
    }

    const coordLineMatch = section.match(/\*\*Coordinates:\*\*\s*(-?\d{1,3}(?:\.\d+)?)°?\s*,\s*(-?\d{1,3}(?:\.\d+)?)°?/i);
    if (coordLineMatch) {
      const lat = Number(coordLineMatch[1]);
      const lon = Number(coordLineMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.coords.push({ lat, lon, label });
      }
    }

    const locationCoordMatch = section.match(/\*\*Location:\*\*\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/i);
    if (locationCoordMatch) {
      const lat = Number(locationCoordMatch[1]);
      const lon = Number(locationCoordMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.coords.push({ lat, lon, label: locationLine });
      }
    }

    const plainLocationCoordMatch = section.match(/(?:^|\n)location:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/im);
    if (plainLocationCoordMatch) {
      const lat = Number(plainLocationCoordMatch[1]);
      const lon = Number(plainLocationCoordMatch[2]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.coords.push({ lat, lon, label: locationLine || placeLine || heading });
      }
    }

    const candidateNames = [fullName, heading, locationLine, placeLine].filter(
      (value): value is string => Boolean(value && value.trim()),
    );
    for (const candidate of candidateNames) {
      if (candidate.length >= 2 && candidate.length <= 120) out.names.push(candidate);
    }
  }
}

function extractCatalogItemBlocks(text: string): string[] {
  const startRe = /^(?!\s*(?:datetime|bbox|thumbnail|data(?:\s*\(cog\))?|item\s+json|next\s+steps)\b)(.+?\(collection:\s*[^)]+\))\s*$/gim;
  const matches = [...text.matchAll(startRe)];
  if (!matches.length) {
    return text.split(/\n(?=\d+\)\s)/g).map((section) => section.trim()).filter(Boolean);
  }

  const blocks: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end).trim();
    if (block) blocks.push(block);
  }

  return blocks;
}

function deriveCatalogItemLabel(block: string): string | null {
  const firstLine = block.split(/\n+/)[0]?.trim();
  if (firstLine && !/:\s*$/.test(firstLine)) {
    return firstLine.replace(/\s*\(collection:\s*[^)]+\)\s*$/i, "").trim();
  }

  const idLabel = block.match(/(?:^|\n)-?\s*ID:\s*(.+)$/im)?.[1]?.trim();
  const titleLabel = block.match(/(?:^|\n)-?\s*Title:\s*(.+)$/im)?.[1]?.trim();
  const collectionLabel = block.match(/(?:^|\n)-?\s*Collection:\s*(.+)$/im)?.[1]?.trim();
  return idLabel || titleLabel || collectionLabel || null;
}

function getGeoEntityDisplayName(entity: GeoEntity): string {
  return entity.kind === "point" || entity.kind === "extent" ? entity.label : entity.name;
}

function pointLabelQuality(label: string): number {
  const trimmed = label.trim();
  if (!trimmed) return 0;
  if (/^-?\d{1,3}(?:\.\d+)?(?:°)?\s*,\s*-?\d{1,3}(?:\.\d+)?(?:°)?$/.test(trimmed)) return 1;
  if (/^-?\d/.test(trimmed)) return 2;
  if (/,/.test(trimmed)) return 4;
  return 3;
}

function geoContextQuality(context?: GeoContext): number {
  if (!context) return 0;
  let score = 0;
  if (context.summary?.trim()) score += 4;
  score += Math.min(context.links?.length ?? 0, 2) * 2;
  score += Math.min(context.mcpFields?.length ?? 0, 4);
  return score;
}

function choosePreferredPointEntity(current: GeoPoint, candidate: GeoPoint): GeoPoint {
  const currentScore = pointLabelQuality(current.label) + geoContextQuality(current.context) + (current.description?.trim() ? 3 : 0);
  const candidateScore = pointLabelQuality(candidate.label) + geoContextQuality(candidate.context) + (candidate.description?.trim() ? 3 : 0);
  return candidateScore > currentScore ? candidate : current;
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function labelForUrl(url: string, explicitLabel?: string): string {
  const normalizedExplicitLabel = explicitLabel?.trim();
  if (normalizedExplicitLabel && !isLikelyUrl(normalizedExplicitLabel)) {
    return normalizedExplicitLabel;
  }

  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url.slice(0, 40);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getStringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimLocationCandidate(value: string): string {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/^the\s+/i, "")
    .replace(/^capital\s+/i, "")
    .replace(/^[\p{L}'’.-]+\s+section\s+of\s+the\s+/iu, "")
    .replace(/\barea$/i, "")
    .replace(/[,:;.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type ScalarField = {
  key: string;
  label: string;
  value: string;
};

const LOCATION_FIELD_RE = /(?:^|[_-])(location|place|city|country|region|state|province|district|county|municipality|territory|town|village|locality|settlement|governorate|prefecture|address)(?:$|[_-])/i;
const SUMMARY_FIELD_RE = /(?:^|[_-])(title|headline|summary|description|abstract|snippet|content|text|name)(?:$|[_-])/i;
const DESCRIPTION_FIELD_RE = /(?:^|[_-])(title|headline|name)(?:$|[_-])/i;
const SKIP_CONTEXT_FIELD_RE = /(?:^|[_-])(content|text|body|html)(?:$|[_-])/i;

function toFieldLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (value) => value.toUpperCase());
}

function collectScalarFields(value: unknown, out: ScalarField[], depth = 0): void {
  if (depth > 2 || value == null || out.length >= 24) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectScalarFields(item, out, depth + 1);
      if (out.length >= 24) return;
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const [key, fieldValue] of Object.entries(record)) {
    if (out.length >= 24) return;

    if (typeof fieldValue === "string") {
      const text = fieldValue.trim();
      if (text) out.push({ key, label: toFieldLabel(key), value: text });
      continue;
    }

    if (typeof fieldValue === "number" || typeof fieldValue === "boolean") {
      out.push({ key, label: toFieldLabel(key), value: String(fieldValue) });
      continue;
    }

    collectScalarFields(fieldValue, out, depth + 1);
  }
}

function chooseRecordDescription(fields: ScalarField[]): string | undefined {
  return fields.find((field) => DESCRIPTION_FIELD_RE.test(field.key))?.value;
}

function buildStructuredRecordContext(record: Record<string, unknown>): GeoContext | undefined {
  const fields: ScalarField[] = [];
  collectScalarFields(record, fields);
  if (!fields.length) return undefined;

  const summary = fields
    .filter((field) => SUMMARY_FIELD_RE.test(field.key))
    .map((field) => field.value)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 2)
    .join(" -- ")
    .trim();

  const links = fields
    .filter((field) => isLikelyUrl(field.value))
    .map((field) => ({ url: field.value, label: chooseRecordDescription(fields) || field.label || labelForUrl(field.value) }))
    .filter((link, index, items) => items.findIndex((candidate) => candidate.url === link.url) === index)
    .slice(0, 4);

  const mcpFields = fields
    .filter((field) => !isLikelyUrl(field.value) && !SKIP_CONTEXT_FIELD_RE.test(field.key))
    .filter((field, index, items) =>
      items.findIndex((candidate) => candidate.label === field.label && candidate.value === field.value) === index,
    )
    .slice(0, 8)
    .map((field) => ({ label: field.label, value: field.value }));

  if (!summary && !links.length && !mcpFields.length) return undefined;

  return {
    summary,
    links,
    ...(mcpFields.length ? { mcpFields } : {}),
  };
}

function isInformativeGeoContext(context: GeoContext | undefined): boolean {
  if (!context) return false;
  if (context.summary?.trim()) return true;
  if ((context.links?.length ?? 0) > 0) return true;
  if ((context.mcpFields?.length ?? 0) >= 2) return true;
  return false;
}

function collectGenericPlaceMentions(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (raw: string) => {
    const value = trimLocationCandidate(raw);
    if (!value || value.length < 2 || value.length > 80) return;
    const normalized = normalizeFocusLabel(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(value);
  };

  const localityRe = /\b(?:in|at|near|around|within|across|outside|inside|from)\s+((?:the\s+)?(?:capital\s+)?(?:Mt\.|Mount|St\.|Saint)?\s*(?:[A-Z][\p{L}'’.-]+)(?:\s+(?:[A-Z][\p{L}'’.-]+|of|the|al|el|de|la|le|Mt\.|Mount|St\.|Saint|area)){0,4})/gu;
  let localityMatch: RegExpExecArray | null;
  while ((localityMatch = localityRe.exec(text)) !== null) {
    pushCandidate(localityMatch[1]);
  }

  return candidates;
}

function collectRecordLocationCandidates(fields: ScalarField[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (!LOCATION_FIELD_RE.test(field.key)) continue;
    const value = trimLocationCandidate(field.value);
    if (!value) continue;
    const normalized = normalizeFocusLabel(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(value);
  }

  return candidates;
}

function chooseStructuredRecordLabel(record: Record<string, unknown>, fields: ScalarField[]): string | undefined {
  const prioritizedKeys = ["name", "location", "city", "country", "region", "place", "title", "headline", "id"];

  for (const key of prioritizedKeys) {
    const field = fields.find((candidate) => candidate.key.toLowerCase() === key);
    const value = field?.value?.trim();
    if (value) return value;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!prioritizedKeys.includes(key.toLowerCase()) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return undefined;
}

function extractStructuredRecordGeometries(
  record: Record<string, unknown>,
  fields: ScalarField[],
  description?: string,
  context?: GeoContext,
): GeoEntity[] {
  const geometries: GeoEntity[] = [];
  const label = chooseStructuredRecordLabel(record, fields) ?? description;
  const numericValue = (candidateKeys: string[]): number | undefined => {
    for (const [key, rawValue] of Object.entries(record)) {
      if (!candidateKeys.includes(key.toLowerCase())) continue;
      const value = Number(rawValue);
      if (!Number.isNaN(value)) return value;
    }
    return undefined;
  };

  const lat = numericValue(["lat", "latitude", "y"]);
  const lon = numericValue(["lon", "lng", "long", "longitude", "x"]);
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    geometries.push({
      kind: "point",
      origin: "source",
      label: label ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat,
      lon,
      ...(description ? { description } : {}),
      ...(context ? { context } : {}),
    } satisfies GeoPoint);
  }

  const directBbox = Array.isArray(record.bbox) ? record.bbox : undefined;
  const extentBbox = Array.isArray((record.extent as any)?.spatial?.bbox)
    ? (record.extent as any).spatial.bbox
    : undefined;
  const bboxSource = extentBbox ?? directBbox;
  const bbox = Array.isArray(bboxSource?.[0]) ? bboxSource[0] : bboxSource;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const west = Number(bbox[0]);
    const south = Number(bbox[1]);
    const east = Number(bbox[2]);
    const north = Number(bbox[3]);
    const lonSpan = Math.abs(east - west);
    const latSpan = Math.abs(north - south);
    if (
      [west, south, east, north].every((value) => !Number.isNaN(value)) &&
      lonSpan <= 300 &&
      latSpan <= 160
    ) {
      if (label) {
        geometries.push({
          kind: "extent",
          origin: "source",
          label,
          west,
          south,
          east,
          north,
          ...(description ? { description } : {}),
          ...(context ? { context } : {}),
        } satisfies GeoExtent);
      }

      geometries.push({
        kind: "point",
        origin: "source",
        label: label ?? `${((south + north) / 2).toFixed(4)}, ${((west + east) / 2).toFixed(4)}`,
        lat: (south + north) / 2,
        lon: (west + east) / 2,
        ...(description ? { description } : {}),
        ...(context ? { context } : {}),
      } satisfies GeoPoint);
    }
  }

  return geometries;
}

function walkStructuredRecords(value: unknown, visit: (record: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 6 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const record = asRecord(item);
      if (record) visit(record);
      walkStructuredRecords(item, visit, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const child of Object.values(record)) {
    walkStructuredRecords(child, visit, depth + 1);
  }
}

function extractStructuredRecordGeoEntities(parsed: unknown, focusLabels: string[]): GeoEntity[] {
  const entities: GeoEntity[] = [];

  walkStructuredRecords(parsed, (record) => {
    const fields: ScalarField[] = [];
    collectScalarFields(record, fields);
    if (!fields.length) return;

    const recordText = fields.map((field) => field.value).join(" ");
    if (!recordText.trim()) return;

    const context = buildStructuredRecordContext(record);
    const directLocations = collectRecordLocationCandidates(fields);
    const inferredLocations = directLocations.length ? [] : collectGenericPlaceMentions(recordText);
    const fallbackFocuses = directLocations.length || inferredLocations.length
      ? []
      : focusLabels.filter((focus) => new RegExp(`\\b${escapeRegExp(focus)}\\b`, "iu").test(recordText));
    const names = directLocations.length ? directLocations : inferredLocations.length ? inferredLocations : fallbackFocuses;
    if (!names.length) return;

    const description = chooseRecordDescription(fields);
    if (!description && !isInformativeGeoContext(context)) {
      return;
    }

    entities.push(...extractStructuredRecordGeometries(record, fields, description, context));

    for (const name of names) {
      entities.push({
        kind: "named",
        origin: "source",
        name,
        ...(description ? { description } : {}),
        ...(context ? { context } : {}),
      } satisfies GeoNamedPlace);
    }
  });

  return dedupeGeoEntities(entities);
}

function mergeEntityDescriptions(currentDescription?: string, candidateDescription?: string): string | undefined {
  const current = currentDescription?.trim();
  const candidate = candidateDescription?.trim();
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate.length > current.length ? candidate : current;
}

function mergeGeoEntity(current: GeoEntity, candidate: GeoEntity): GeoEntity {
  if (current.kind === "point" && candidate.kind === "point") {
    const preferred = choosePreferredPointEntity(current, candidate);
    const mergedContext = mergeGeoContexts([current.context, candidate.context]);
    const mergedDescription = mergeEntityDescriptions(current.description, candidate.description);
    return {
      ...preferred,
      ...(mergedDescription ? { description: mergedDescription } : {}),
      ...(mergedContext ? { context: mergedContext } : {}),
    } satisfies GeoPoint;
  }

  const mergedContext = mergeGeoContexts([current.context, candidate.context]);
  const mergedDescription = mergeEntityDescriptions(current.description, candidate.description);
  return {
    ...current,
    ...(mergedDescription ? { description: mergedDescription } : {}),
    ...(mergedContext ? { context: mergedContext } : {}),
  } as GeoEntity;
}

function geoContextFingerprint(context?: GeoContext): string {
  if (!context) return "";
  return [
    context.summary?.trim() ?? "",
    ...(context.links ?? []).slice(0, 2).map((link) => link.url.trim()),
    ...(context.mcpFields ?? []).slice(0, 3).map((field) => `${field.label}:${field.value}`),
  ]
    .filter(Boolean)
    .join("|")
    .toLowerCase();
}

function dedupeGeoEntities(entities: GeoEntity[]): GeoEntity[] {
  const seen = new Map<string, number>();
  const out: GeoEntity[] = [];

  for (const entity of entities) {
    let key = "";
    if (entity.kind === "point") {
      key = [
        entity.origin,
        entity.kind,
        entity.lat.toFixed(3),
        entity.lon.toFixed(3),
      ].join(":");
    } else if (entity.kind === "extent") {
      key = [
        entity.origin,
        entity.kind,
        entity.label.trim().toLowerCase(),
        entity.west.toFixed(3),
        entity.south.toFixed(3),
        entity.east.toFixed(3),
        entity.north.toFixed(3),
      ].join(":");
    } else if (entity.kind === "named") {
      const contextKey = geoContextFingerprint(entity.context);
      const descriptionKey = entity.description?.trim().toLowerCase() ?? "";
      key = [
        entity.origin,
        entity.kind,
        entity.name.trim().toLowerCase(),
        descriptionKey,
        contextKey,
      ].join(":");
    } else {
      key = [entity.origin, entity.kind, entity.name.trim().toLowerCase()].join(":");
    }
    const existingIndex = seen.get(key);
    if (existingIndex != null) {
      out[existingIndex] = mergeGeoEntity(out[existingIndex], entity);
      continue;
    }
    seen.set(key, out.length);
    out.push(entity);
  }

  return out;
}

function extractEntityContext(text: string, searchTerm: string, allEntityNames?: string[]): GeoContext | undefined {
  const URL_RE = /https?:\/\/[^\s\])'"<>,\u0000-\u001f]+/g;
  const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const esc = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = new RegExp(`(?<![a-zA-Z])${esc}(?![a-zA-Z])`, "i");

  const catalogItemBlocks = extractCatalogItemBlocks(text);
  const matchingItemBlock = catalogItemBlocks.find((block) => nameRe.test(block));
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  let relevant = matchingItemBlock
    ? [matchingItemBlock]
    : paras.filter((p) => nameRe.test(p));

  if (!relevant.length) return undefined;

  const moreSpecificTerms = (allEntityNames ?? []).filter((name) => {
    if (!name || name.toLowerCase() === searchTerm.toLowerCase()) return false;
    return nameRe.test(name);
  });
  if (moreSpecificTerms.length) {
    const exclusive = relevant.filter((para) => {
      let copy = para;
      for (const specific of moreSpecificTerms) {
        copy = copy.replace(
          new RegExp(
            `(?<![a-zA-Z])${specific.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z])`,
            "gi",
          ),
          " ",
        );
      }
      return nameRe.test(copy);
    });
    if (!exclusive.length) return undefined;
    relevant = exclusive;
  }

  const mcpFields: Array<{ label: string; value: string }> = [];
  const fieldRe = /(?:^|\n)(?:[-*]\s*)?(?:\*\*([^*:]+):\*\*|([^:\n]+):)\s*(.+)/g;
  const relevantBlock = relevant.join("\n");
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(relevantBlock)) !== null && mcpFields.length < 8) {
    const label = (fm[1] ?? fm[2] ?? "").trim().replace(/^[-*]\s*/, "");
    const value = fm[3].replace(/\*\*/g, "").trim();
    const reconstructedUrl = /^(?:https?)$/i.test(label) && value.startsWith("//") ? `${label}:${value}` : "";
    if (isLikelyUrl(value) || (reconstructedUrl && isLikelyUrl(reconstructedUrl))) {
      continue;
    }
    if (label && value) mcpFields.push({ label, value });
  }

  const urlSet = new Map<string, string>();
  for (const para of relevant) {
    MARKDOWN_LINK_RE.lastIndex = 0;
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = MARKDOWN_LINK_RE.exec(para)) !== null) {
      urlSet.set(markdownMatch[2].replace(/[.,;:!?)]+$/, ""), markdownMatch[1].trim());
    }

    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(para)) !== null) {
      const url = m[0].replace(/[.,;:!?)]+$/, "");
      if (!urlSet.has(url)) urlSet.set(url, "");
    }
  }

  const nameIdx = text.search(nameRe);
  if (nameIdx >= 0) {
    const chunk = text.slice(Math.max(0, nameIdx - 60), nameIdx + 900);
    MARKDOWN_LINK_RE.lastIndex = 0;
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = MARKDOWN_LINK_RE.exec(chunk)) !== null) {
      const url = markdownMatch[2].replace(/[.,;:!?)]+$/, "");
      if (!urlSet.has(url)) urlSet.set(url, markdownMatch[1].trim());
    }

    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(chunk)) !== null) {
      const url = m[0].replace(/[.,;:!?)]+$/, "");
      if (!urlSet.has(url)) urlSet.set(url, "");
    }
  }

  const summary = mcpFields.length
    ? ""
    : relevant.slice(0, 3).join(" ").replace(/\s+/g, " ").trim().slice(0, 420);

  const links = [...urlSet.entries()]
    .slice(0, 4)
    .map(([url, explicitLabel]) => {
      return { url, label: labelForUrl(url, explicitLabel) };
    });

  return { summary, links, ...(mcpFields.length ? { mcpFields } : {}) };
}

function enrichGeoEntityContext(entities: GeoEntity[], corpus: string): GeoEntity[] {
  const deduped = dedupeGeoEntities(entities);
  const allEntityNames = deduped.map((entity) => getGeoEntityDisplayName(entity));

  for (const entity of deduped) {
    if (entity.context) continue;
    const term = getGeoEntityDisplayName(entity);
    entity.context = extractEntityContext(corpus, term, allEntityNames);
  }

  return deduped;
}

function collectSourceGeoEntities(
  mcpToolArgs: Record<string, unknown>[],
  toolOutputTexts: string[] = [],
): GeoEntity[] {
  const entities: GeoEntity[] = [];
  const focusLabels = collectRequestedFocusLabels("", mcpToolArgs);
  const hasPointNear = (lat: number, lon: number) =>
    entities.some(
      (e) =>
        e.kind === "point" &&
        e.origin === "source" &&
        Math.abs((e as GeoPoint).lat - lat) < 0.05 &&
        Math.abs((e as GeoPoint).lon - lon) < 0.05,
    );

  for (const args of mcpToolArgs) {
    const lat = Number(args.latitude ?? args.lat ?? NaN);
    const lon = Number(args.longitude ?? args.lon ?? args.long ?? NaN);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      const label = String(args.location ?? args.city ?? args.name ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      if (!hasPointNear(lat, lon)) {
        entities.push({ kind: "point", origin: "source", label, lat, lon });
      }
    }
  }

  for (const output of toolOutputTexts) {
    const parsed = tryParseJson(output);
    const structuredEntities = parsed ? extractStructuredRecordGeoEntities(parsed, focusLabels) : [];
    if (structuredEntities.length) {
      entities.push(...structuredEntities);
    }

    const hints: {
      coords: Array<{ lat: number; lon: number; label?: string }>;
      extents: Array<{ label: string; west: number; south: number; east: number; north: number }>;
      names: string[];
    } = {
      coords: [],
      extents: [],
      names: [],
    };

    if (parsed) collectGeoHintsFromJson(parsed, hints);
    collectGeoHintsFromText(output, hints);

    const hasExplicitGeometryInOutput = hints.coords.length > 0 || hints.extents.length > 0;

    for (const extent of hints.extents) {
      entities.push({
        kind: "extent",
        origin: "source",
        label: extent.label,
        west: extent.west,
        south: extent.south,
        east: extent.east,
        north: extent.north,
      });
    }

    for (const c of hints.coords) {
      if (!hasPointNear(c.lat, c.lon)) {
        const label = c.label?.trim() || `${c.lat.toFixed(2)}°, ${c.lon.toFixed(2)}°`;
        entities.push({ kind: "point", origin: "source", label, lat: c.lat, lon: c.lon });
      }
    }

    if (hasExplicitGeometryInOutput || structuredEntities.length) {
      continue;
    }

    for (const rawName of hints.names) {
      const name = rawName.trim();
      if (!name) continue;
      entities.push({ kind: "named", origin: "source", name } satisfies GeoNamedPlace);
    }
  }

  return dedupeGeoEntities(entities);
}

function extractSourceExtentEntitiesFromText(text: string): GeoExtent[] {
  const entities: GeoExtent[] = [];
  const catalogItemBlocks = extractCatalogItemBlocks(text);

  for (const block of catalogItemBlocks) {
    const label = deriveCatalogItemLabel(block);
    if (!label) continue;

    const bboxMatch = block.match(
      /bbox:\s*(?:\[\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*\]|\[\s*\n\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*\n\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*\n\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*\n\s*(-?\d{1,3}(?:\.\d+)?)\s*\n\s*\])/i,
    );
    if (!bboxMatch) continue;

    const values = bboxMatch.slice(1).filter((value) => value != null && value !== "");
    const west = Number(values[0]);
    const south = Number(values[1]);
    const east = Number(values[2]);
    const north = Number(values[3]);
    if ([west, south, east, north].some((value) => isNaN(value))) continue;
    if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90) continue;
    if (west >= east || south >= north) continue;

    entities.push({
      kind: "extent",
      origin: "source",
      label,
      west,
      south,
      east,
      north,
    });
  }

  return entities;
}

function collectSourceGeoEntitiesFromText(text: string): GeoEntity[] {
  const entities: GeoEntity[] = [];
  const hints: {
    coords: Array<{ lat: number; lon: number; label?: string }>;
    extents: Array<{ label: string; west: number; south: number; east: number; north: number }>;
    names: string[];
  } = {
    coords: [],
    extents: [],
    names: [],
  };

  const parsed = tryParseJson(text);
  if (parsed) collectGeoHintsFromJson(parsed, hints);
  collectGeoHintsFromText(text, hints);

  for (const coord of hints.coords) {
    entities.push({
      kind: "point",
      origin: "source",
      label: coord.label?.trim() || `${coord.lat.toFixed(2)}°, ${coord.lon.toFixed(2)}°`,
      lat: coord.lat,
      lon: coord.lon,
    });
  }

  for (const extent of hints.extents) {
    entities.push({
      kind: "extent",
      origin: "source",
      label: extent.label,
      west: extent.west,
      south: extent.south,
      east: extent.east,
      north: extent.north,
    });
  }

  entities.push(...extractSourceExtentEntitiesFromText(text));

  return dedupeGeoEntities(entities);
}

function normalizeFocusLabel(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function toDisplayFocusLabel(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function collectRequestedFocusLabels(userText: string, mcpToolArgs: Record<string, unknown>[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  const pushLabel = (raw: unknown) => {
    const value = String(raw ?? "").trim();
    if (!value || value.length > 120) return;
    const normalized = normalizeFocusLabel(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    labels.push(value);
  };

  const collectFromText = (raw: unknown) => {
    const text = String(raw ?? "").trim();
    if (!text) return;

    const prepositionMatches = text.matchAll(/\b(?:in|for|from|about|near|around)\s+([\p{L}'’.-]+(?:\s+[\p{L}'’.-]+){0,3})\b/giu);
    for (const match of prepositionMatches) {
      const candidate = toDisplayFocusLabel(match[1]);
      if (candidate.length >= 2 && candidate.length <= 80) pushLabel(candidate);
    }

    const quotedMatches = text.matchAll(/["'“”‘’]([\p{L}'’.-]+(?:\s+[\p{L}'’.-]+){0,3})["'“”‘’]/gu);
    for (const match of quotedMatches) {
      const candidate = match[1].trim();
      if (candidate.length >= 2 && candidate.length <= 80) pushLabel(candidate);
    }

    if (!labels.length) {
      const trailing = text.match(/([\p{L}'’.-]+(?:\s+[\p{L}'’.-]+){0,3})\s*[?.!]?$/u)?.[1]?.trim();
      if (trailing && trailing.length >= 2 && trailing.length <= 80) {
        pushLabel(toDisplayFocusLabel(trailing));
      }
    }
  };

  collectFromText(userText);

  for (const args of mcpToolArgs) {
    collectFromText(args.location);
    collectFromText(args.city);
    collectFromText(args.place);
    collectFromText(args.name);
    collectFromText(args.query);
    collectFromText(args.q);
  }
  return labels;
}

function nameMatchesRequestedFocus(name: string, focusLabels: string[]): boolean {
  const normalizedName = normalizeFocusLabel(name);
  if (!normalizedName) return false;

  return focusLabels.some((focus) => {
    const normalizedFocus = normalizeFocusLabel(focus);
    return Boolean(normalizedFocus) && (normalizedName.includes(normalizedFocus) || normalizedFocus.includes(normalizedName));
  });
}

function nameEqualsRequestedFocus(name: string, focusLabels: string[]): boolean {
  const normalizedName = normalizeFocusLabel(name);
  if (!normalizedName) return false;

  return focusLabels.some((focus) => normalizeFocusLabel(focus) === normalizedName);
}

function contextMatchesRequestedFocus(context: GeoContext | undefined, focusLabels: string[]): boolean {
  if (!context) return false;

  const haystack = [
    context.summary,
    ...(context.mcpFields ?? []).map((field) => `${field.label}: ${field.value}`),
    ...(context.links ?? []).map((link) => `${link.label} ${link.url}`),
  ]
    .filter(Boolean)
    .join(" ");

  return nameMatchesRequestedFocus(haystack, focusLabels);
}

function mergeGeoContexts(contexts: Array<GeoContext | undefined>): GeoContext | undefined {
  const available = contexts.filter((context): context is GeoContext => Boolean(context));
  if (!available.length) return undefined;

  const summary = available
    .map((context) => context.summary?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 4)
    .join(" ")
    .trim();

  const links = available
    .flatMap((context) => context.links ?? [])
    .filter((link, index, links) => links.findIndex((candidate) => candidate.url === link.url) === index)
    .slice(0, 6);

  const mcpFields = available
    .flatMap((context) => context.mcpFields ?? [])
    .filter((field, index, fields) =>
      fields.findIndex((candidate) => candidate.label === field.label && candidate.value === field.value) === index,
    )
    .slice(0, 10);

  if (!summary && !links.length && !mcpFields.length) return undefined;

  return {
    summary,
    links,
    ...(mcpFields.length ? { mcpFields } : {}),
  };
}

function withContextFallback<T extends GeoEntity>(entity: T, fallbackContext?: GeoContext): T {
  if (entity.context || !fallbackContext) {
    return entity;
  }
  return {
    ...entity,
    context: fallbackContext,
  };
}

export function prioritizeRequestedGeoFocus(
  entities: GeoEntity[],
  userText: string,
  mcpToolArgs: Record<string, unknown>[],
): GeoEntity[] {
  const focusLabels = collectRequestedFocusLabels(userText, mcpToolArgs);
  if (!focusLabels.length) return entities;

  const hasExplicitGeometry = entities.some((entity) => entity.kind !== "named");
  const namedEntities = entities.filter((entity): entity is GeoNamedPlace => entity.kind === "named");
  const relatedNamed = namedEntities.filter((entity) =>
    nameMatchesRequestedFocus(entity.name, focusLabels) || contextMatchesRequestedFocus(entity.context, focusLabels),
  );
  const focusContext = mergeGeoContexts((relatedNamed.length ? relatedNamed : namedEntities).map((entity) => entity.context));

  if (!hasExplicitGeometry) {
    const richRelatedNamed = relatedNamed.filter((entity) => entity.context && contextMatchesRequestedFocus(entity.context, focusLabels));
    if (richRelatedNamed.length >= 2) {
      return dedupeGeoEntities(richRelatedNamed.map((entity) => withContextFallback(entity, focusContext)));
    }
  }

  const exactEntities = entities.filter((entity) => {
    const displayName = getGeoEntityDisplayName(entity);
    return nameEqualsRequestedFocus(displayName, focusLabels);
  });
  if (exactEntities.length) {
    return dedupeGeoEntities(exactEntities.map((entity) => withContextFallback(entity, focusContext)));
  }

  if (hasExplicitGeometry) {
    return entities;
  }

  if (!namedEntities.length) {
    return entities;
  }

  const exactNamed = namedEntities.filter((entity) => nameEqualsRequestedFocus(entity.name, focusLabels));
  if (exactNamed.length) {
    return dedupeGeoEntities(exactNamed.map((entity) => withContextFallback(entity, focusContext)));
  }

  return dedupeGeoEntities([
    {
      kind: "named",
      origin: "source",
      name: focusLabels[0],
      ...(focusContext ? { context: focusContext } : {}),
    } satisfies GeoNamedPlace,
  ]);
}

export async function deriveGeoEntities(
  text: string,
  mcpToolArgs: Record<string, unknown>[],
  toolOutputTexts: string[] = [],
): Promise<GeoEntity[]> {
  const entities = dedupeGeoEntities([
    ...collectSourceGeoEntities(mcpToolArgs, toolOutputTexts),
    ...collectSourceGeoEntitiesFromText(text),
  ]);
  if (!entities.length) return [];

  const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
  return enrichGeoEntityContext(entities, corpus);
}