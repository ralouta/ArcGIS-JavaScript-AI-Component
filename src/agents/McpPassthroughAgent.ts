import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
import { renderArbitraryGeoJson } from "../utils/mcpArbitraryRenderer";
import { GEOCODER_URL } from "../utils/arcgisConfig";
import { synthesizeGeoJson } from "../utils/mcpGeoJsonSynthesizer";
import { clearMcpGeoLayer, renderMcpGeoEntities, type GeoEntity, type GeoContext, type GeoPoint, type GeoCountry, type GeoRegion } from "../utils/mcpGeoRenderer";
import { setLastAssistantGeoSnapshot } from "../utils/assistantState";
import { resolveArcgisMcpBaseUrl } from "../utils/arcgisMcp";
import { searchPortalLayerByName } from "../utils/arcgisOnline";

export interface McpPassthroughAgentContext {
  baseUrl?: string;
  serverName?: string;
}

interface ToolAliasMap {
  [alias: string]: string;
}

interface GeoRenderPlanLocation {
  label: string;
  kind: "point" | "country" | "region";
  origin: "source" | "context";
  lat?: number;
  lon?: number;
  description?: string;
}

interface SynthesizedFeatureLike {
  title: string;
  description?: string;
  geometryType: "Point" | "LineString" | "Polygon" | "MultiPoint" | "MultiLineString" | "MultiPolygon" | "none";
  coordinates?: unknown;
  properties: Record<string, unknown>;
  renderHint: "point" | "line" | "polygon";
  layerGroup?: string;
  imageUrl?: string;
}

let latestGeoRenderToken = 0;
let pendingGeoRenderTimer: number | null = null;
let latestMcpRunToken = 0;
const cancelBoundAssistants = new WeakSet<HTMLElement>();
const activeMcpAbortControllers = new Set<AbortController>();

function beginMcpAbortController(): AbortController {
  const controller = new AbortController();
  activeMcpAbortControllers.add(controller);
  return controller;
}

function endMcpAbortController(controller: AbortController): void {
  activeMcpAbortControllers.delete(controller);
}

function abortActiveMcpRequests(): void {
  for (const controller of activeMcpAbortControllers) {
    controller.abort();
  }
  activeMcpAbortControllers.clear();
}

function isMcpRunStale(runToken: number): boolean {
  return runToken !== latestMcpRunToken;
}

function isAbortLikeError(error: unknown): boolean {
  const name = (error as any)?.name;
  const message = String((error as any)?.message ?? "");
  return name === "AbortError" || /abort/i.test(message);
}

function isPreviewImageUrl(url: string): boolean {
  return /^https?:\/\/\S+/i.test(url) && /(?:^|[/?#_.-])(thumbnail|preview|overview|render|image)|\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(url);
}

function extractEntityPreviewImageUrl(entity: GeoEntity): string | undefined {
  return entity.context?.links?.find((link) => isPreviewImageUrl(link.url))?.url;
}

function mergeSynthesizedPointEntities(
  synthesized: { features: SynthesizedFeatureLike[]; hasExplicitGeometry: boolean },
  entities: GeoEntity[],
): { features: SynthesizedFeatureLike[]; hasExplicitGeometry: boolean } {
  const merged = [...synthesized.features];
  const seen = new Set(
    merged.map((feature) => {
      if (feature.geometryType !== "Point" || !Array.isArray(feature.coordinates)) return null;
      const [lon, lat] = feature.coordinates as [number, number];
      return `${feature.title.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    }).filter(Boolean) as string[],
  );

  for (const entity of entities) {
    if (entity.kind !== "point") continue;
    const key = `${entity.label.toLowerCase()}|${entity.lat.toFixed(3)}|${entity.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      title: entity.label,
      description: entity.description,
      geometryType: "Point",
      coordinates: [entity.lon, entity.lat],
      properties: {
        origin: entity.origin,
        ...(entity.context?.summary ? { summary: entity.context.summary } : {}),
        ...(entity.context?.links?.length
          ? { links: entity.context.links.map((link) => link.url).join(" | ") }
          : {}),
      },
      renderHint: "point",
      layerGroup: entity.origin === "source" ? "Results" : "Context",
      imageUrl: extractEntityPreviewImageUrl(entity),
    });
  }

  return { ...synthesized, features: merged };
}

export function cancelPendingMcpGeoRender(): void {
  latestMcpRunToken += 1;
  abortActiveMcpRequests();
  latestGeoRenderToken += 1;
  if (pendingGeoRenderTimer != null) {
    globalThis.clearTimeout(pendingGeoRenderTimer);
    pendingGeoRenderTimer = null;
  }
  clearMcpGeoLayer();
}

function bindAssistantCancel(assistant: HTMLElement): void {
  if (cancelBoundAssistants.has(assistant)) {
    return;
  }

  assistant.addEventListener("arcgisCancel", () => {
    cancelPendingMcpGeoRender();
  });
  cancelBoundAssistants.add(assistant);
}

// ── MCP JSON-RPC Client ───────────────────────────────────────────────────────

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface KnowledgeBaseToolField {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

interface KnowledgeBaseToolRecord {
  name: string;
  description?: string;
  fields?: KnowledgeBaseToolField[];
  requiredFieldCount?: number;
}

interface KnowledgeBaseServerRecord {
  id: string;
  label: string;
  status?: string;
  capabilitySummary?: string[];
  tools?: KnowledgeBaseToolRecord[];
}

interface McpKnowledgeBaseDocument {
  generatedAt?: string;
  servers?: KnowledgeBaseServerRecord[];
}

/**
 * Normalise a user-supplied URL:
 *  - 0.0.0.0 → 127.0.0.1 (not reachable as a client target in some environments)
 *  - strip trailing slashes
 */
function normalizeUrl(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\b0\.0\.0\.0\b/, "127.0.0.1");
}

/**
 * Convert an absolute URL to the Vite dev-relay path so the browser can
 * reach any local/remote MCP server without CORS restrictions.
 *   http://127.0.0.1:8000/sse  →  /dev-mcp-relay/http/127.0.0.1:8000/sse
 */
function toRelayUrl(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    const scheme = u.protocol.replace(":", "");
    return `/dev-mcp-relay/${scheme}/${u.host}${u.pathname}`;
  } catch {
    return absoluteUrl; // relative path — use as-is
  }
}

/** Resolve a URL for fetch: absolute URLs go through the relay; relative stay as-is. */
function resolveFetchUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? toRelayUrl(url) : url;
}

/**
 * Low-level JSON-RPC 2.0 POST to an MCP endpoint.
 * Handles both direct JSON and SSE (text/event-stream) responses.
 */
async function mcpPost(fetchUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const controller = beginMcpAbortController();
  try {
    const response = await fetch(fetchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 300); } catch {}
      throw new Error(
        `MCP server returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    const ct = response.headers.get("Content-Type") ?? "";

    // SSE transport: scan data lines for the first JSON-RPC result
    if (ct.includes("text/event-stream")) {
      const text = await response.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          const parsed: any = JSON.parse(line.slice(6).trim());
          if (parsed.error) throw new Error(String(parsed.error.message ?? "MCP RPC error"));
          if ("result" in parsed) return parsed.result;
        }
      }
      throw new Error("No JSON-RPC result found in MCP SSE response.");
    }

    const json: any = await response.json();
    if (json.error) throw new Error(String(json.error.message ?? "MCP RPC error"));
    return json.result;
  } finally {
    endMcpAbortController(controller);
  }
}

/** Send a JSON-RPC 2.0 request to the endpoint URL provided by the user. */
function mcpRequest(endpointUrl: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  return mcpPost(url, { jsonrpc: "2.0", id: 1, method, params });
}

/** Fire-and-forget JSON-RPC 2.0 notification (no id). */
async function mcpNotify(endpointUrl: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  const controller = beginMcpAbortController();
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    signal: controller.signal,
  }).catch(() => {}).finally(() => {
    endMcpAbortController(controller);
  });
}

// ── Session Setup & Tool Discovery ────────────────────────────────────────────

/** Track which endpoint URLs have completed the MCP initialize handshake. */
const initializedEndpoints = new Set<string>();

/** Cached tool definitions per endpoint URL (short-lived to avoid stale names). */
const mcpToolsCache = new Map<string, { tools: McpToolDef[]; at: number }>();
const TOOL_CACHE_TTL_MS = 10_000;
const knowledgeBaseCache = new Map<string, { document: McpKnowledgeBaseDocument | null; at: number }>();
const KNOWLEDGE_BASE_CACHE_TTL_MS = 10_000;

function resolveKnowledgeBaseUrl(endpointUrl: string): string {
  const normalized = normalizeUrl(endpointUrl);
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      url.pathname = url.pathname.replace(/\/?mcp\/?$/i, "") || "/";
      url.pathname = `${url.pathname.replace(/\/+$/, "") || ""}/knowledge-base`;
      url.search = "";
      return url.toString();
    } catch {
      return `${normalized.replace(/\/+$/, "")}/knowledge-base`;
    }
  }
  return `${normalized.replace(/\/+$/, "")}/knowledge-base`;
}

async function fetchMcpKnowledgeBase(endpointUrl: string): Promise<McpKnowledgeBaseDocument | null> {
  const key = normalizeUrl(endpointUrl);
  const cached = knowledgeBaseCache.get(key);
  if (cached && Date.now() - cached.at < KNOWLEDGE_BASE_CACHE_TTL_MS) {
    return cached.document;
  }

  const fetchUrl = resolveFetchUrl(resolveKnowledgeBaseUrl(endpointUrl));
  const controller = beginMcpAbortController();
  try {
    const response = await fetch(fetchUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      knowledgeBaseCache.set(key, { document: null, at: Date.now() });
      return null;
    }
    const document = (await response.json()) as McpKnowledgeBaseDocument;
    knowledgeBaseCache.set(key, { document, at: Date.now() });
    return document;
  } catch {
    knowledgeBaseCache.set(key, { document: null, at: Date.now() });
    return null;
  } finally {
    endMcpAbortController(controller);
  }
}

function selectKnowledgeBaseServers(
  document: McpKnowledgeBaseDocument | null,
  tools: McpToolDef[],
): KnowledgeBaseServerRecord[] {
  const servers = Array.isArray(document?.servers) ? document!.servers! : [];
  if (!servers.length) return [];

  const prefixedServerIds = new Set(
    tools
      .map((tool) => {
        const match = tool.name.match(/^([^_]+(?:-[^_]+)*)__/);
        return match?.[1] ?? null;
      })
      .filter((value): value is string => Boolean(value)),
  );

  if (prefixedServerIds.size) {
    return servers.filter((server) => prefixedServerIds.has(server.id));
  }

  if (servers.length === 1) return servers;
  return servers.filter((server) => server.status === "running" && (server.tools?.length ?? 0) > 0);
}

function truncateSentence(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapePromptTemplateText(value: string): string {
  return value.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

function buildKnowledgeBaseDescriptionSupplement(
  document: McpKnowledgeBaseDocument | null,
  tools: McpToolDef[],
): string {
  const servers = selectKnowledgeBaseServers(document, tools);
  if (!servers.length) return "";

  const lines: string[] = ["", "Persisted MCP capability notes:"];
  for (const server of servers.slice(0, 4)) {
    const summaries = (server.capabilitySummary ?? []).filter(Boolean).slice(0, 2);
    if (summaries.length) {
      lines.push(`- ${server.label}: ${summaries.map((summary) => truncateSentence(summary, 160)).join(" | ")}`);
      continue;
    }

    const toolHints = (server.tools ?? [])
      .slice(0, 3)
      .map((tool) => {
        const requiredFields = (tool.fields ?? []).filter((field) => field.required).map((field) => field.name);
        return requiredFields.length
          ? `${tool.name} (requires: ${requiredFields.join(", ")})`
          : tool.name;
      });
    if (toolHints.length) {
      lines.push(`- ${server.label}: ${toolHints.join("; ")}`);
    }
  }

  return lines.join("\n");
}

function buildKnowledgeBasePromptSupplement(
  document: McpKnowledgeBaseDocument | null,
  tools: McpToolDef[],
): string {
  const servers = selectKnowledgeBaseServers(document, tools);
  if (!servers.length) return "";

  const sections: string[] = [
    "",
    "KNOWLEDGE-BASE GUIDANCE:",
    "- Use the persisted MCP capability notes below as prior knowledge about what the connected server can discover.",
    "- If a documented search, list, browse, lookup, or discovery tool exists, use it before asking the user for opaque internal identifiers.",
    "- Preserve concrete user constraints like place, year, output format, and scope while you use discovery tools to resolve missing internal IDs or provider-specific parameters.",
    "- Ask a clarification question only after you have tried the documented discovery path and still cannot disambiguate the request.",
  ];

  for (const server of servers.slice(0, 4)) {
    sections.push(`- Server ${server.label}:`);
    const summaries = (server.capabilitySummary ?? []).filter(Boolean).slice(0, 3);
    for (const summary of summaries) {
      sections.push(`  ${truncateSentence(summary, 220)}`);
    }

    const toolLines = (server.tools ?? []).slice(0, 6).map((tool) => {
      const requiredFields = (tool.fields ?? []).filter((field) => field.required).map((field) => field.name);
      const fieldHint = requiredFields.length ? ` required=${requiredFields.join(",")}` : "";
      const description = tool.description ? ` ${truncateSentence(tool.description, 180)}` : "";
      return `  - ${tool.name}${fieldHint}${description}`;
    });
    sections.push(...toolLines);
  }

  return escapePromptTemplateText(sections.join("\n"));
}

/**
 * Run the MCP initialize → notifications/initialized handshake once per URL.
 * Required by the spec before tools/list or tools/call.
 */
async function ensureInitialized(endpointUrl: string): Promise<void> {
  const key = normalizeUrl(endpointUrl);
  if (initializedEndpoints.has(key)) return;
  await mcpRequest(endpointUrl, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "mcp-passthrough-agent", version: "1.0.0" },
  });
  await mcpNotify(endpointUrl, "notifications/initialized");
  initializedEndpoints.add(key);
}

/** Clear cached state for a given endpoint (used when switching servers). */
function clearMcpCaches(endpointUrl: string): void {
  const key = normalizeUrl(endpointUrl);
  initializedEndpoints.delete(key);
  mcpToolsCache.delete(key);
  knowledgeBaseCache.delete(key);
}

/** Discover tools from the MCP server. Cached after first call. */
async function listMcpTools(endpointUrl: string): Promise<McpToolDef[]> {
  const key = normalizeUrl(endpointUrl);
  const cached = mcpToolsCache.get(key);
  if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/list");
  const tools: McpToolDef[] = Array.isArray(result?.tools) ? result.tools : [];
  mcpToolsCache.set(key, { tools, at: Date.now() });
  return tools;
}

/** Call a specific tool on the MCP server. */
async function callMcpTool(endpointUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/call", { name, arguments: args });
  if (result?.isError) {
    return `Tool returned an error: ${extractText(result.content) || "Unknown tool error."}`;
  }
  return extractText(result?.content) || JSON.stringify(result ?? "");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return JSON.stringify(part);
      })
      .join("\n")
      .trim();
  }
  return content != null ? JSON.stringify(content) : "";
}

// ── JSON Schema → Zod (best-effort for common shapes) ────────────────────────

function jsonPropToZod(prop: Record<string, unknown>, isRequired: boolean): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const desc = typeof prop.description === "string" ? prop.description : undefined;

  let schema: z.ZodTypeAny;
  switch (type) {
    case "integer":
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(z.unknown());
      break;
    case "object":
      schema = z.record(z.string(), z.unknown());
      break;
    default:
      schema = z.string();
  }

  if (desc) schema = schema.describe(desc);
  if (!isRequired) schema = schema.optional();
  return schema;
}

function inputSchemaToZod(inputSchema?: Record<string, unknown>): z.ZodTypeAny {
  if (!inputSchema || inputSchema.type !== "object") return z.record(z.string(), z.unknown());
  const properties = inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || !Object.keys(properties).length) return z.object({});
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    shape[key] = jsonPropToZod(prop, required.includes(key));
  }
  return z.object(shape);
}

// ── LangGraph helpers ─────────────────────────────────────────────────────────

function normalizeMessages(messages: any): any[] {
  const rawMessages = Array.isArray(messages) ? messages : [];
  if (rawMessages.length === 1 && Array.isArray(rawMessages[0])) return rawMessages[0];
  return rawMessages.flatMap((m: any) => (Array.isArray(m) ? m : [m]));
}

function getLastAiMessage(messages: any[]): AIMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (AIMessage.isInstance(messages[i])) return messages[i];
  }
  return null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function makeSafeToolAlias(index: number): string {
  // Keep names short and provider-safe for function/tool calling.
  return `mcp_tool_${index + 1}`;
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // direct JSON
  try {
    return JSON.parse(trimmed);
  } catch {}

  // fenced JSON block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  return undefined;
}

function collectGeoHintsFromJson(
  value: unknown,
  out: { coords: Array<{ lat: number; lon: number; label?: string }>; names: string[] },
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
      latSpan <= 160 &&
      primaryLabel
    ) {
      out.coords.push({
        lat: (south + north) / 2,
        lon: (west + east) / 2,
        label: primaryLabel,
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

function collectGeoHintsFromText(
  text: string,
  out: { coords: Array<{ lat: number; lon: number; label?: string }>; names: string[] },
): void {
  const sections = text.split(/\n\s*---\s*\n/g).map((section) => section.trim()).filter(Boolean);

  for (const section of sections) {
    const heading = section.match(/^##\s+(.+)$/m)?.[1]?.trim();
    const fullName = section.match(/\*\*Full Name:\*\*\s*(.+)$/m)?.[1]?.trim();
    const locationLine = section.match(/\*\*Location:\*\*\s*(.+)$/m)?.[1]?.trim();
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

    const candidateNames = [fullName, heading, locationLine].filter(
      (value): value is string => Boolean(value && value.trim()),
    );
    for (const candidate of candidateNames) {
      if (candidate.length >= 2 && candidate.length <= 120) out.names.push(candidate);
    }
  }
}

function normalizeCountryName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return KNOWN_COUNTRIES.find((country) => country.toLowerCase() === name) ?? null;
}

function dedupeGeoEntities(entities: GeoEntity[]): GeoEntity[] {
  const seen = new Set<string>();
  const out: GeoEntity[] = [];

  for (const entity of entities) {
    let key = "";
    if (entity.kind === "point") {
      key = [
        entity.origin,
        entity.kind,
        entity.label.trim().toLowerCase(),
        entity.lat.toFixed(3),
        entity.lon.toFixed(3),
      ].join(":");
    } else {
      key = [entity.origin, entity.kind, entity.name.trim().toLowerCase()].join(":");
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entity);
  }

  return out;
}

function enrichGeoEntityContext(entities: GeoEntity[], corpus: string): GeoEntity[] {
  const deduped = dedupeGeoEntities(entities);
  const allEntityNames = deduped.map((entity) =>
    entity.kind === "point"
      ? (entity as GeoPoint).label
      : (entity as GeoCountry | GeoRegion).name,
  );

  for (const entity of deduped) {
    if (entity.context) continue;
    const term = entity.kind === "point"
      ? (entity as GeoPoint).label
      : (entity as GeoCountry | GeoRegion).name;
    entity.context = extractEntityContext(corpus, term, allEntityNames);
  }

  return deduped;
}

function collectSourceGeoEntities(
  mcpToolArgs: Record<string, unknown>[],
  toolOutputTexts: string[] = [],
): GeoEntity[] {
  const entities: GeoEntity[] = [];
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
    const hints: { coords: Array<{ lat: number; lon: number; label?: string }>; names: string[] } = {
      coords: [],
      names: [],
    };

    const parsed = tryParseJson(output);
    if (parsed) collectGeoHintsFromJson(parsed, hints);
    collectGeoHintsFromText(output, hints);

    for (const c of hints.coords) {
      if (!hasPointNear(c.lat, c.lon)) {
        const label = c.label?.trim() || `${c.lat.toFixed(2)}°, ${c.lon.toFixed(2)}°`;
        entities.push({ kind: "point", origin: "source", label, lat: c.lat, lon: c.lon });
      }
    }

    for (const rawName of hints.names) {
      const name = rawName.trim();
      if (!name) continue;
      const lowerName = name.toLowerCase();
      const mappedRegion = REGION_TEXT_ALIASES[lowerName];
      if (mappedRegion) {
        entities.push({ kind: "region", origin: "source", name: mappedRegion });
        continue;
      }
      const matchedCountry = normalizeCountryName(name);
      if (matchedCountry) {
        entities.push({ kind: "country", origin: "source", name: matchedCountry });
      }
    }
  }

  return dedupeGeoEntities(entities);
}

async function deriveGeoRenderPlan(
  text: string,
  mcpToolArgs: Record<string, unknown>[],
  toolOutputTexts: string[] = [],
): Promise<GeoRenderPlanLocation[]> {
  const plannerTool = tool(
    async (args: any) => JSON.stringify(args),
    {
      name: "submit_geo_render_plan",
      description: "Submit the geographic render plan for the response. Return only the locations that should appear on the map.",
      schema: z.object({
        locations: z.array(
          z.object({
            label: z.string().min(1),
            kind: z.enum(["point", "country", "region"]),
            origin: z.enum(["source", "context"]),
            lat: z.number().optional(),
            lon: z.number().optional(),
            description: z.string().optional(),
          }),
        ).default([]),
      }),
    },
  );

  const planningPrompt = [
    "Create a map render plan for the ArcGIS app.",
    "Decide dynamically which geometries should be shown based on the response and tool outputs.",
    "Rules:",
    "- Prefer point for specific places, sites, catalogs, incidents, cities, states, or single-location datasets.",
    "- Prefer country only for country-scale results.",
    "- Prefer region only for broad regional extents.",
    "- Use origin=source when the location is directly supported by tool arguments or tool output.",
    "- Use origin=context when the assistant narrative adds a place that is not explicit in source coordinates/data.",
    "- Do not invent locations.",
    "- Do not create duplicate entries for the same place unless they are meaningfully different geometries.",
    "- For asset catalogs, weather, fire, or similar place-centric responses, usually return a point instead of only a polygon.",
    "Call submit_geo_render_plan exactly once.",
    "",
    "Assistant response:",
    text,
    "",
    "Tool arguments JSON:",
    JSON.stringify(mcpToolArgs, null, 2),
    "",
    "Tool outputs:",
    toolOutputTexts.join("\n\n---\n\n"),
  ].join("\n");

  try {
    const response = await invokeToolPrompt({
      promptText: "You are a map-orchestration planner that converts tool results into the right map geometry plan.",
      messages: [new HumanMessage(planningPrompt)],
      tools: [plannerTool],
      temperature: 0,
    });

    const toolCalls = Array.isArray((response as any)?.tool_calls) ? (response as any).tool_calls : [];
    const call = toolCalls.find((toolCall: any) => toolCall?.name === "submit_geo_render_plan");
    const locations = Array.isArray(call?.args?.locations) ? call.args.locations : [];
    return locations.filter((location: any) =>
      location &&
      typeof location.label === "string" &&
      ["point", "country", "region"].includes(location.kind) &&
      ["source", "context"].includes(location.origin),
    );
  } catch {
    return [];
  }
}

async function planLocationsToGeoEntities(
  locations: GeoRenderPlanLocation[],
): Promise<GeoEntity[]> {
  const entities: GeoEntity[] = [];

  for (const location of locations) {
    if (location.kind === "country") {
      const country = normalizeCountryName(location.label);
      if (country) {
        entities.push({
          kind: "country",
          origin: location.origin,
          name: country,
          description: location.description,
        });
      }
      continue;
    }

    if (location.kind === "region") {
      entities.push({
        kind: "region",
        origin: location.origin,
        name: REGION_TEXT_ALIASES[location.label.trim().toLowerCase()] ?? location.label.trim(),
        description: location.description,
      });
      continue;
    }

    const lat = Number(location.lat);
    const lon = Number(location.lon);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      entities.push({
        kind: "point",
        origin: location.origin,
        label: location.label.trim(),
        lat,
        lon,
        description: location.description,
      });
      continue;
    }

    const geocoded = await geocodePlaceLabel(location.label.trim());
    if (geocoded) {
      entities.push({
        kind: "point",
        origin: location.origin,
        label: location.label.trim(),
        lat: geocoded.lat,
        lon: geocoded.lon,
        description: location.description,
      });
    }
  }

  return dedupeGeoEntities(entities);
}

// ── Geo extraction support ────────────────────────────────────────────────────
//
// The main render path is planner-driven. Deterministic parsing remains as a
// fallback and for explicit source coordinates returned by MCP tools.

// World countries — matched case-insensitively against response text.
const KNOWN_COUNTRIES = [
  "Afghanistan","Albania","Algeria","Angola","Argentina","Armenia","Australia",
  "Austria","Azerbaijan","Bahrain","Bangladesh","Belarus","Belgium","Bolivia",
  "Bosnia","Brazil","Cambodia","Cameroon","Canada","Chile","China","Colombia",
  "Congo","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Ecuador",
  "Egypt","Ethiopia","Finland","France","Georgia","Germany","Ghana","Greece",
  "Guatemala","Haiti","Honduras","Hungary","India","Indonesia","Iran","Iraq",
  "Ireland","Israel","Italy","Japan","Jordan","Kazakhstan","Kenya","Kuwait",
  "Kyrgyzstan","Laos","Latvia","Lebanon","Libya","Lithuania","Malaysia",
  "Mali","Mexico","Moldova","Mongolia","Morocco","Mozambique","Myanmar",
  "Nepal","Netherlands","New Zealand","Nicaragua","Nigeria","North Korea",
  "Norway","Oman","Pakistan","Palestine","Panama","Paraguay","Peru",
  "Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda",
  "Saudi Arabia","Senegal","Serbia","Singapore","Somalia","South Africa",
  "South Korea","South Sudan","Spain","Sri Lanka","Sudan","Sweden",
  "Switzerland","Syria","Taiwan","Tajikistan","Tanzania","Thailand",
  "Tunisia","Turkey","Turkmenistan","UAE","Uganda","Ukraine",
  "United Arab Emirates","United Kingdom","United States","Uruguay",
  "Uzbekistan","Venezuela","Vietnam","Yemen","Zimbabwe",
];

// Mappings from human-readable region label → WOR_Boundaries REGION field value.
const REGION_TEXT_ALIASES: Record<string, string> = {
  "middle east":        "Western Asia",
  "western asia":       "Western Asia",
  "east asia":          "Eastern Asia",
  "southeast asia":     "Southeastern Asia",
  "south asia":         "Southern Asia",
  "central asia":       "Central Asia",
  "east africa":        "Eastern Africa",
  "west africa":        "Western Africa",
  "north africa":       "Northern Africa",
  "central africa":     "Middle Africa",
  "southern africa":    "Southern Africa",
  "sub-saharan africa": "Eastern Africa",
  "europe":             "Western Europe",
  "eastern europe":     "Eastern Europe",
  "western europe":     "Western Europe",
  "northern europe":    "Northern Europe",
  "southern europe":    "Southern Europe",
  "latin america":      "South America",
  "south america":      "South America",
  "central america":    "Central America",
  "north america":      "Northern America",
  "caribbean":          "Caribbean",
  "gulf":               "Western Asia",
  "gulf states":        "Western Asia",
  "caucasus":           "Western Asia",
  "balkans":            "Southern Europe",
  "oceania":            "Australia/New Zealand",
};

/**
 * Extract per-entity context: find sentences in the response that mention
 * the entity and collect any source URLs nearby. Zero LLM calls.
 */
function extractEntityContext(text: string, searchTerm: string, allEntityNames?: string[]): GeoContext | undefined {
  const URL_RE = /https?:\/\/[^\s\])'"<>,\u0000-\u001f]+/g;
  const esc = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = new RegExp(`(?<![a-zA-Z])${esc}(?![a-zA-Z])`, "i");

  // split on blank lines or newlines; keeps article-style paragraphs intact
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  let relevant = paras.filter((p) => nameRe.test(p));

  if (!relevant.length) return undefined;

  // Narrow to "exclusive" paragraphs: those where searchTerm appears as a
  // standalone concept — not only as part of a longer/more-specific entity
  // (e.g. "South Sudan" subsumes "Sudan"). Strip all such compounds from a
  // copy of the paragraph; if searchTerm still appears, the paragraph belongs
  // to this entity. If NO exclusive paragraphs exist, return undefined rather
  // than leaking another entity's context into this popup.
  const moreSpecificTerms = (allEntityNames ?? []).filter((name) => {
    if (!name || name.toLowerCase() === searchTerm.toLowerCase()) return false;
    return nameRe.test(name); // name contains searchTerm as a word-bounded substring
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
    if (!exclusive.length) return undefined; // only appeared inside compounds
    relevant = exclusive;
  }

  // Parse structured MCP key-value fields: **Key:** Value
  const mcpFields: Array<{ label: string; value: string }> = [];
  const fieldRe = /\*\*([^*:]+):\*\*\s*(.+)/g;
  const relevantBlock = relevant.join("\n");
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(relevantBlock)) !== null && mcpFields.length < 8) {
    const label = fm[1].trim();
    const value = fm[2].replace(/\*\*/g, "").trim();
    if (label && value) mcpFields.push({ label, value });
  }

  // Collect URLs from relevant paragraphs
  const urlSet = new Set<string>();
  for (const para of relevant) {
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(para)) !== null) urlSet.add(m[0].replace(/[.,;:!?)]+$/, ""));
  }

  // Also scan a window around the first occurrence in full text
  const nameIdx = text.search(nameRe);
  if (nameIdx >= 0) {
    const chunk = text.slice(Math.max(0, nameIdx - 60), nameIdx + 900);
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(chunk)) !== null) urlSet.add(m[0].replace(/[.,;:!?)]+$/, ""));
  }

  const summary = mcpFields.length
    ? ""
    : relevant.slice(0, 3).join(" ").replace(/\s+/g, " ").trim().slice(0, 420);

  const links = [...urlSet]
    .slice(0, 4)
    .map((url) => {
      try {
        const label = new URL(url).hostname.replace(/^www\./, "");
        return { url, label };
      } catch {
        return { url, label: url.slice(0, 40) };
      }
    });

  return { summary, links, ...(mcpFields.length ? { mcpFields } : {}) };
}

const NON_PLACE_LEFT = new Set([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
]);

const NON_PLACE_TERMS = new Set([
  "MCP", "STAC", "RA", "Items", "Collection", "Collections", "Notes", "Next", "Tell",
  "Asset", "Assets", "Catalog", "Metadata", "Item", "Collection-level",
  "Thumbnail", "External", "Specifications", "GeoPackage",
  "Leaf", "Above", "Phase", "Tile", "Index", "Endpoint",
]);

function extractPlaceMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /\b([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,3}),\s*([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,2})\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const left = m[1].trim();
    const right = m[2].trim();
    if (NON_PLACE_LEFT.has(left)) continue;
    if (/^\d+$/.test(left) || /^\d+$/.test(right)) continue;
    out.add(`${left}, ${right}`);
  }

  const standaloneRe = /\b(?:in|of|for|from|near|across|within)\s+([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,2})\b/gu;
  while ((m = standaloneRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!candidate || NON_PLACE_TERMS.has(candidate)) continue;
    out.add(candidate);
  }

  const parenRe = /\(([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,2})(?:,\s*\d{4}(?:[\u2013-]\d{4})?)?\)/gu;
  while ((m = parenRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!candidate || NON_PLACE_TERMS.has(candidate)) continue;
    out.add(candidate);
  }

  return [...out].slice(0, 10);
}

async function geocodePlaceLabel(label: string): Promise<{ lat: number; lon: number } | null> {
  const params = new URLSearchParams({
    f: "json",
    SingleLine: label,
    maxLocations: "1",
    outFields: "Match_addr,Addr_type,City,Region",
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

function normalizeMentionLabel(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function deriveSnapshotTitle(text: string): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Latest assistant results";
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0]?.trim() || cleaned;
  return firstSentence.length > 88 ? `${firstSentence.slice(0, 85).trimEnd()}...` : firstSentence;
}

function splitContextChunks(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function sourceEntityTerms(sourceEntities: GeoEntity[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entity of sourceEntities) {
    const raw = entity.kind === "point" ? entity.label : entity.name;
    const normalized = normalizeMentionLabel(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
  }
  return terms;
}

function contextPointRelatesToSource(
  pointLabel: string,
  corpus: string,
  sourceEntities: GeoEntity[],
): boolean {
  const terms = sourceEntityTerms(sourceEntities);
  if (!terms.length) return false;

  const normalizedPoint = normalizeMentionLabel(pointLabel);
  if (terms.some((term) => term.includes(normalizedPoint) || normalizedPoint.includes(term))) {
    return true;
  }

  const chunks = splitContextChunks(corpus);
  return chunks.some((chunk) => {
    const normalizedChunk = normalizeMentionLabel(chunk);
    return normalizedChunk.includes(normalizedPoint) && terms.some((term) => normalizedChunk.includes(term));
  });
}

function contextAreaRelatesToSource(
  areaName: string,
  corpus: string,
  sourceEntities: GeoEntity[],
  entity?: GeoCountry | GeoRegion,
): boolean {
  const terms = sourceEntityTerms(sourceEntities);
  if (!terms.length) return false;

  const normalizedArea = normalizeMentionLabel(areaName);
  if (!normalizedArea) return false;

  if (terms.some((term) => term.includes(normalizedArea) || normalizedArea.includes(term))) {
    return true;
  }

  const relatedText = [
    corpus,
    entity?.description ?? "",
    entity?.context?.summary ?? "",
    ...(entity?.context?.mcpFields ?? []).map((field) => `${field.label} ${field.value}`),
  ].filter(Boolean).join("\n\n");

  return splitContextChunks(relatedText).some((chunk) => {
    const normalizedChunk = normalizeMentionLabel(chunk);
    return normalizedChunk.includes(normalizedArea) && terms.some((term) => normalizedChunk.includes(term));
  });
}

function filterStrictContextGeometry(entities: GeoEntity[], corpus: string): GeoEntity[] {
  const sourceEntities = entities.filter((entity) => entity.origin === "source");
  if (!sourceEntities.length) {
    return entities.filter((entity) => entity.origin !== "context" || entity.kind !== "point");
  }

  return entities.filter((entity) => {
    if (entity.origin !== "context") return true;
    if (entity.kind === "point") {
      return contextPointRelatesToSource(entity.label, corpus, sourceEntities);
    }
    return contextAreaRelatesToSource(entity.name, corpus, sourceEntities, entity);
  });
}

/**
 * Deterministic context extraction from the assistant text only. This supplements
 * planner output so essential polygons/countries/regions are not dropped.
 */
function extractContextTextEntities(text: string): GeoEntity[] {
  const entities: GeoEntity[] = [];
  const lowerContext = text.toLowerCase();
  const hasPointNear = (lat: number, lon: number) =>
    entities.some(
      (e) =>
        e.kind === "point" &&
        e.origin === "context" &&
        Math.abs((e as GeoPoint).lat - lat) < 0.05 &&
        Math.abs((e as GeoPoint).lon - lon) < 0.05,
    );

  const coordRe =
    /(?:lat(?:itude)?[:\s]+(-?\d{1,3}\.\d+))[,\s]+(?:lon(?:gitude)?[:\s]+(-?\d{1,3}\.\d+))/gi;
  let m: RegExpExecArray | null;
  while ((m = coordRe.exec(text)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !hasPointNear(lat, lon)) {
      entities.push({ kind: "point", origin: "context", label: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, lat, lon });
    }
  }

  const regionKeys = Object.keys(REGION_TEXT_ALIASES).sort((a, b) => b.length - a.length);
  const addedRegions = new Set<string>();
  for (const key of regionKeys) {
    if (lowerContext.includes(key)) {
      const regionValue = REGION_TEXT_ALIASES[key];
      if (!addedRegions.has(regionValue)) {
        addedRegions.add(regionValue);
        entities.push({ kind: "region", origin: "context", name: regionValue });
      }
    }
  }

  for (const country of KNOWN_COUNTRIES) {
    const re = new RegExp(`(?<![a-z])${country.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i");
    if (re.test(text)) {
      entities.push({ kind: "country", origin: "context", name: country });
    }
  }

  return dedupeGeoEntities(entities);
}

/**
 * Fallback geometry extraction when the planner does not produce a render plan.
 * Keeps the behavior deterministic and entirely local.
 */
function extractGeoEntitiesFallback(
  text: string,
  mcpToolArgs: Record<string, unknown>[],
  toolOutputTexts: string[] = [],
): GeoEntity[] {
  const entities: GeoEntity[] = [
    ...collectSourceGeoEntities(mcpToolArgs, toolOutputTexts),
    ...extractContextTextEntities(text),
  ];
  const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
  return enrichGeoEntityContext(entities, corpus);
}

function deriveSingleSourcePointFastPath(
  text: string,
  sourceEntities: GeoEntity[],
  contextEntities: GeoEntity[] = [],
  toolOutputTexts: string[] = [],
): GeoEntity[] | null {
  const sourcePoints = sourceEntities.filter((entity): entity is GeoPoint => entity.kind === "point");
  const hasSourcePolygons = sourceEntities.some((entity) => entity.kind !== "point");

  if (sourcePoints.length !== 1 || hasSourcePolygons || contextEntities.length > 0) {
    return null;
  }

  const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
  return enrichGeoEntityContext([sourcePoints[0]], corpus);
}

function deriveExactSourcePointEntities(
  text: string,
  sourceEntities: GeoEntity[],
  contextEntities: GeoEntity[] = [],
  toolOutputTexts: string[] = [],
): GeoEntity[] | null {
  const sourcePoints = sourceEntities.filter((entity): entity is GeoPoint => entity.kind === "point");
  const hasOnlySourcePoints = sourcePoints.length > 0 && sourcePoints.length === sourceEntities.length;
  if (!hasOnlySourcePoints || contextEntities.length > 0) {
    return null;
  }

  const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
  return enrichGeoEntityContext(sourcePoints, corpus);
}

async function deriveGeoEntities(
  text: string,
  mcpToolArgs: Record<string, unknown>[],
  toolOutputTexts: string[] = [],
): Promise<GeoEntity[]> {
  const sourceEntities = collectSourceGeoEntities(mcpToolArgs, toolOutputTexts);
  const contextEntities = extractContextTextEntities(text);

  const exactSourcePointEntities = deriveExactSourcePointEntities(
    text,
    sourceEntities,
    contextEntities,
    toolOutputTexts,
  );
  if (exactSourcePointEntities) {
    return exactSourcePointEntities;
  }

  const singlePointFastPath = deriveSingleSourcePointFastPath(
    text,
    sourceEntities,
    contextEntities,
    toolOutputTexts,
  );
  if (singlePointFastPath) {
    return singlePointFastPath;
  }

  const plannedLocations = await deriveGeoRenderPlan(text, mcpToolArgs, toolOutputTexts);
  const plannedEntities = await planLocationsToGeoEntities(plannedLocations);
  const merged = [...sourceEntities, ...plannedEntities, ...contextEntities];
  if (merged.length) {
    const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
    return enrichGeoEntityContext(merged, corpus);
  }
  return extractGeoEntitiesFallback(text, mcpToolArgs, toolOutputTexts);
}

// ── Agent Registration ────────────────────────────────────────────────────────

const FALLBACK_MCP_DESCRIPTION =
  "Use this agent for ALL requests that require fetching real-world, live, or external data " +
  "from an MCP server. This includes: current news, headlines, articles, weather, events, prices, " +
  "search results, geospatial imagery catalogs (STAC), satellite collections, orthophotos, traffic, " +
  "business data, and any other information retrieved from an external API or data source. " +
  "Always prefer this agent when the user asks about real-world facts, current events, or any data " +
  "not already visible in the open map layers.";

/**
 * Build a routing description for the MCP agent from a set of real discovered tools.
 * The description is what the arcgis-assistant orchestrator reads to decide which agent handles a query.
 */
function buildDescriptionFromTools(
  tools: McpToolDef[],
  serverName: string,
  knowledgeBase?: McpKnowledgeBaseDocument | null,
): string {
  if (!tools.length) return FALLBACK_MCP_DESCRIPTION;

  const lines: string[] = [];
  lines.push(
    `Use this agent for ALL requests served by the "${serverName}" external data server.`,
    `It can answer queries about the following capabilities (always prefer it over built-in agents for these):`,
    "",
  );

  for (const t of tools.slice(0, 25)) {
    const desc = t.description
      ? t.description.split(/[\n.]/)[0].trim().slice(0, 140)
      : "";
    lines.push(desc ? `- ${t.name}: ${desc}` : `- ${t.name}`);
  }

  if (tools.length > 25) {
    lines.push(`- … and ${tools.length - 25} more tools`);
  }

  lines.push(
    "",
    "Also use this agent for any real-world fact, current event, live data, or information " +
    "that is not already present in the currently loaded map layers.",
  );

  const knowledgeBaseSupplement = buildKnowledgeBaseDescriptionSupplement(knowledgeBase ?? null, tools);
  if (knowledgeBaseSupplement) {
    lines.push(knowledgeBaseSupplement);
  }

  return lines.join("\n");
}

/**
 * Re-discover tools from the MCP server and update the registered agent's description.
 * Safe to call any time a server starts or its tool set changes.
 */
export async function refreshMcpAgentDescription(assistant: HTMLElement): Promise<void> {
  const agentEl = assistant.querySelector('[data-agent-id="mcp-passthrough-agent"]') as any;
  if (!agentEl?.agent) return;

  const baseUrl: string = agentEl._mcpBaseUrl ?? "";
  const serverName: string = agentEl.agent.name ?? "MCP Server";
  if (!baseUrl) return;

  try {
    const [tools, knowledgeBase] = await Promise.all([
      listMcpTools(baseUrl),
      fetchMcpKnowledgeBase(baseUrl),
    ]);
    if (tools.length) {
      agentEl.agent = {
        ...agentEl.agent,
        description: buildDescriptionFromTools(tools, serverName, knowledgeBase),
      };
    }
  } catch {
    // best-effort — keep the existing description
  }
}

export function registerMcpPassthroughAgent(
  assistant: HTMLElement,
  ctx: McpPassthroughAgentContext = {}
) {
  bindAssistantCancel(assistant);

  const agentId = "mcp-passthrough-agent";

  const createGraph = () => {
    const state = ANNOTATION.Root({
      messages: ANNOTATION({
        reducer: (current: any[] = [], update: any) => {
          const next = Array.isArray(update) ? update : [update];
          return [...current, ...next.filter(Boolean)];
        },
        default: () => [],
      }),
      outputMessage: ANNOTATION({
        reducer: (current: string = "", update: any) => {
          if (typeof update !== "string" || !update.trim()) return current;
          return current ? `${current}\n\n${update}` : update;
        },
        default: () => "",
      }),
      toolAliasMap: ANNOTATION({
        reducer: (
          current: ToolAliasMap = {},
          update: ToolAliasMap | undefined,
        ) => ({ ...current, ...(update ?? {}) }),
        default: () => ({}),
      }),
      // Accumulates raw tool-call argument objects across the whole run so the
      // geo extraction node can pull out lat/lon without needing another LLM call.
      toolCallArgsList: ANNOTATION({
        reducer: (
          _current: Record<string, unknown>[] = [],
          update: Record<string, unknown>[] | undefined,
        ) => update ?? [],
        default: () => [],
      }),
      // Stores raw tool output text payloads so geo extraction can parse
      // structured MCP responses even if the final assistant text omits names.
      toolOutputTextList: ANNOTATION({
        reducer: (_current: string[] = [], update: string[] | undefined) => update ?? [],
        default: () => [],
      }),
      canceled: ANNOTATION({
        reducer: (_current: boolean = false, update: boolean | undefined) => Boolean(update),
        default: () => false,
      }),
    });

    async function agentNode(agentState: any) {
      const runToken = latestMcpRunToken;
      try {
        const messages = normalizeMessages(agentState?.messages);
        const serverLabel = ctx.serverName || "MCP";
        const resolvedUrl = ctx.baseUrl || "";

        // Discover tools dynamically from the MCP server (cached per URL).
        let mcpToolDefs: McpToolDef[] = [];
        let knowledgeBase: McpKnowledgeBaseDocument | null = null;
        let discoveryError: string | null = null;
        try {
          [mcpToolDefs, knowledgeBase] = await Promise.all([
            listMcpTools(resolvedUrl),
            fetchMcpKnowledgeBase(resolvedUrl),
          ]);
          if (isMcpRunStale(runToken)) {
            return { messages: [], outputMessage: "", canceled: true };
          }
        } catch (err: any) {
          if (isMcpRunStale(runToken) || isAbortLikeError(err)) {
            return { messages: [], outputMessage: "", canceled: true };
          }
          discoveryError = err?.message ?? "Failed to discover tools from the MCP server.";
        }

        // If we couldn't discover any tools, return an error immediately without
        // burning an LLM call.
        if (discoveryError || !mcpToolDefs.length) {
          const msg = discoveryError
            ? `Could not connect to the ${serverLabel}: ${discoveryError}`
            : `The ${serverLabel} did not expose any tools.`;
          return {
            outputMessage: msg,
            messages: [],
          };
        }

        const aliasMap: ToolAliasMap = {};
        const langchainTools = mcpToolDefs.map((def, index) => {
          const alias = makeSafeToolAlias(index);
          aliasMap[alias] = def.name;
          return (
          tool(
            async (args: any) => callMcpTool(resolvedUrl, def.name, args as Record<string, unknown>),
            {
              name: alias,
              description: `${def.description || `Tool: ${def.name}`} (MCP tool: ${def.name})`,
              schema: inputSchemaToZod(def.inputSchema) as any,
            }
          )
          );
        });

        const knowledgeBasePrompt = buildKnowledgeBasePromptSupplement(knowledgeBase, mcpToolDefs);

        const response = await invokeToolPrompt({
          promptText:
            `You are connected to the ${serverLabel} MCP server. Use the available tools to fulfill the user's request. Choose the right tool based on its description and required arguments. Do not invent results.

CRITICAL — FOLLOW THE CURRENT REQUEST ONLY:
Always base your tool call parameters on the user's CURRENT message alone.
Never reuse collection IDs, data types, search filters, or required parameters from earlier messages in the conversation.

CONSTRAINT CARRY-FORWARD:
- Treat explicit user constraints such as geography, year/time period, output format, aggregation level, and requested measure as binding unless the user changes them.
- If the current message resolves only one missing detail, retain the other already-established constraints instead of asking for them again.
- When a prior step identified candidate variables or series for a specific place/time request, use the user's follow-up selection to proceed with that same place/time request unless the user changes it.

TOOL-DRIVEN BEHAVIOR FOR UNKNOWN MCPS:
- Rely on the discovered MCP tool descriptions and schemas, not on assumptions about specific providers, collection IDs, or domains.
- Do not assume a tool requires a location, bbox, date range, or any other parameter unless the tool description/schema indicates that it is required.
- If the user's request can be satisfied directly by a tool call, do that instead of asking a clarifying question.
- Ask a clarifying question only when a required argument is genuinely missing and cannot be inferred from the current message.
- Do not invent collection names, dataset IDs, or parameter requirements.

WHEN TOOL RESULTS CONTAIN GEOMETRY OR GEOSPATIAL ITEMS:
- All geometry is automatically rendered on the ArcGIS map — do NOT produce GeoJSON, curl commands, or download links.
- Summarize using the fields actually returned by the tool. When useful, include count, item titles, URLs, location, date range, and resolution if present.
- If an item exposes location or coverage cues such as geometry, bbox, place names, MGRS tile, path/row, or footprint-related fields, include a concise location/coverage line instead of omitting location.
- If the tool returns multiple usable links, prefer the links that actually open the item preview, product, or asset content over weaker metadata/self links.
- If the user asks for specific fields such as titles and URLs, return those fields directly from the tool results.

GENERAL RESPONSES (news, data, text, non-geographic):
- Return the full content the user asked for: article headlines, titles, summaries, lists, structured data, etc.
- Format naturally using bullets, numbered lists, or prose as appropriate for the content.
- Do NOT compress or withhold content for non-geographic results.

TABULAR / STATISTICAL RESPONSES:
- Keep the requested geography and time period visible in the answer.
- If tool output includes both machine identifiers and human-readable place names, prefer the human-readable geography in the prose while preserving the machine identifier in structured output only when useful.
- If the user asks for CSV, return the CSV directly once the needed series/variable has been resolved; do not re-ask for geography or time if those were already fixed.

PROHIBITIONS (always):
- No raw GeoJSON, WKT, raw coordinate arrays, or bounding boxes in the response text.
- No curl commands, code snippets, or download/import instructions.
- No "What would you like next?" or option menus.` +
            knowledgeBasePrompt,
          messages,
          tools: langchainTools,
          temperature: 0,
        });

        if (isMcpRunStale(runToken)) {
          return { messages: [], outputMessage: "", canceled: true };
        }

        // Reset geo extraction buffers at the start of each prompt execution.
        return {
          messages: [response],
          toolAliasMap: aliasMap,
          toolCallArgsList: [],
          toolOutputTextList: [],
          canceled: false,
        };
      } catch (err: any) {
        if (isMcpRunStale(runToken) || isAbortLikeError(err)) {
          return { messages: [], outputMessage: "", canceled: true };
        }
        return {
          outputMessage: `MCP agent failed to process the request: ${err?.message ?? "Unknown error."}`,
          messages: [],
        };
      }
    }

    async function toolsNode(agentState: any) {
      const runToken = latestMcpRunToken;
      try {
        const messages = normalizeMessages(agentState?.messages);
        const lastAiMessage = getLastAiMessage(messages);
        if (!lastAiMessage?.tool_calls?.length) return {};
        const aliasMap = (agentState?.toolAliasMap ?? {}) as ToolAliasMap;

        const resolvedUrl = ctx.baseUrl || "";
        const priorArgs: Record<string, unknown>[] = Array.isArray(agentState?.toolCallArgsList)
          ? agentState.toolCallArgsList
          : [];
        const priorOutputs: string[] = Array.isArray(agentState?.toolOutputTextList)
          ? agentState.toolOutputTextList
          : [];
        const collectedArgs: Record<string, unknown>[] = [];
        const collectedOutputs: string[] = [];

        const toolMessages = await Promise.all(
          lastAiMessage.tool_calls.map(async (toolCall: any) => {
            try {
              const originalToolName = aliasMap[toolCall.name] || toolCall.name;
              const args = (toolCall.args as Record<string, unknown>) || {};
              collectedArgs.push(args);
              const result = await callMcpTool(
                resolvedUrl,
                originalToolName,
                args,
              );
              if (isMcpRunStale(runToken)) {
                return null;
              }
              if (result) collectedOutputs.push(result);
              return new ToolMessage({ content: result, tool_call_id: toolCall.id ?? toolCall.name });
            } catch (error: any) {
              if (isMcpRunStale(runToken) || isAbortLikeError(error)) {
                return null;
              }
              return new ToolMessage({
                content: error?.message || `Failed to call ${toolCall.name} on the ${ctx.serverName || "MCP"} server.`,
                tool_call_id: toolCall.id ?? toolCall.name,
                status: "error",
              });
            }
          })
        );

        return {
          messages: toolMessages.filter(Boolean),
          toolCallArgsList: [...priorArgs, ...collectedArgs],
          toolOutputTextList: [...priorOutputs, ...collectedOutputs],
          canceled: false,
        };
      } catch (err: any) {
        if (isMcpRunStale(runToken) || isAbortLikeError(err)) {
          return { messages: [], canceled: true };
        }
        return {
          messages: [
            new ToolMessage({
              content: `MCP tools execution failed: ${err?.message ?? "Unknown error."}`,
              tool_call_id: "mcp-tools-node-error",
              status: "error",
            }),
          ],
        };
      }
    }

    function routeAfterAgent(agentState: any) {
      try {
        if (agentState?.canceled) return "respond";
        const messages = normalizeMessages(agentState?.messages);
        const lastAiMessage = getLastAiMessage(messages);
        // If no messages were returned (early error exit), go straight to respond.
        if (!lastAiMessage) return "respond";
        return lastAiMessage?.tool_calls?.length ? "tools" : "respond";
      } catch {
        return "respond";
      }
    }

    function respondNode(agentState: any) {
      if (agentState?.canceled) {
        return { outputMessage: "" };
      }

      const messages = normalizeMessages(agentState?.messages);
      const lastAiMessage = getLastAiMessage(messages);
      const text =
        contentToText(lastAiMessage?.content) ||
        `The ${ctx.serverName || "MCP"} server did not return a response.`;

      // Fire geo rendering as a detached side-effect — completely outside the
      // graph lifecycle so the assistant finishes cleanly before any map work.
      const toolArgs: Record<string, unknown>[] = agentState?.toolCallArgsList ?? [];
      const toolOutputs: string[] = agentState?.toolOutputTextList ?? [];
      latestGeoRenderToken += 1;
      const currentToken = latestGeoRenderToken;

      if (pendingGeoRenderTimer != null) {
        globalThis.clearTimeout(pendingGeoRenderTimer);
      }

      pendingGeoRenderTimer = globalThis.setTimeout(() => {
        pendingGeoRenderTimer = null;

        void (async () => {
          const isStale = () => currentToken !== latestGeoRenderToken;

          try {
            // ── GeoJSON Synthesis (fast path — zero LLM calls) ───────────────
            const synthesized = await synthesizeGeoJson(toolOutputs, toolArgs, text);
            console.debug(
              "[MCP Render] synthesized:",
              synthesized
                ? `features=${synthesized.features.length}`
                : "null (no GeoJSON in tool outputs)",
              "| stale:", isStale(),
            );
            if (!isStale() && synthesized && synthesized.features.length > 0) {
              const entities = await deriveGeoEntities(text, toolArgs, toolOutputs);
              if (isStale()) return;
              const mergedSynthesized = mergeSynthesizedPointEntities(synthesized as any, entities);
              console.debug("[MCP Render] → renderArbitraryGeoJson path", mergedSynthesized.features.map(f => `${f.title}[${f.geometryType}/${f.layerGroup}]`));
              await renderArbitraryGeoJson(mergedSynthesized as any, deriveSnapshotTitle(text));
              if (!isStale()) {
                // Build a lightweight snapshot so downstream agents (feature layer
                // creation, etc.) still have access to the rendered point locations.
                setLastAssistantGeoSnapshot({
                  title: deriveSnapshotTitle(text),
                  responseText: text,
                  updatedAt: new Date().toISOString(),
                  entities: mergedSynthesized.features
                    .filter(
                      (f) =>
                        f.geometryType === "Point" && Array.isArray(f.coordinates),
                    )
                    .map((f) => {
                      const [lon, lat] = f.coordinates as [number, number];
                      return {
                        kind: "point" as const,
                        origin: "source" as const,
                        label: f.title,
                        lat,
                        lon,
                        description: f.description,
                      };
                    }),
                });
              }
              return; // skip entity-based pipeline
            }
            if (isStale()) { console.debug("[MCP Render] → stale after synthesis, aborting"); return; }
            console.debug("[MCP Render] → falling back to entity pipeline (synthesis gave no explicit geometry)");

            const entities = await deriveGeoEntities(text, toolArgs, toolOutputs);
            if (isStale()) return;

            const corpus = [text, ...toolOutputs].filter(Boolean).join("\n\n");
            const sourceEntities = entities.filter((entity) => entity.origin === "source");
            const hasSourcePoint = sourceEntities.some((entity) => entity.kind === "point");
            const hasExactSourcePoints =
              sourceEntities.some((entity) => entity.kind === "point") &&
              sourceEntities.every((entity) => entity.kind === "point");

            if (!hasExactSourcePoints) {
              const mentions = extractPlaceMentions(text);
              for (const mention of mentions) {
                if (isStale()) return;

                const normalizedMention = normalizeMentionLabel(mention);
                const hasQualifiedLocation = /,/.test(mention);
                const hasNamedPoint = entities.some(
                  (entity) =>
                    entity.kind === "point" &&
                    normalizeMentionLabel((entity as GeoPoint).label).includes(normalizedMention),
                );
                if (hasNamedPoint) continue;
                if (!hasQualifiedLocation && hasSourcePoint) continue;
                if (!contextPointRelatesToSource(mention, corpus, sourceEntities)) continue;

                const hit = await geocodePlaceLabel(mention);
                if (isStale() || !hit) continue;

                const exists = entities.some(
                  (e) =>
                    e.kind === "point" &&
                    Math.abs((e as GeoPoint).lat - hit.lat) < 0.05 &&
                    Math.abs((e as GeoPoint).lon - hit.lon) < 0.05,
                );
                if (!exists) {
                  const allEntityNames = entities.map((e) =>
                    e.kind === "point" ? (e as GeoPoint).label : (e as GeoCountry | GeoRegion).name,
                  );
                  entities.push({
                    kind: "point",
                    origin: "context",
                    label: mention,
                    lat: hit.lat,
                    lon: hit.lon,
                    context: extractEntityContext(corpus, mention, allEntityNames),
                  });
                }
              }
            }

            const strictEntities = filterStrictContextGeometry(entities, corpus);
            if (isStale()) return;

            setLastAssistantGeoSnapshot({
              title: deriveSnapshotTitle(text),
              responseText: text,
              updatedAt: new Date().toISOString(),
              entities: strictEntities.map((entity) => ({
                kind: entity.kind,
                origin: entity.origin,
                label: entity.kind === "point" ? entity.label : entity.name,
                lat: entity.kind === "point" ? entity.lat : undefined,
                lon: entity.kind === "point" ? entity.lon : undefined,
                description: entity.description,
                summary: entity.context?.summary,
                links: entity.context?.links,
                fields: entity.context?.mcpFields,
              })),
            });

            if (!strictEntities.length) {
              clearMcpGeoLayer();
              return;
            }

            await renderMcpGeoEntities(strictEntities);
          } catch {
            // best-effort — never surface to user
          }
        })();
      }, 0);

      return { outputMessage: text };
    }

    return new StateGraph(state)
      .addNode("agent", agentNode)
      .addNode("tools", toolsNode)
      .addNode("respond", respondNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeAfterAgent, ["tools", "respond"])
      .addEdge("tools", "agent")
      .addEdge("respond", END);
  };

  const serverLabel = ctx.serverName || "MCP Server";
  const agent = {
    id: agentId,
    name: serverLabel,
    // Boot with the fallback description; refreshMcpAgentDescription() will
    // replace it with a richer one derived from real tool names once the server
    // responds to tools/list.
    description: FALLBACK_MCP_DESCRIPTION,
    createGraph,
    workspace: {},
  } as any;

  const existing = assistant.querySelector(`[data-agent-id="${agentId}"]`);
  if (existing) {
    // Clear cached tools and resolved endpoint for the outgoing URL so the next server gets fresh data.
    const outgoingUrl = (existing as any)._mcpBaseUrl;
    if (outgoingUrl) clearMcpCaches(outgoingUrl);
    existing.remove();
  }

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", agentId);
  agentEl._mcpBaseUrl = ctx.baseUrl ?? "";
  agentEl.agent = agent;
  assistant.appendChild(agentEl);

  // Async: discover real tools and rebuild the description so the orchestrator
  // can route accurately based on what this server actually exposes.
  if (ctx.baseUrl) {
    void (async () => {
      try {
        const [tools, knowledgeBase] = await Promise.all([
          listMcpTools(ctx.baseUrl!),
          fetchMcpKnowledgeBase(ctx.baseUrl!),
        ]);
        if (tools.length) {
          agentEl.agent = {
            ...agentEl.agent,
            description: buildDescriptionFromTools(tools, serverLabel, knowledgeBase),
          };
        }
      } catch {
        // keep fallback description
      }
    })();
  }
}