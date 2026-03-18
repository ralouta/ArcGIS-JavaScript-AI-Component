import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
import { renderMcpGeoEntities, type GeoEntity } from "../utils/mcpGeoRenderer";

export interface McpPassthroughAgentContext {
  baseUrl?: string;
  serverName?: string;
}

interface ToolAliasMap {
  [alias: string]: string;
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
  const response = await fetch(fetchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
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
}

/** Send a JSON-RPC 2.0 request to the endpoint URL provided by the user. */
function mcpRequest(endpointUrl: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  return mcpPost(url, { jsonrpc: "2.0", id: 1, method, params });
}

/** Fire-and-forget JSON-RPC 2.0 notification (no id). */
async function mcpNotify(endpointUrl: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
  const url = resolveFetchUrl(normalizeUrl(endpointUrl));
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  }).catch(() => {});
}

// ── Session Setup & Tool Discovery ────────────────────────────────────────────

/** Track which endpoint URLs have completed the MCP initialize handshake. */
const initializedEndpoints = new Set<string>();

/** Cached tool definitions per endpoint URL (short-lived to avoid stale names). */
const mcpToolsCache = new Map<string, { tools: McpToolDef[]; at: number }>();
const TOOL_CACHE_TTL_MS = 10_000;

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

// ── Geo entity extraction (regex NER — no LLM call) ─────────────────────────
//
// Runs entirely outside the LangGraph execution cycle via a detached setTimeout
// so the assistant finalises its state before any map work begins.

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
 * Extract geographic entities from response text + MCP tool call arguments
 * using pure regex/lookup — zero extra LLM calls, safe to run off-graph.
 */
function extractGeoEntities(
  text: string,
  mcpToolArgs: Record<string, unknown>[],
): GeoEntity[] {
  const entities: GeoEntity[] = [];
  const lower = text.toLowerCase();

  // 1. Coordinates from tool call arguments (weather, geocode, etc.).
  for (const args of mcpToolArgs) {
    const lat = Number(args.latitude ?? args.lat ?? NaN);
    const lon = Number(args.longitude ?? args.lon ?? args.long ?? NaN);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      const label = String(
        args.location ?? args.city ?? args.name ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      );
      if (!entities.some((e) => e.kind === "point" && Math.abs((e as any).lat - lat) < 0.05)) {
        entities.push({ kind: "point", label, lat, lon });
      }
    }
  }

  // 2. Inline coordinates from text: «lat 33.89, lon 35.50» or «33.89°N 35.50°E».
  const coordRe =
    /(?:lat(?:itude)?[:\s]+(-?\d{1,3}\.\d+))[,\s]+(?:lon(?:gitude)?[:\s]+(-?\d{1,3}\.\d+))/gi;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = coordRe.exec(text)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
        !entities.some((e) => e.kind === "point" && Math.abs((e as any).lat - lat) < 0.05)) {
      entities.push({ kind: "point", label: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, lat, lon });
    }
  }

  // 3. Region names — longest-first to avoid partial matches.
  const regionKeys = Object.keys(REGION_TEXT_ALIASES).sort((a, b) => b.length - a.length);
  const addedRegions = new Set<string>();
  for (const key of regionKeys) {
    if (lower.includes(key)) {
      const regionValue = REGION_TEXT_ALIASES[key];
      if (!addedRegions.has(regionValue)) {
        addedRegions.add(regionValue);
        entities.push({ kind: "region", name: regionValue });
      }
    }
  }

  // 4. Country names — only when no overlapping region polygon was already added,
  //    to avoid double-filing every country in a region.
  for (const country of KNOWN_COUNTRIES) {
    // Simple word-boundary-safe check: surrounded by non-letter chars.
    const re = new RegExp(`(?<![a-z])${country.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i");
    if (re.test(text)) {
      entities.push({ kind: "country", name: country });
    }
  }

  return entities;
}

// ── Agent Registration ────────────────────────────────────────────────────────

export function registerMcpPassthroughAgent(
  assistant: HTMLElement,
  ctx: McpPassthroughAgentContext = {}
) {
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
          current: Record<string, unknown>[] = [],
          update: Record<string, unknown>[] | undefined,
        ) => [...current, ...(update ?? [])],
        default: () => [],
      }),
    });

    async function agentNode(agentState: any) {
      try {
        const messages = normalizeMessages(agentState?.messages);
        const serverLabel = ctx.serverName || "MCP";
        const resolvedUrl = ctx.baseUrl || "";

        // Discover tools dynamically from the MCP server (cached per URL).
        let mcpToolDefs: McpToolDef[] = [];
        let discoveryError: string | null = null;
        try {
          mcpToolDefs = await listMcpTools(resolvedUrl);
        } catch (err: any) {
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

        const response = await invokeToolPrompt({
          promptText:
            `You are connected to the ${serverLabel} server. This is the primary agent for NON-MAP requests that require external MCP tools. Use the available MCP tools to fulfill the user's request, choose the best matching tool based on descriptions and required arguments, and do not invent results. Questions about the currently loaded map, visible layers, or active webmap belong to built-in map exploration capabilities.`,
          messages,
          tools: langchainTools,
          temperature: 0,
        });

        return { messages: [response], toolAliasMap: aliasMap };
      } catch (err: any) {
        return {
          outputMessage: `MCP agent failed to process the request: ${err?.message ?? "Unknown error."}`,
          messages: [],
        };
      }
    }

    async function toolsNode(agentState: any) {
      try {
        const messages = normalizeMessages(agentState?.messages);
        const lastAiMessage = getLastAiMessage(messages);
        if (!lastAiMessage?.tool_calls?.length) return {};
        const aliasMap = (agentState?.toolAliasMap ?? {}) as ToolAliasMap;

        const resolvedUrl = ctx.baseUrl || "";
        const collectedArgs: Record<string, unknown>[] = [];

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
              return new ToolMessage({ content: result, tool_call_id: toolCall.id ?? toolCall.name });
            } catch (error: any) {
              return new ToolMessage({
                content: error?.message || `Failed to call ${toolCall.name} on the ${ctx.serverName || "MCP"} server.`,
                tool_call_id: toolCall.id ?? toolCall.name,
                status: "error",
              });
            }
          })
        );

        return { messages: toolMessages, toolCallArgsList: collectedArgs };
      } catch (err: any) {
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
      const messages = normalizeMessages(agentState?.messages);
      const lastAiMessage = getLastAiMessage(messages);
      const text =
        contentToText(lastAiMessage?.content) ||
        `The ${ctx.serverName || "MCP"} server did not return a response.`;

      // Fire geo rendering as a detached side-effect — completely outside the
      // graph lifecycle so the assistant finishes cleanly before any map work.
      const toolArgs: Record<string, unknown>[] = agentState?.toolCallArgsList ?? [];
      setTimeout(() => {
        try {
          const entities = extractGeoEntities(text, toolArgs);
          if (entities.length) {
            void renderMcpGeoEntities(entities);
          }
        } catch {
          // best-effort — never surface to user
        }
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
    description:
      `Primary agent for external, non-map queries through the ${serverLabel}. Use this for any request that should be answered via MCP tools. Do not use this for questions about the active map, current layers, or content already loaded in the app.`,
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