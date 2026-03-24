import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
import { clearMcpGeoLayer, renderMcpGeoEntities, type GeoEntity, type GeoContext, type GeoPoint, type GeoCountry, type GeoRegion, type GeoExtent } from "../utils/mcpGeoRenderer";
import { setLastAssistantGeoSnapshot } from "../utils/assistantState";

export interface McpPassthroughAgentContext {
  baseUrl?: string;
  serverName?: string;
}

interface ToolAliasMap {
  [alias: string]: string;
}

interface HubServerSummary {
  id: string;
  label: string;
  status?: string;
}

interface GeoRenderPlanLocation {
  label: string;
  kind: "point" | "country" | "region";
  origin: "source" | "context";
  lat?: number;
  lon?: number;
  description?: string;
}

let latestGeoRenderToken = 0;
let pendingGeoRenderTimer: number | null = null;
let latestMcpRunToken = 0;
const cancelBoundAssistants = new WeakSet<HTMLElement>();
const activeMcpAbortControllers = new Set<AbortController>();
const MCP_DISCOVERY_TIMEOUT_MS = 8_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 15_000;
const MCP_NOTIFY_TIMEOUT_MS = 3_000;
const HUB_SERVERS_TIMEOUT_MS = 4_000;

function beginMcpAbortController(timeoutMs?: number): AbortController {
  const controller = new AbortController();
  activeMcpAbortControllers.add(controller);
  if (timeoutMs && timeoutMs > 0) {
    globalThis.setTimeout(() => controller.abort(`timeout:${timeoutMs}`), timeoutMs);
  }
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
  const timeoutMs = typeof body.__timeoutMs === "number" ? Number(body.__timeoutMs) : undefined;
  const payload = { ...body } as Record<string, unknown>;
  delete payload.__timeoutMs;
  const controller = beginMcpAbortController(timeoutMs);
  try {
    const response = await fetch(fetchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
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
  } catch (error) {
    if (isAbortLikeError(error) && timeoutMs) {
      throw new Error(`MCP request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    endMcpAbortController(controller);
  }
}

/** Send a JSON-RPC 2.0 request to the endpoint URL provided by the user. */
function mcpRequest(endpointUrl: string, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  return mcpPost(url, { jsonrpc: "2.0", id: 1, method, params, __timeoutMs: timeoutMs });
}

/** Fire-and-forget JSON-RPC 2.0 notification (no id). */
async function mcpNotify(endpointUrl: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  const controller = beginMcpAbortController(MCP_NOTIFY_TIMEOUT_MS);
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
const TOOL_CACHE_TTL_MS = 300_000;
const hubServersCache = new Map<string, { servers: HubServerSummary[]; at: number }>();
const HUB_SERVERS_CACHE_TTL_MS = 60_000;

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
  }, MCP_DISCOVERY_TIMEOUT_MS);
  await mcpNotify(endpointUrl, "notifications/initialized");
  initializedEndpoints.add(key);
}

/** Clear cached state for a given endpoint (used when switching servers). */
function clearMcpCaches(endpointUrl: string): void {
  const key = normalizeUrl(endpointUrl);
  initializedEndpoints.delete(key);
  mcpToolsCache.delete(key);
  hubServersCache.delete(key);
}

/** Discover tools from the MCP server. Cached after first call. */
async function listMcpTools(endpointUrl: string): Promise<McpToolDef[]> {
  const key = normalizeUrl(endpointUrl);
  const cached = mcpToolsCache.get(key);
  if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/list", {}, MCP_DISCOVERY_TIMEOUT_MS);
  const tools: McpToolDef[] = Array.isArray(result?.tools) ? result.tools : [];
  mcpToolsCache.set(key, { tools, at: Date.now() });
  return tools;
}

/** Call a specific tool on the MCP server. */
async function callMcpTool(endpointUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/call", { name, arguments: args }, MCP_TOOL_CALL_TIMEOUT_MS);
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
  return schemaToZod(prop, isRequired);
}

function inputSchemaToZod(inputSchema?: Record<string, unknown>): z.ZodTypeAny {
  if (!inputSchema) {
    return z.object({
      __no_args: z.boolean().optional().describe("This tool takes no arguments. Leave unset."),
    });
  }

  if (requiresRootSchemaWrapper(inputSchema)) {
    return buildWrappedRootSchema(inputSchema);
  }

  return schemaToZod(inputSchema, true);
}

function rootSchemaHasExplicitProperties(inputSchema?: Record<string, unknown>): boolean {
  const properties = inputSchema?.properties;
  return Boolean(properties && typeof properties === "object" && !Array.isArray(properties) && Object.keys(properties).length > 0);
}

function requiresRootSchemaWrapper(inputSchema?: Record<string, unknown>): boolean {
  if (!inputSchema) return true;

  const rawType = inputSchema.type;
  const types = Array.isArray(rawType) ? rawType.map(String) : typeof rawType === "string" ? [rawType] : [];
  const nonNullTypes = types.filter((type) => type !== "null");

  if (nonNullTypes.length > 1) return true;

  const schemaType = nonNullTypes[0];
  if (!schemaType || schemaType === "object") {
    return !rootSchemaHasExplicitProperties(inputSchema);
  }

  return true;
}

function buildWrappedRootSchema(inputSchema?: Record<string, unknown>): z.ZodTypeAny {
  const desc = truncateDescription(typeof inputSchema?.description === "string" ? inputSchema.description : undefined, 180);
  const takesNoArgs = !inputSchema || (!rootSchemaHasExplicitProperties(inputSchema) && inputSchema.additionalProperties == null);

  const wrapped = takesNoArgs
    ? z.object({
        __no_args: z.boolean().optional().describe("This tool takes no arguments. Leave unset."),
      })
    : z.object({
        __raw_args_json: z.string().optional().describe("JSON object string containing the MCP tool arguments."),
      });

  return desc ? wrapped.describe(desc) : wrapped;
}

function normalizeToolArgsForCall(
  inputSchema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!requiresRootSchemaWrapper(inputSchema)) {
    return args;
  }

  const rawJson = typeof args.__raw_args_json === "string" ? args.__raw_args_json.trim() : "";
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to empty args when the wrapper content is invalid.
    }
  }

  return {};
}

function truncateDescription(text: string | undefined, maxLength = 220): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function enumToSchema(values: unknown[]): z.ZodTypeAny | null {
  if (!values.length) return null;
  if (values.every((value) => typeof value === "string")) {
    const unique = [...new Set(values as string[])];
    if (!unique.length) return null;
    return unique.length === 1 ? z.literal(unique[0]) : z.enum(unique as [string, ...string[]]);
  }

  const literals = values
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .map((value) => z.literal(value as string | number | boolean));
  if (!literals.length) return null;
  if (literals.length === 1) return literals[0];
  if (literals.length === 2) return z.union([literals[0], literals[1]]);
  return z.union([literals[0], literals[1], ...literals.slice(2)] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function unionSchemas(parts: z.ZodTypeAny[]): z.ZodTypeAny {
  const unique = parts.filter(Boolean);
  if (!unique.length) return z.unknown();
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return z.union([unique[0], unique[1]]);
  return z.union([unique[0], unique[1], ...unique.slice(2)] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function schemaToZod(schemaLike: unknown, isRequired: boolean): z.ZodTypeAny {
  const schema = schemaLike && typeof schemaLike === "object" && !Array.isArray(schemaLike)
    ? schemaLike as Record<string, unknown>
    : {};
  const desc = truncateDescription(typeof schema.description === "string" ? schema.description : undefined, 180);

  let nullable = false;

  const variants = ["anyOf", "oneOf"]
    .flatMap((key) => Array.isArray(schema[key]) ? [schema[key] as unknown[]] : [])
    .flat();
  if (variants.length) {
    const variantSchemas = variants.flatMap((variant) => {
      const variantRecord = variant && typeof variant === "object" && !Array.isArray(variant)
        ? variant as Record<string, unknown>
        : null;
      const variantType = variantRecord?.type;
      if (variantType === "null") {
        nullable = true;
        return [];
      }
      return [schemaToZod(variant, true)];
    });
    let union = unionSchemas(variantSchemas);
    if (nullable) union = union.nullable();
    if (desc) union = union.describe(desc);
    if (!isRequired) union = union.optional();
    return union;
  }

  const enumSchema = Array.isArray(schema.enum) ? enumToSchema(schema.enum) : null;
  if (enumSchema) {
    let out = enumSchema;
    if (desc) out = out.describe(desc);
    if (!isRequired) out = out.optional();
    return out;
  }

  const rawType = schema.type;
  const types = Array.isArray(rawType) ? rawType.map(String) : typeof rawType === "string" ? [rawType] : [];
  const nonNullTypes = types.filter((type) => type !== "null");
  if (types.includes("null")) nullable = true;

  let out: z.ZodTypeAny;
  if (nonNullTypes.length > 1) {
    out = unionSchemas(nonNullTypes.map((type) => schemaToZod({ ...schema, type }, true)));
  } else {
    const type = nonNullTypes[0];
    switch (type) {
      case "integer":
        out = z.number().int();
        break;
      case "number":
        out = z.number();
        break;
      case "boolean":
        out = z.boolean();
        break;
      case "array": {
        const itemSchema = schema.items ? schemaToZod(schema.items, true) : z.unknown();
        out = z.array(itemSchema);
        break;
      }
      case "object": {
        const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
          ? schema.properties as Record<string, Record<string, unknown>>
          : undefined;
        const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
        if (properties && Object.keys(properties).length) {
          const shape: Record<string, z.ZodTypeAny> = {};
          for (const [key, prop] of Object.entries(properties)) {
            shape[key] = jsonPropToZod(prop, required.includes(key));
          }
          let objectSchema = z.object(shape);
          if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
            objectSchema = objectSchema.catchall(schemaToZod(schema.additionalProperties, true));
          } else if (schema.additionalProperties !== true) {
            objectSchema = objectSchema.strict();
          }
          out = objectSchema;
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          out = z.record(z.string(), schemaToZod(schema.additionalProperties, true));
        } else {
          out = z.record(z.string(), z.unknown());
        }
        break;
      }
      case "string":
      default:
        out = z.string();
        break;
    }
  }

  if (nullable) out = out.nullable();
  if (desc) out = out.describe(desc);
  if (!isRequired) out = out.optional();
  return out;
}

function parseQualifiedToolName(name: string): { serverId: string | null; toolName: string } {
  const idx = name.indexOf("__");
  if (idx < 0) return { serverId: null, toolName: name };
  return {
    serverId: name.slice(0, idx),
    toolName: name.slice(idx + 2),
  };
}

function resolveHubServersUrl(endpointUrl: string): string | null {
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

async function listHubServers(endpointUrl: string): Promise<HubServerSummary[]> {
  const cacheKey = normalizeUrl(endpointUrl);
  const cached = hubServersCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HUB_SERVERS_CACHE_TTL_MS) {
    return cached.servers;
  }

  const serversUrl = resolveHubServersUrl(endpointUrl);
  if (!serversUrl) return [];

  const controller = beginMcpAbortController(HUB_SERVERS_TIMEOUT_MS);
  try {
    const response = await fetch(resolveFetchUrl(serversUrl), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json: any = await response.json();
    const servers = Array.isArray(json?.servers)
      ? json.servers.map((server: any) => ({ id: String(server.id ?? ""), label: String(server.label ?? server.id ?? ""), status: server.status ? String(server.status) : undefined }))
      : [];
    hubServersCache.set(cacheKey, { servers, at: Date.now() });
    return servers;
  } catch {
    return [];
  } finally {
    endMcpAbortController(controller);
  }
}

function summarizeToolDescription(def: McpToolDef, serverLabel?: string): string {
  const { toolName } = parseQualifiedToolName(def.name);
  const summary = truncateDescription(def.description, 240) || `Tool: ${toolName}`;
  return serverLabel
    ? `[Server: ${serverLabel}] ${summary} (MCP tool: ${toolName})`
    : `${summary} (MCP tool: ${toolName})`;
}

const MCP_ROUTING_BASE_DESCRIPTION =
  "Primary agent for external, non-map questions that need MCP tools or live data sources. " +
  "Use this for census, population, demographics, statistics, rankings, current facts, external catalog searches, STAC catalogs, metadata lookups, collection browsing, and latest-item queries. " +
  "Prefer this agent whenever the answer is not already visible in the active map layers or current web map.";

function buildDescriptionFromTools(
  tools: McpToolDef[],
  serverName: string,
  hubServers: HubServerSummary[] = [],
): string {
  if (!tools.length) {
    return `${MCP_ROUTING_BASE_DESCRIPTION} Connected server: ${serverName}.`;
  }

  const serverLabels = new Map(hubServers.map((server) => [server.id, server.label]));
  const summarizedTools = tools.slice(0, 18).map((toolDef) => {
    const { serverId, toolName } = parseQualifiedToolName(toolDef.name);
    const toolServerLabel = serverId ? (serverLabels.get(serverId) || serverId) : serverName;
    const summary = truncateDescription(toolDef.description, 140) || `Tool for ${toolName.replace(/[_-]+/g, " ")}`;
    return `${toolServerLabel}: ${toolName} - ${summary}`;
  });

  const serverSummary = hubServers.length
    ? `Connected MCP sources: ${hubServers.map((server) => server.label).join(", ")}.`
    : `Connected MCP source: ${serverName}.`;

  return [
    MCP_ROUTING_BASE_DESCRIPTION,
    serverSummary,
    "Relevant examples include questions like top U.S. cities by population, Census data lookups, demographic comparisons, external API facts, and catalog/item searches.",
    "Available MCP tool coverage:",
    ...summarizedTools.map((line) => `- ${line}`),
    tools.length > summarizedTools.length ? `- ...and ${tools.length - summarizedTools.length} more MCP tools.` : "",
  ].filter(Boolean).join("\n");
}

export async function refreshMcpAgentDescription(assistant: HTMLElement): Promise<void> {
  const agentEl = assistant.querySelector('[data-agent-id="mcp-passthrough-agent"]') as any;
  if (!agentEl?.agent) return;

  const baseUrl: string = agentEl._mcpBaseUrl ?? "";
  const serverName: string = agentEl.agent.name ?? "MCP Server";
  if (!baseUrl) return;

  try {
    clearMcpCaches(baseUrl);
    const [tools, hubServers] = await Promise.all([
      listMcpTools(baseUrl),
      listHubServers(baseUrl),
    ]);
    if (tools.length) {
      agentEl.agent = {
        ...agentEl.agent,
        description: buildDescriptionFromTools(tools, serverName, hubServers),
      };
    }
  } catch {
    // best-effort — keep the existing description
  }
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

function extractLastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;

    const isHuman =
      HumanMessage.isInstance(message) ||
      message.getType?.() === "human" ||
      message.lc_kwargs?.type === "human" ||
      message.kwargs?.type === "human" ||
      message.role === "user";
    if (!isHuman) continue;

    if (typeof message.lc_kwargs?.content === "string" && message.lc_kwargs.content.trim()) return message.lc_kwargs.content.trim();
    if (typeof message.kwargs?.content === "string" && message.kwargs.content.trim()) return message.kwargs.content.trim();
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
  }
  return "";
}

function rankMcpToolsForQuery(
  toolDefs: McpToolDef[],
  queryText: string,
  serverLabels: Map<string, string>,
): McpToolDef[] {
  const query = queryText.toLowerCase();
  const hasQuery = Boolean(query.trim());
  const includesAny = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(query));

  const topicWeights: Array<{ patterns: RegExp[]; weight: number; keywords: RegExp[] }> = [
    {
      patterns: [/\bcensus\b/, /\bpopulation\b/, /\bdemograph/i, /\bcities?\b/, /\busa\b|\bu\.s\.\b|\bunited states\b/],
      weight: 12,
      keywords: [/census/i, /population/i, /demograph/i, /city|cities/i, /geograph/i],
    },
    {
      patterns: [/\bstac\b/, /asset catalog/i, /\bcollection\b/, /imagery/i, /satellite/i],
      weight: 12,
      keywords: [/stac/i, /catalog/i, /collection/i, /imagery/i, /satellite/i],
    },
    {
      patterns: [/\bweather\b/, /forecast/i, /temperature/i, /air quality/i, /aqi/i],
      weight: 12,
      keywords: [/weather/i, /forecast/i, /temperature/i, /air quality|aqi/i],
    },
    {
      patterns: [/\bnews\b/, /headline/i, /article/i],
      weight: 12,
      keywords: [/news/i, /headline/i, /article/i],
    },
    {
      patterns: [/\bsdmx\b/, /dataflow/i, /indicator/i, /statistics/i, /dataset/i],
      weight: 6,
      keywords: [/sdmx/i, /dataflow/i, /indicator/i, /dataset/i, /statistic/i],
    },
  ];

  const scored = toolDefs.map((toolDef, index) => {
    const { serverId, toolName } = parseQualifiedToolName(toolDef.name);
    const serverLabel = (serverId ? (serverLabels.get(serverId) || serverId) : "").toLowerCase();
    const haystack = [toolDef.name, toolName, toolDef.description ?? "", serverLabel].join(" ").toLowerCase();

    let score = 0;
    if (!hasQuery) score += 1;

    for (const topic of topicWeights) {
      if (!includesAny(topic.patterns)) continue;
      if (topic.keywords.some((pattern) => pattern.test(haystack))) {
        score += topic.weight;
      }
    }

    if (/\bcurrent\b|\blatest\b|\btop\b|\brank/i.test(query) && /fetch|search|list|get/i.test(haystack)) {
      score += 2;
    }
    if (/\bcensus\b|\bpopulation\b|\bdemograph/i.test(query) && /news|weather|stac/i.test(haystack)) {
      score -= 8;
    }
    if (/\bstac\b|catalog|imagery|satellite/i.test(query) && /census|weather|news|sdmx/i.test(haystack)) {
      score -= 8;
    }
    if (/\bweather\b|forecast|temperature|aqi/i.test(query) && /census|news|stac|sdmx/i.test(haystack)) {
      score -= 8;
    }
    if (/\bnews\b|headline|article/i.test(query) && /census|weather|stac|sdmx/i.test(haystack)) {
      score -= 8;
    }
    if (serverLabel && query.includes(serverLabel)) {
      score += 10;
    }

    return { toolDef, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const positive = scored.filter((entry) => entry.score > 0).map((entry) => entry.toolDef);
  if (positive.length) {
    return positive.slice(0, 10);
  }

  return toolDefs.slice(0, 10);
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

function normalizeCountryName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return KNOWN_COUNTRIES.find((country) => country.toLowerCase() === name) ?? null;
}

function pointLabelQuality(label: string): number {
  const trimmed = label.trim();
  if (!trimmed) return 0;
  if (/^-?\d{1,3}(?:\.\d+)?(?:°)?\s*,\s*-?\d{1,3}(?:\.\d+)?(?:°)?$/.test(trimmed)) return 1;
  if (/^-?\d/.test(trimmed)) return 2;
  if (/,/.test(trimmed)) return 4;
  return 3;
}

function choosePreferredPointEntity(current: GeoPoint, candidate: GeoPoint): GeoPoint {
  const currentScore = pointLabelQuality(current.label) + (current.context ? 2 : 0);
  const candidateScore = pointLabelQuality(candidate.label) + (candidate.context ? 2 : 0);
  return candidateScore > currentScore ? candidate : current;
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
    } else {
      key = [entity.origin, entity.kind, entity.name.trim().toLowerCase()].join(":");
    }
    const existingIndex = seen.get(key);
    if (existingIndex != null) {
      if (entity.kind === "point" && out[existingIndex]?.kind === "point") {
        out[existingIndex] = choosePreferredPointEntity(out[existingIndex] as GeoPoint, entity as GeoPoint);
      }
      continue;
    }
    seen.set(key, out.length);
    out.push(entity);
  }

  return out;
}

function enrichGeoEntityContext(entities: GeoEntity[], corpus: string): GeoEntity[] {
  const deduped = dedupeGeoEntities(entities);
  const allEntityNames = deduped.map((entity) =>
    entity.kind === "point"
      ? (entity as GeoPoint).label
      : entity.kind === "extent"
        ? (entity as GeoExtent).label
        : (entity as GeoCountry | GeoRegion).name,
  );

  for (const entity of deduped) {
    if (entity.context) continue;
    const term = entity.kind === "point"
      ? (entity as GeoPoint).label
      : entity.kind === "extent"
        ? (entity as GeoExtent).label
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
  void text;
  void mcpToolArgs;
  void toolOutputTexts;
  return [];
}

async function planLocationsToGeoEntities(
  locations: GeoRenderPlanLocation[],
): Promise<GeoEntity[]> {
  void locations;
  return [];
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
  const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const esc = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = new RegExp(`(?<![a-zA-Z])${esc}(?![a-zA-Z])`, "i");

  const catalogItemBlocks = extractCatalogItemBlocks(text);
  const matchingItemBlock = catalogItemBlocks.find((block) => nameRe.test(block));

  // split on blank lines or newlines; keeps article-style paragraphs intact
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  let relevant = matchingItemBlock
    ? [matchingItemBlock]
    : paras.filter((p) => nameRe.test(p));

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
  const fieldRe = /(?:^|\n)(?:[-*]\s*)?(?:\*\*([^*:]+):\*\*|([^:\n]+):)\s*(.+)/g;
  const relevantBlock = relevant.join("\n");
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(relevantBlock)) !== null && mcpFields.length < 8) {
    const label = (fm[1] ?? fm[2] ?? "").trim().replace(/^[-*]\s*/, "");
    const value = fm[3].replace(/\*\*/g, "").trim();
    if (label && value) mcpFields.push({ label, value });
  }

  // Collect URLs from relevant paragraphs
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

  // Also scan a window around the first occurrence in full text
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
      if (explicitLabel) {
        return { url, label: explicitLabel };
      }
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
  "Asset", "Assets", "Catalog", "Metadata", "Item", "Collection-level", "Sentinel",
  "SPOT", "Orthoimages", "Aerial", "Thumbnail", "External", "Specifications", "GeoPackage",
  "Leaf", "Above", "Phase", "Tile", "Index", "Endpoint", "Source",
]);

interface PlaceMentionCandidate {
  label: string;
  geocodeLabel: string;
  origin: "source" | "context";
  requiresSourceContext: boolean;
}

function toDisplayPlaceLabel(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function extractRegionalQualifier(text: string): string | null {
  const qualifierRe = /\b(?:in|across|within|throughout)\s+([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,3})\b(?:\s+by\b|\s+using\b|\s+with\b|\s+based\b|\s+according\b|[,.]|$)/gu;
  let m: RegExpExecArray | null;
  while ((m = qualifierRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!candidate || NON_PLACE_TERMS.has(candidate)) continue;
    return candidate;
  }

  const fallbackQualifierRe = /\b(?:in|across|within|throughout)\s+([\p{L}'’.-]+(?:\s+[\p{L}'’.-]+){0,3})\b(?:\s+by\b|\s+using\b|\s+with\b|\s+based\b|\s+according\b|[,.]|$)/giu;
  while ((m = fallbackQualifierRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (!candidate || NON_PLACE_TERMS.has(toDisplayPlaceLabel(candidate))) continue;
    if (candidate.split(/\s+/).length > 4) continue;
    return toDisplayPlaceLabel(candidate);
  }
  return null;
}

function extractRankedPlaceMentions(text: string): string[] {
  const out = new Set<string>();
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const normalized = line
      .replace(/^(?:[-*•]\s*)/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    const match = normalized.match(/^([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,4})\s*(?:[—–-]|:)\s*(.+)$/u);
    if (!match) continue;

    const candidate = match[1].trim();
    const value = match[2].trim();
    if (!candidate || NON_PLACE_TERMS.has(candidate)) continue;
    if (!/\d/.test(value)) continue;
    if (value.length > 40 && !/^[\d\s,$.%()/-]+$/.test(value)) continue;
    out.add(candidate);
  }

  return [...out].slice(0, 12);
}

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

  const lowerStandaloneRe = /\b(?:in|of|for|from|near|across|within)\s+([\p{L}'’.-]+(?:\s+[\p{L}'’.-]+){0,2})\b/giu;
  while ((m = lowerStandaloneRe.exec(text)) !== null) {
    const rawCandidate = m[1].trim();
    const candidate = toDisplayPlaceLabel(rawCandidate);
    if (!candidate || NON_PLACE_TERMS.has(candidate)) continue;
    if (candidate.split(/\s+/).length > 3) continue;
    out.add(candidate);
  }

  return [...out].slice(0, 10);
}

function buildPlaceMentionCandidates(text: string): PlaceMentionCandidate[] {
  const regionalQualifier = extractRegionalQualifier(text);
  const candidates: PlaceMentionCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: PlaceMentionCandidate) => {
    const key = `${candidate.origin}:${normalizeMentionLabel(candidate.geocodeLabel)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const label of extractRankedPlaceMentions(text)) {
    pushCandidate({
      label,
      geocodeLabel: !/,/.test(label) && regionalQualifier ? `${label}, ${regionalQualifier}` : label,
      origin: "source",
      requiresSourceContext: false,
    });
  }

  for (const label of extractPlaceMentions(text)) {
    pushCandidate({
      label,
      geocodeLabel: label,
      origin: "context",
      requiresSourceContext: true,
    });
  }

  return candidates.slice(0, 12);
}

function entityDisplayLabel(entity: GeoEntity): string {
  return entity.kind === "point" || entity.kind === "extent" ? entity.label : entity.name;
}

function extractQueryPlaceFocus(text: string): string[] {
  const directMentions = extractPlaceMentions(text);
  if (directMentions.length) return directMentions.slice(0, 3);

  const qualifier = extractRegionalQualifier(text);
  return qualifier ? [qualifier] : [];
}

function entityMatchesAnyFocus(entity: GeoEntity, focuses: string[]): boolean {
  const entityLabel = normalizeMentionLabel(entityDisplayLabel(entity));
  if (!entityLabel) return false;

  return focuses.some((focus) => {
    const normalizedFocus = normalizeMentionLabel(focus);
    return normalizedFocus && (entityLabel.includes(normalizedFocus) || normalizedFocus.includes(entityLabel));
  });
}

function extractRequestedPlaceFocuses(
  userText: string,
  mcpToolArgs: Record<string, unknown>[],
): { labels: string[]; lat?: number; lon?: number } {
  const labels: string[] = [];
  const seen = new Set<string>();

  const pushLabel = (value: unknown) => {
    const label = String(value ?? "").trim();
    if (!label || label.length < 2 || label.length > 120) return;
    const normalized = normalizeMentionLabel(label);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    labels.push(label);
  };

  for (const args of mcpToolArgs) {
    pushLabel(args.location);
    pushLabel(args.city);
    pushLabel(args.place);
    pushLabel(args.name);

    const lat = Number(args.latitude ?? args.lat ?? NaN);
    const lon = Number(args.longitude ?? args.lon ?? args.long ?? NaN);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { labels, lat, lon };
    }
  }

  for (const label of extractQueryPlaceFocus(userText)) {
    pushLabel(label);
  }

  return { labels };
}

function pointNearFocus(point: GeoPoint, lat: number, lon: number): boolean {
  return Math.abs(point.lat - lat) <= 1.5 && Math.abs(point.lon - lon) <= 1.5;
}

function filterEntitiesToRequestedPlace(
  entities: GeoEntity[],
  focus: { labels: string[]; lat?: number; lon?: number },
): GeoEntity[] {
  const focusedPoints = entities.filter((entity): entity is GeoPoint => {
    if (entity.kind !== "point") return false;
    if (entityMatchesAnyFocus(entity, focus.labels)) return true;
    return focus.lat != null && focus.lon != null && pointNearFocus(entity, focus.lat, focus.lon);
  });

  const focusedAreas = entities.filter((entity) => entity.kind !== "point" && entityMatchesAnyFocus(entity, focus.labels));

  if (focusedPoints.length) {
    return dedupeGeoEntities([...focusedPoints, ...focusedAreas]);
  }

  return entities;
}

function collapseToCanonicalRequestedPoint(
  entities: GeoEntity[],
  focus: { labels: string[]; lat?: number; lon?: number },
  corpus: string,
): GeoEntity[] {
  if (focus.lat == null || focus.lon == null) return entities;

  const preferredLabel = focus.labels[0]?.trim() || `${focus.lat.toFixed(4)}, ${focus.lon.toFixed(4)}`;
  const matchingAreas = entities.filter((entity) => entity.kind !== "point" && entityMatchesAnyFocus(entity, focus.labels));
  const allEntityNames = entities.map((entity) => entityDisplayLabel(entity));

  const canonicalPoint: GeoPoint = {
    kind: "point",
    origin: "source",
    label: preferredLabel,
    lat: focus.lat,
    lon: focus.lon,
    context: extractEntityContext(corpus, preferredLabel, allEntityNames),
  };

  return dedupeGeoEntities([canonicalPoint, ...matchingAreas]);
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
      `https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?${params}`,
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
    const raw = entity.kind === "point" || entity.kind === "extent" ? entity.label : entity.name;
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

function filterStrictContextGeometry(entities: GeoEntity[], corpus: string): GeoEntity[] {
  const sourceEntities = entities.filter((entity) => entity.origin === "source");
  if (!sourceEntities.length) {
    return entities.filter((entity) => entity.origin !== "context" || entity.kind !== "point");
  }

  return entities.filter((entity) => {
    if (entity.origin !== "context" || entity.kind !== "point") return true;
    return contextPointRelatesToSource(entity.label, corpus, sourceEntities);
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

function collectSourceGeoEntitiesFromText(text: string): GeoEntity[] {
  const entities: GeoEntity[] = [];
  const hints: { coords: Array<{ lat: number; lon: number; label?: string }>; names: string[] } = {
    coords: [],
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

  entities.push(...extractSourceExtentEntitiesFromText(text));

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

function deriveSingleSourcePointFastPath(
  text: string,
  sourceEntities: GeoEntity[],
  toolOutputTexts: string[] = [],
): GeoEntity[] | null {
  const sourcePoints = sourceEntities.filter((entity): entity is GeoPoint => entity.kind === "point");
  const hasSourcePolygons = sourceEntities.some((entity) => entity.kind !== "point");

  if (sourcePoints.length !== 1 || hasSourcePolygons) {
    return null;
  }

  const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
  return enrichGeoEntityContext([sourcePoints[0]], corpus);
}

function deriveExactSourcePointEntities(
  text: string,
  sourceEntities: GeoEntity[],
  toolOutputTexts: string[] = [],
): GeoEntity[] | null {
  const sourcePoints = sourceEntities.filter((entity): entity is GeoPoint => entity.kind === "point");
  const hasSourcePolygons = sourceEntities.some((entity) => entity.kind !== "point");
  if (!sourcePoints.length || hasSourcePolygons) {
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
  const sourceEntities = dedupeGeoEntities([
    ...collectSourceGeoEntities(mcpToolArgs, toolOutputTexts),
    ...collectSourceGeoEntitiesFromText(text),
  ]);
  const exactSourcePointEntities = deriveExactSourcePointEntities(text, sourceEntities, toolOutputTexts);
  if (exactSourcePointEntities) {
    return exactSourcePointEntities;
  }

  const singlePointFastPath = deriveSingleSourcePointFastPath(text, sourceEntities, toolOutputTexts);
  if (singlePointFastPath) {
    return singlePointFastPath;
  }

  const contextEntities = extractContextTextEntities(text);
  const merged = [...sourceEntities, ...contextEntities];
  if (merged.length) {
    const corpus = [text, ...toolOutputTexts].filter(Boolean).join("\n\n");
    return enrichGeoEntityContext(merged, corpus);
  }
  return extractGeoEntitiesFallback(text, mcpToolArgs, toolOutputTexts);
}

// ── Agent Registration ────────────────────────────────────────────────────────

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
      toolRoundCount: ANNOTATION({
        reducer: (_current: number = 0, update: number | undefined) => update ?? 0,
        default: () => 0,
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
        let discoveryError: string | null = null;
        try {
          mcpToolDefs = await listMcpTools(resolvedUrl);
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
        const hubServers = await listHubServers(resolvedUrl);
        const serverLabels = new Map(hubServers.map((server) => [server.id, server.label]));
        const priorToolRounds = Number(agentState?.toolRoundCount ?? 0);
        const userText = extractLastUserText(messages);
        const filteredToolDefs = rankMcpToolsForQuery(mcpToolDefs, userText, serverLabels);
        const langchainTools = filteredToolDefs.map((def, index) => {
          const alias = makeSafeToolAlias(index);
          aliasMap[alias] = def.name;
          const { serverId } = parseQualifiedToolName(def.name);
          const toolServerLabel = serverId ? (serverLabels.get(serverId) || serverId) : undefined;
          return (
          tool(
            async (args: any) => callMcpTool(
              resolvedUrl,
              def.name,
              normalizeToolArgsForCall(def.inputSchema, (args as Record<string, unknown>) || {}),
            ),
            {
              name: alias,
              description: summarizeToolDescription(def, toolServerLabel),
              schema: inputSchemaToZod(def.inputSchema) as any,
            }
          )
          );
        });

        const response = await invokeToolPrompt({
          promptText:
            `You are connected to the ${serverLabel} server. This is the primary agent for NON-MAP requests that require external MCP tools. Use the available MCP tools to fulfill the user's request, choose the best matching tool based on descriptions and required arguments, and do not invent results. STAC, asset catalog, collection browsing, and item-listing requests belong here even if the user says show or display. Questions about the currently loaded map, visible layers, or active webmap belong to built-in map exploration capabilities. Some tools may come from different MCP connections; if the user names a connection or data source, prefer tools whose server tag matches that connection. For straightforward rankings, statistics, and current-data requests, minimize tool hopping: prefer one discovery step and one retrieval step, and avoid extra tool rounds unless a required parameter is still missing or the previous tool result explicitly requires another lookup. If the user asks for current or latest U.S. city population and mentions Census without naming a product, prefer the most recent official Census population estimate rather than asking a follow-up unless the choice materially changes the answer. You have already used ${priorToolRounds} MCP tool round(s) in this run. The current query-focused tool subset contains ${filteredToolDefs.length} tool(s) out of ${mcpToolDefs.length} total MCP tools.`,
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
          toolRoundCount: priorToolRounds,
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
          toolRoundCount: Number(agentState?.toolRoundCount ?? 0) + 1,
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
      const userQuery = extractLastUserText(messages);
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
            const entities = await deriveGeoEntities(text, toolArgs, toolOutputs);
            if (isStale()) return;

            const corpus = [text, ...toolOutputs].filter(Boolean).join("\n\n");
            const sourceEntities = entities.filter((entity) => entity.origin === "source");
            const hasSourcePoint = sourceEntities.some((entity) => entity.kind === "point");
            const hasSourceExtent = sourceEntities.some((entity) => entity.kind === "extent");
            const hasExactSourcePoints =
              sourceEntities.some((entity) => entity.kind === "point") &&
              sourceEntities.every((entity) => entity.kind === "point");

            if (!hasExactSourcePoints && !hasSourceExtent) {
              const mentionCandidates = buildPlaceMentionCandidates(text);
              for (const candidate of mentionCandidates) {
                if (isStale()) return;

                const normalizedMention = normalizeMentionLabel(candidate.label);
                const normalizedGeocodeLabel = normalizeMentionLabel(candidate.geocodeLabel);
                const hasQualifiedLocation = /,/.test(candidate.geocodeLabel);
                const hasNamedPoint = entities.some(
                  (entity) =>
                    entity.kind === "point" &&
                    (normalizeMentionLabel((entity as GeoPoint).label).includes(normalizedMention) ||
                      normalizeMentionLabel((entity as GeoPoint).label) === normalizedGeocodeLabel),
                );
                if (hasNamedPoint) continue;
                if (!hasQualifiedLocation && hasSourcePoint && candidate.origin !== "source") continue;
                if (candidate.requiresSourceContext && !contextPointRelatesToSource(candidate.label, corpus, sourceEntities)) continue;

                const hit = await geocodePlaceLabel(candidate.geocodeLabel);
                if (isStale() || !hit) continue;

                const exists = entities.some(
                  (e) =>
                    e.kind === "point" &&
                    Math.abs((e as GeoPoint).lat - hit.lat) < 0.05 &&
                    Math.abs((e as GeoPoint).lon - hit.lon) < 0.05,
                );
                if (!exists) {
                  const allEntityNames = entities.map((e) =>
                    e.kind === "point"
                      ? (e as GeoPoint).label
                      : e.kind === "extent"
                        ? (e as GeoExtent).label
                        : (e as GeoCountry | GeoRegion).name,
                  );
                  entities.push({
                    kind: "point",
                    origin: candidate.origin,
                    label: candidate.label,
                    lat: hit.lat,
                    lon: hit.lon,
                    context: extractEntityContext(corpus, candidate.label, allEntityNames),
                  });
                }
              }
            }

            let strictEntities = filterStrictContextGeometry(entities, corpus);
            const queryFocuses = extractQueryPlaceFocus(userQuery);
            const requestedPlaceFocus = extractRequestedPlaceFocuses(userQuery, toolArgs);
            const isNewsQuery = /\bnews\b|headline|headlines|article/i.test(`${userQuery}\n${text}`);
            const isWeatherQuery = /\bweather\b|forecast|temperature|rain|wind|humidity|precip|feels like|aqi|air quality/i.test(`${userQuery}\n${text}`);

            if ((isNewsQuery || isWeatherQuery) && (requestedPlaceFocus.labels.length || (requestedPlaceFocus.lat != null && requestedPlaceFocus.lon != null))) {
              strictEntities = filterEntitiesToRequestedPlace(strictEntities, requestedPlaceFocus);
            }

            if (isWeatherQuery && requestedPlaceFocus.lat != null && requestedPlaceFocus.lon != null) {
              strictEntities = collapseToCanonicalRequestedPoint(strictEntities, requestedPlaceFocus, corpus);
            }

            if (isNewsQuery && queryFocuses.length) {
              const focusedEntities = strictEntities.filter((entity) => entityMatchesAnyFocus(entity, queryFocuses));
              if (focusedEntities.length) {
                strictEntities = focusedEntities;
              } else {
                const focus = queryFocuses[0];
                const geocodedFocus = await geocodePlaceLabel(focus);
                if (isStale()) return;
                if (geocodedFocus) {
                  strictEntities = [{
                    kind: "point",
                    origin: "source",
                    label: focus,
                    lat: geocodedFocus.lat,
                    lon: geocodedFocus.lon,
                    context: extractEntityContext(corpus, focus),
                  }];
                }
              }
            }

            if (isStale()) return;

            setLastAssistantGeoSnapshot({
              title: deriveSnapshotTitle(text),
              responseText: text,
              updatedAt: new Date().toISOString(),
              entities: strictEntities.map((entity) => ({
                kind: entity.kind,
                origin: entity.origin,
                label: entity.kind === "point" || entity.kind === "extent" ? entity.label : entity.name,
                lat: entity.kind === "point" ? entity.lat : undefined,
                lon: entity.kind === "point" ? entity.lon : undefined,
                west: entity.kind === "extent" ? entity.west : undefined,
                south: entity.kind === "extent" ? entity.south : undefined,
                east: entity.kind === "extent" ? entity.east : undefined,
                north: entity.kind === "extent" ? entity.north : undefined,
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
    description: `${MCP_ROUTING_BASE_DESCRIPTION} Connected server: ${serverLabel}. Do not use this for questions about the active map, current layers, or content already loaded in the app.`,
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
}