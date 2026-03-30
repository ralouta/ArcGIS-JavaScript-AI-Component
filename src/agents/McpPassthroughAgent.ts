import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
import { buildToolPromptText, deriveGeoEntities, normalizeUrl, prioritizeRequestedGeoFocus, resolveHubServersUrl, type McpToolDef } from "./mcpAgentCore";
import { clearMcpGeoLayer, renderMcpGeoEntities, type GeoEntity } from "../utils/mcpGeoRenderer";
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

let latestGeoRenderToken = 0;
let pendingGeoRenderTimer: number | null = null;
let latestMcpRunToken = 0;
const cancelBoundAssistants = new WeakSet<HTMLElement>();
const activeMcpAbortControllers = new Set<AbortController>();
const MCP_DISCOVERY_TIMEOUT_MS = 8_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 15_000;
const MCP_NOTIFY_TIMEOUT_MS = 3_000;
const HUB_SERVERS_TIMEOUT_MS = 4_000;

const geoRenderSelectionTool = tool(
  async (args: any) => JSON.stringify(args ?? {}),
  {
    name: "select_geo_render_entities",
    description:
      "Choose which derived geographic entities should be rendered on the map. " +
      "Keep only places that are directly relevant to the user's request and materially support the assistant's answer. " +
      "Exclude incidental mentions, malformed place names, and locations that only appear as side references.",
    schema: z.object({
      keepIndices: z.array(z.number().int().min(0)).max(20),
      rationale: z.string().optional(),
    }),
  },
);

function summarizeEntityForSelection(entity: GeoEntity, index: number): string {
  const label = entity.kind === "point" || entity.kind === "extent" ? entity.label : entity.name;
  const detailParts = [
    `kind=${entity.kind}`,
    `origin=${entity.origin}`,
    entity.description ? `description=${JSON.stringify(entity.description.slice(0, 140))}` : "",
    entity.context?.summary ? `summary=${JSON.stringify(entity.context.summary.slice(0, 220))}` : "",
    entity.context?.mcpFields?.length
      ? `fields=${JSON.stringify(entity.context.mcpFields.slice(0, 3).map((field) => `${field.label}: ${field.value}`).join(" | "))}`
      : "",
    entity.context?.links?.[0]?.url ? `link=${entity.context.links[0].url}` : "",
  ].filter(Boolean);
  return `${index}. ${JSON.stringify(label)} (${detailParts.join(", ")})`;
}

async function pruneGeoEntitiesWithModel(
  entities: GeoEntity[],
  userText: string,
  responseText: string,
): Promise<GeoEntity[]> {
  if (entities.length <= 1) return entities;

  const entitySummary = entities
    .slice(0, 20)
    .map((entity, index) => summarizeEntityForSelection(entity, index))
    .join("\n");

  try {
    const response = await invokeToolPrompt({
      promptText:
        "You are selecting map-worthy geographic entities for an ArcGIS map. " +
        "Use the user's request and the assistant answer to keep only entities that directly anchor the answer geographically. " +
        "Prefer explicit geometry and canonical place names. " +
        "Reject malformed strings, incidental references, placeholder location-only records, and places that are not central to the answer. " +
        "If multiple candidates represent separate returned result items for the same geography, keep each one when it adds distinct supporting context, links, or summaries. " +
        "Prefer richer entities over placeholders that only restate the place name.",
      messages: [
        new HumanMessage(
          [
            `User request:\n${userText || ""}`,
            `Assistant answer:\n${responseText || ""}`,
            `Candidate entities:\n${entitySummary}`,
            "Return your decision only by calling select_geo_render_entities.",
          ].join("\n\n"),
        ),
      ],
      tools: [geoRenderSelectionTool],
      temperature: 0,
    });

    const toolCalls = Array.isArray((response as any)?.tool_calls) ? (response as any).tool_calls : [];
    const call = toolCalls.find((toolCall: any) => toolCall?.name === "select_geo_render_entities");
    const keepIndices = Array.isArray(call?.args?.keepIndices)
      ? call.args.keepIndices.filter((value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < entities.length)
      : [];

    if (!keepIndices.length) return entities;

    const uniqueIndices = [...new Set(keepIndices.map((value: number) => Number(value)))] as number[];
    const selected = uniqueIndices.map((index) => entities[index]).filter(Boolean);
    return selected.length ? selected : entities;
  } catch {
    return entities;
  }
}

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
  return (
    name === "AbortError" ||
    name === "Canceled" ||
    /abort/i.test(message) ||
    /\bcancel/i.test(message)
  );
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
  if (cancelBoundAssistants.has(assistant)) return;
  assistant.addEventListener("arcgisCancel", () => {
    cancelPendingMcpGeoRender();
  });
  cancelBoundAssistants.add(assistant);
}

function toRelayUrl(absoluteUrl: string): string {
  try {
    const url = new URL(absoluteUrl);
    const scheme = url.protocol.replace(":", "");
    return `/dev-mcp-relay/${scheme}/${url.host}${url.pathname}`;
  } catch {
    return absoluteUrl;
  }
}

function resolveFetchUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? toRelayUrl(url) : url;
}

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
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {}
      throw new Error(`MCP server returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const parsed: any = JSON.parse(line.slice(6).trim());
        if (parsed.error) throw new Error(String(parsed.error.message ?? "MCP RPC error"));
        if ("result" in parsed) return parsed.result;
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

function mcpRequest(endpointUrl: string, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  return mcpPost(url, { jsonrpc: "2.0", id: 1, method, params, __timeoutMs: timeoutMs });
}

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

const initializedEndpoints = new Set<string>();
const mcpToolsCache = new Map<string, { tools: McpToolDef[]; at: number }>();
const hubServersCache = new Map<string, { servers: HubServerSummary[]; at: number }>();
const TOOL_CACHE_TTL_MS = 300_000;
const HUB_SERVERS_CACHE_TTL_MS = 60_000;

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

function clearMcpCaches(endpointUrl: string): void {
  const key = normalizeUrl(endpointUrl);
  initializedEndpoints.delete(key);
  mcpToolsCache.delete(key);
  hubServersCache.delete(key);
}

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

async function callMcpTool(endpointUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  await ensureInitialized(endpointUrl);
  const result: any = await mcpRequest(endpointUrl, "tools/call", { name, arguments: args }, MCP_TOOL_CALL_TIMEOUT_MS);
  if (result?.isError) {
    return `Tool returned an error: ${extractText(result.content) || "Unknown tool error."}`;
  }
  return extractText(result?.content) || JSON.stringify(result ?? "");
}

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

function normalizeToolArgsForCall(inputSchema: Record<string, unknown> | undefined, args: Record<string, unknown>): Record<string, unknown> {
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
    } catch {}
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
  return { serverId: name.slice(0, idx), toolName: name.slice(idx + 2) };
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
      ? json.servers.map((server: any) => ({
          id: String(server.id ?? ""),
          label: String(server.label ?? server.id ?? ""),
          status: server.status ? String(server.status) : undefined,
        }))
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
  "Use this when the answer depends on connected MCP tools, external services, or structured remote data rather than only what is already visible in the active map. " +
  "Prefer this agent whenever the answer is not already visible in the active map layers or current web map.";

function buildDescriptionFromTools(tools: McpToolDef[], serverName: string, hubServers: HubServerSummary[] = []): string {
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
    "Choose tools by matching the user's requested source, operation, and geographic focus.",
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
  } catch {}
}

function normalizeMessages(messages: any): any[] {
  const rawMessages = Array.isArray(messages) ? messages : [];
  if (rawMessages.length === 1 && Array.isArray(rawMessages[0])) return rawMessages[0];
  return rawMessages.flatMap((message: any) => (Array.isArray(message) ? message : [message]));
}

function isAiMessageLike(message: any): boolean {
  return Boolean(
    message && (
      AIMessage.isInstance(message) ||
      message.getType?.() === "ai" ||
      message.lc_kwargs?.type === "ai" ||
      message.kwargs?.type === "ai" ||
      message.role === "assistant"
    )
  );
}

function isToolMessageLike(message: any): boolean {
  return Boolean(
    message && (
      ToolMessage.isInstance(message) ||
      message.getType?.() === "tool" ||
      message.lc_kwargs?.type === "tool" ||
      message.kwargs?.type === "tool" ||
      message.role === "tool"
    )
  );
}

function hasToolCalls(message: any): boolean {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
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

function extractMessageText(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (typeof message.kwargs?.content === "string") return message.kwargs.content;
  if (typeof message.lc_kwargs?.content === "string") return message.lc_kwargs.content;
  return contentToText(message.content);
}

function sanitizeMessagesForPrompt(messages: any[]): any[] {
  const flattened = normalizeMessages(messages);
  const sanitized: any[] = [];
  let awaitingToolResponses = false;

  for (const message of flattened) {
    if (!message) continue;
    if (isToolMessageLike(message)) {
      if (awaitingToolResponses) sanitized.push(message);
      continue;
    }
    sanitized.push(message);
    awaitingToolResponses = isAiMessageLike(message) && hasToolCalls(message);
  }

  let tailToolBlockStart = -1;
  if (sanitized.length) {
    let index = sanitized.length - 1;
    while (index >= 0 && isToolMessageLike(sanitized[index])) index -= 1;
    if (index >= 0 && index < sanitized.length - 1 && isAiMessageLike(sanitized[index]) && hasToolCalls(sanitized[index])) {
      tailToolBlockStart = index;
    }
  }

  const visibleHistory = sanitized.filter((message) => !isToolMessageLike(message) && !(isAiMessageLike(message) && hasToolCalls(message)));
  const recentVisibleHistory: any[] = [];
  let totalChars = 0;
  for (let index = visibleHistory.length - 1; index >= 0; index -= 1) {
    const message = visibleHistory[index];
    const messageText = extractMessageText(message);
    const nextTotal = totalChars + messageText.length;
    if (recentVisibleHistory.length >= 8 || nextTotal > 16000) break;
    recentVisibleHistory.unshift(message);
    totalChars = nextTotal;
  }

  if (tailToolBlockStart >= 0) {
    return [...recentVisibleHistory, ...sanitized.slice(tailToolBlockStart)];
  }
  return recentVisibleHistory;
}

function getLastAiMessage(messages: any[]): AIMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (AIMessage.isInstance(messages[i])) return messages[i];
  }
  return null;
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

function makeSafeToolAlias(index: number): string {
  return `mcp_tool_${index + 1}`;
}

function deriveSnapshotTitle(text: string): string {
  const cleaned = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Latest assistant results";
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0]?.trim() || cleaned;
  return firstSentence.length > 88 ? `${firstSentence.slice(0, 85).trimEnd()}...` : firstSentence;
}

export function registerMcpPassthroughAgent(
  assistant: HTMLElement,
  ctx: McpPassthroughAgentContext = {},
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
        reducer: (current: ToolAliasMap = {}, update: ToolAliasMap | undefined) => ({ ...current, ...(update ?? {}) }),
        default: () => ({}),
      }),
      toolCallArgsList: ANNOTATION({
        reducer: (_current: Record<string, unknown>[] = [], update: Record<string, unknown>[] | undefined) => update ?? [],
        default: () => [],
      }),
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
        const promptMessages = sanitizeMessagesForPrompt(messages);
        const serverLabel = ctx.serverName || "MCP";
        const resolvedUrl = ctx.baseUrl || "";
        const userText = extractLastUserText(messages);

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

        if (discoveryError || !mcpToolDefs.length) {
          return {
            outputMessage: discoveryError
              ? `Could not connect to the ${serverLabel}: ${discoveryError}`
              : `The ${serverLabel} did not expose any tools.`,
            messages: [],
          };
        }

        const aliasMap: ToolAliasMap = {};
        const hubServers = await listHubServers(resolvedUrl);
        const serverLabels = new Map(hubServers.map((server) => [server.id, server.label]));
        const priorToolRounds = Number(agentState?.toolRoundCount ?? 0);
        const langchainTools = mcpToolDefs.map((def, index) => {
          const alias = makeSafeToolAlias(index);
          aliasMap[alias] = def.name;
          const { serverId } = parseQualifiedToolName(def.name);
          const toolServerLabel = serverId ? (serverLabels.get(serverId) || serverId) : undefined;
          return tool(
            async (args: any) => callMcpTool(
              resolvedUrl,
              def.name,
              normalizeToolArgsForCall(def.inputSchema, (args as Record<string, unknown>) || {}),
            ),
            {
              name: alias,
              description: summarizeToolDescription(def, toolServerLabel),
              schema: inputSchemaToZod(def.inputSchema) as any,
            },
          );
        });

        const response = await invokeToolPrompt({
          promptText: `${buildToolPromptText(serverLabel, hubServers, mcpToolDefs.length, priorToolRounds)}${userText ? `\n\nCurrent user request: ${userText}` : ""}`,
          messages: promptMessages,
          tools: langchainTools,
          temperature: 0,
        });

        if (isMcpRunStale(runToken)) {
          return { messages: [], outputMessage: "", canceled: true };
        }

        return {
          messages: [response],
          toolAliasMap: aliasMap,
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
        const priorArgs: Record<string, unknown>[] = Array.isArray(agentState?.toolCallArgsList) ? agentState.toolCallArgsList : [];
        const priorOutputs: string[] = Array.isArray(agentState?.toolOutputTextList) ? agentState.toolOutputTextList : [];
        const collectedArgs: Record<string, unknown>[] = [];
        const collectedOutputs: string[] = [];

        const toolMessages = await Promise.all(
          lastAiMessage.tool_calls.map(async (toolCall: any) => {
            try {
              const originalToolName = aliasMap[toolCall.name] || toolCall.name;
              const args = (toolCall.args as Record<string, unknown>) || {};
              collectedArgs.push(args);
              const result = await callMcpTool(resolvedUrl, originalToolName, args);
              if (isMcpRunStale(runToken)) return null;
              if (result) collectedOutputs.push(result);
              return new ToolMessage({ content: result, tool_call_id: toolCall.id ?? toolCall.name });
            } catch (error: any) {
              if (isMcpRunStale(runToken) || isAbortLikeError(error)) return null;
              return new ToolMessage({
                content: error?.message || `Failed to call ${toolCall.name} on the ${ctx.serverName || "MCP"} server.`,
                tool_call_id: toolCall.id ?? toolCall.name,
                status: "error",
              });
            }
          }),
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
        if (!lastAiMessage) return "respond";
        return lastAiMessage.tool_calls?.length ? "tools" : "respond";
      } catch {
        return "respond";
      }
    }

    function respondNode(agentState: any) {
      if (agentState?.canceled) {
        return { outputMessage: "" };
      }

      const messages = normalizeMessages(agentState?.messages);
      const userText = extractLastUserText(messages);
      const lastAiMessage = getLastAiMessage(messages);
      const text = contentToText(lastAiMessage?.content) || `The ${ctx.serverName || "MCP"} server did not return a response.`;
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
          try {
            const derivedEntities = await deriveGeoEntities(text, toolArgs, toolOutputs);
            const prunedEntities = await pruneGeoEntitiesWithModel(derivedEntities, userText, text);
            const entities = prioritizeRequestedGeoFocus(prunedEntities, userText, toolArgs);
            if (currentToken !== latestGeoRenderToken) return;

            setLastAssistantGeoSnapshot({
              title: deriveSnapshotTitle(text),
              responseText: text,
              updatedAt: new Date().toISOString(),
              entities: entities.map((entity: GeoEntity) => ({
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

            if (!entities.length) {
              clearMcpGeoLayer();
              return;
            }

            await renderMcpGeoEntities(entities);
          } catch {
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
