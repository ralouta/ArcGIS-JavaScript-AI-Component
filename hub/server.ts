/**
 * Local MCP Hub — an Express server that bridges to MCP servers and exposes
 * their tools over a single HTTP JSON-RPC surface.
 *
 * Supports two transport modes:
 *   • "url"   — connect to an already-deployed MCP server via HTTP (default)
 *   • "stdio" — spawn a local process (npx, node, python, …)
 *
 * Features:
 *   • REST management API to add / edit / remove / start / stop servers
 *   • JSON-RPC 2.0 surface (initialize, tools/list, tools/call)
 *   • Persists config to mcp-hub.config.json
 *
 * Usage:
 *   npx tsx hub/server.ts                        (uses mcp-hub.config.json)
 *   npx tsx hub/server.ts --config my.json       (custom config path)
 *   MCP_HUB_PORT=9000 npx tsx hub/server.ts      (override port)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServerConfig {
  id: string;
  label: string;
  /** "url" = bridge to running server; "stdio" = spawn local process. */
  transport: "url" | "stdio";
  /** For transport "url": the endpoint URL (e.g. http://host:port/mcp). */
  url?: string;
  /** For transport "stdio": the executable to run. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
}

interface HubConfig {
  port: number;
  servers: ServerConfig[];
}

interface LegacyDesktopConfig {
  port?: number;
  mcpServers?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ServerState {
  config: ServerConfig;
  client: Client | null;
  activeTransport: Transport | null;
  status: "stopped" | "starting" | "running" | "error";
  error: string | null;
  tools: ToolDef[];
}

interface KnowledgeBaseToolField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

interface KnowledgeBaseToolRecord {
  name: string;
  description?: string;
  fieldCount: number;
  requiredFieldCount: number;
  fields: KnowledgeBaseToolField[];
}

interface KnowledgeBaseServerRecord {
  id: string;
  label: string;
  transport: "url" | "stdio";
  endpoint?: string;
  command?: string;
  enabled: boolean;
  status: ServerState["status"];
  error: string | null;
  toolCount: number;
  capabilitySummary: string[];
  tools: KnowledgeBaseToolRecord[];
  lastValidatedAt?: string;
}

interface McpKnowledgeBaseDocument {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    configPath: string;
    hubName: string;
  };
  summary: {
    serverCount: number;
    enabledCount: number;
    runningCount: number;
    documentedToolCount: number;
  };
  servers: KnowledgeBaseServerRecord[];
}

// ── Config persistence ────────────────────────────────────────────────────────

// Resolve config path:
//   1. --config <path> CLI flag (explicit override)
//   2. mcp-hub.config.local.json  (gitignored, personal override)
//   3. mcp-hub.config.json        (gitignored, copied from .example.json on first deploy)
//
// Neither .json file is committed. Clone the repo, then:
//   cp mcp-hub.config.example.json mcp-hub.config.json
//   # edit mcp-hub.config.json with your servers/keys
function resolveConfigPath(): string {
  const flagIdx = process.argv.indexOf("--config");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return resolve(process.argv[flagIdx + 1]);
  }
  const localPath = resolve("mcp-hub.config.local.json");
  if (existsSync(localPath)) return localPath;
  return resolve("mcp-hub.config.json");
}

const CONFIG_PATH = resolveConfigPath();
const KNOWLEDGE_BASE_PATH = resolve("mcp-knowledge-base.json");

function loadConfig(): HubConfig {
  if (!existsSync(CONFIG_PATH)) {
    const empty: HubConfig = { port: 8808, servers: [] };
    writeFileSync(CONFIG_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as
    | HubConfig
    | LegacyDesktopConfig
    | Record<string, unknown>;

  if (
    raw &&
    typeof raw === "object" &&
    "mcpServers" in raw &&
    raw.mcpServers &&
    typeof raw.mcpServers === "object"
  ) {
    const normalized: HubConfig = {
      port: typeof raw.port === "number" ? raw.port : 8808,
      servers: Object.entries(raw.mcpServers).map(([name, value]) =>
        normalizeIncomingServer(
          {
            id: generateId(),
            label: name,
            ...(value && typeof value === "object" ? value : {}),
          },
          true,
        ),
      ),
    };

    return normalized;
  }

  const parsed = raw as Partial<HubConfig>;
  return {
    port: typeof parsed.port === "number" ? parsed.port : 8808,
    servers: Array.isArray(parsed.servers)
      ? parsed.servers.map((s) => normalizeIncomingServer(s, true))
      : [],
  };
}

let hubConfig: HubConfig;

function saveConfig(): void {
  hubConfig.servers = Array.from(serverStates.values()).map((s) => s.config);
  writeFileSync(CONFIG_PATH, JSON.stringify(hubConfig, null, 2));
}

function generateId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTransport(input: Record<string, unknown>): "url" | "stdio" {
  const direct = input.transport;
  const legacy = input.transportType;
  if (direct === "url" || legacy === "url") return "url";
  if (direct === "stdio" || legacy === "stdio") return "stdio";
  if (typeof input.url === "string" && input.url.trim()) return "url";
  return "stdio";
}

function normalizeEnv(
  env: unknown,
  environment: unknown,
): Record<string, string> {
  const source =
    env && typeof env === "object" && !Array.isArray(env)
      ? env
      : environment &&
          typeof environment === "object" &&
          !Array.isArray(environment)
        ? environment
        : {};

  return Object.fromEntries(
    Object.entries(source as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v ?? ""),
    ]),
  );
}

function normalizeIncomingServer(
  input: unknown,
  defaultEnabled: boolean,
): ServerConfig {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const transport = normalizeTransport(obj);
  const label =
    typeof obj.label === "string" && obj.label.trim()
      ? obj.label.trim()
      : typeof obj.name === "string" && obj.name.trim()
        ? obj.name.trim()
        : generateId();

  return {
    id:
      typeof obj.id === "string" && obj.id.trim()
        ? obj.id.trim()
        : generateId(),
    label,
    transport,
    url:
      transport === "url" && typeof obj.url === "string"
        ? obj.url.trim()
        : undefined,
    command:
      transport === "stdio" && typeof obj.command === "string"
        ? obj.command.trim()
        : undefined,
    args: Array.isArray(obj.args) ? obj.args.map((a) => String(a)) : [],
    env: normalizeEnv(obj.env, obj.environment),
    cwd:
      typeof obj.cwd === "string" && obj.cwd.trim()
        ? obj.cwd.trim()
        : undefined,
    enabled:
      typeof obj.enabled === "boolean" ? obj.enabled : defaultEnabled,
  };
}

// ── Runtime state ─────────────────────────────────────────────────────────────

const serverStates = new Map<string, ServerState>();

/** Map qualified-tool-name → server id. */
const toolRouter = new Map<string, string>();

function inferFieldType(schema: Record<string, unknown> | undefined, key: string): string {
  const properties = schema?.properties;
  const property = properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)[key]
    : undefined;
  if (!property || typeof property !== "object" || Array.isArray(property)) return "unknown";

  const typeValue = (property as Record<string, unknown>).type;
  if (Array.isArray(typeValue)) return typeValue.map((value) => String(value)).join(" | ");
  if (typeof typeValue === "string" && typeValue.trim()) return typeValue;

  if (Array.isArray((property as Record<string, unknown>).enum)) return "enum";
  if ((property as Record<string, unknown>).properties) return "object";
  if ((property as Record<string, unknown>).items) return "array";
  return "unknown";
}

function extractToolFields(inputSchema?: Record<string, unknown>): KnowledgeBaseToolField[] {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];

  const required = new Set(
    Array.isArray(inputSchema?.required) ? inputSchema.required.map((value) => String(value)) : [],
  );

  return Object.entries(properties as Record<string, unknown>).map(([name, property]) => ({
    name,
    type: inferFieldType(inputSchema, name),
    required: required.has(name),
    description:
      property && typeof property === "object" && !Array.isArray(property) && typeof (property as Record<string, unknown>).description === "string"
        ? String((property as Record<string, unknown>).description)
        : undefined,
  }));
}

function summarizeCapabilities(tools: KnowledgeBaseToolRecord[]): string[] {
  const phrases = tools.map((tool) => {
    const description = tool.description?.trim();
    if (description) return description.replace(/\s+/g, " ").replace(/[.\s]+$/g, "");
    return tool.name.replace(/[_-]+/g, " ");
  });

  return [...new Set(phrases)].slice(0, 12);
}

function loadExistingKnowledgeBase(): McpKnowledgeBaseDocument | null {
  if (!existsSync(KNOWLEDGE_BASE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(KNOWLEDGE_BASE_PATH, "utf-8")) as McpKnowledgeBaseDocument;
  } catch {
    return null;
  }
}

function buildKnowledgeBaseDocument(): McpKnowledgeBaseDocument {
  const previous = loadExistingKnowledgeBase();
  const previousById = new Map((previous?.servers ?? []).map((server) => [server.id, server]));

  const servers: KnowledgeBaseServerRecord[] = Array.from(serverStates.values()).map((state) => {
    const previousRecord = previousById.get(state.config.id);
    const tools = state.tools.length
      ? state.tools.map((tool) => {
          const fields = extractToolFields(tool.inputSchema);
          return {
            name: tool.name,
            description: tool.description,
            fieldCount: fields.length,
            requiredFieldCount: fields.filter((field) => field.required).length,
            fields,
          };
        })
      : previousRecord?.tools ?? [];

    const hasValidatedTools = state.tools.length > 0;
    return {
      id: state.config.id,
      label: state.config.label,
      transport: state.config.transport,
      endpoint: state.config.url,
      command: state.config.command,
      enabled: state.config.enabled,
      status: state.status,
      error: state.error,
      toolCount: tools.length,
      capabilitySummary: tools.length ? summarizeCapabilities(tools) : previousRecord?.capabilitySummary ?? [],
      tools,
      lastValidatedAt: hasValidatedTools ? new Date().toISOString() : previousRecord?.lastValidatedAt,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      configPath: CONFIG_PATH,
      hubName: "mcp-local-hub",
    },
    summary: {
      serverCount: servers.length,
      enabledCount: servers.filter((server) => server.enabled).length,
      runningCount: servers.filter((server) => server.status === "running").length,
      documentedToolCount: servers.reduce((total, server) => total + server.toolCount, 0),
    },
    servers,
  };
}

function saveKnowledgeBase(): McpKnowledgeBaseDocument {
  const document = buildKnowledgeBaseDocument();
  writeFileSync(KNOWLEDGE_BASE_PATH, JSON.stringify(document, null, 2));
  return document;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

async function startServer(state: ServerState): Promise<void> {
  if (state.status === "running" || state.status === "starting") return;

  state.status = "starting";
  state.error = null;

  try {
    let transport: Transport;

    if (state.config.transport === "stdio") {
      // ── Stdio: spawn a local process ────────────────────────────────────
      if (!state.config.command) throw new Error("command is required for stdio transport");
      const stdio = new StdioClientTransport({
        command: state.config.command,
        args: state.config.args ?? [],
        env:
          state.config.env && Object.keys(state.config.env).length > 0
            ? { ...(process.env as Record<string, string>), ...state.config.env }
            : undefined,
        cwd: state.config.cwd,
        stderr: "pipe",
      });

      const stderr = stdio.stderr;
      if (stderr && "on" in stderr) {
        (stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
          process.stderr.write(`[${state.config.label}] ${chunk}`);
        });
      }

      transport = stdio;
    } else {
      // ── URL: bridge to a running remote server ──────────────────────────
      if (!state.config.url) throw new Error("url is required for url transport");
      const endpoint = new URL(state.config.url);

      // Try streamable HTTP first (MCP 2025-03-26); fall back to SSE only when
      // the error is NOT a 404, which would mean SSE will also fail.
      try {
        const streamable = new StreamableHTTPClientTransport(endpoint);
        const probe = new Client({ name: "mcp-hub/probe", version: "1.0.0" });
        await probe.connect(streamable);
        await probe.close();
        transport = new StreamableHTTPClientTransport(endpoint);
      } catch (probeErr: any) {
        const msg: string = probeErr?.message ?? "";
        if (/\b404\b|not found/i.test(msg)) {
          throw new Error(`Cannot connect to MCP server at ${state.config.url} (${msg}). Check the URL.`);
        }
        transport = new SSEClientTransport(endpoint);
      }
    }

    const client = new Client({
      name: `mcp-hub/${state.config.id}`,
      version: "1.0.0",
    });

    await client.connect(transport);

    // Strip null nextCursor from responses so strict Zod schema doesn't reject
    // servers that send nextCursor: null instead of omitting the field.
    const origOnMessage = transport.onmessage;
    transport.onmessage = (msg: any) => {
      if (msg?.result != null && "nextCursor" in msg.result && msg.result.nextCursor === null) {
        delete msg.result.nextCursor;
      }
      origOnMessage?.(msg);
    };

    state.client = client;
    state.activeTransport = transport;
    state.status = "running";

    const { tools } = await client.listTools();
    state.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    const mode = state.config.transport === "stdio" ? `pid ${(transport as any).pid}` : state.config.url;
    console.log(
      `  ✓ ${state.config.label} — ${state.tools.length} tools (${mode})`,
    );

    rebuildToolRouter();
  } catch (err: any) {
    state.status = "error";
    state.error = err?.message ?? "Failed to start";
    state.client = null;
    state.activeTransport = null;
    state.tools = [];
    console.error(`  ✗ ${state.config.label}: ${state.error}`);
    rebuildToolRouter();
  }
}

async function stopServer(state: ServerState): Promise<void> {
  if (state.status === "stopped") return;
  try {
    if (state.activeTransport) await state.activeTransport.close();
  } catch {}
  state.client = null;
  state.activeTransport = null;
  state.status = "stopped";
  state.error = null;
  state.tools = [];
  rebuildToolRouter();
  console.log(`  ⏹ ${state.config.label} stopped`);
}

function rebuildToolRouter(): void {
  toolRouter.clear();
  for (const [serverId, state] of serverStates) {
    if (state.status !== "running") continue;
    for (const t of state.tools) {
      toolRouter.set(`${serverId}__${t.name}`, serverId);
    }
  }
  saveKnowledgeBase();
}

function getAggregatedTools() {
  const tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }> = [];

  for (const [serverId, state] of serverStates) {
    if (state.status !== "running") continue;
    for (const t of state.tools) {
      tools.push({
        name: `${serverId}__${t.name}`,
        description: `[${state.config.label}] ${t.description || t.name}`,
        inputSchema: t.inputSchema,
      });
    }
  }

  return tools;
}

function serializeState(state: ServerState) {
  return {
    id: state.config.id,
    label: state.config.label,
    transport: state.config.transport,
    url: state.config.url ?? null,
    command: state.config.command ?? null,
    args: state.config.args ?? [],
    env: state.config.env ?? {},
    cwd: state.config.cwd ?? null,
    enabled: state.config.enabled,
    status: state.status,
    error: state.error,
    toolCount: state.tools.length,
    tools: state.tools.map((t) => t.name),
  };
}

// ── Express app ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health
  app.get("/health", (_req: Request, res: Response) => {
    const states = Array.from(serverStates.values());
    res.json({
      status: "ok",
      serverCount: states.length,
      runningCount: states.filter((s) => s.status === "running").length,
      toolCount: toolRouter.size,
    });
  });

  // ── REST management API ───────────────────────────────────────────────────

  // List all servers
  app.get("/servers", (_req: Request, res: Response) => {
    res.json({
      servers: Array.from(serverStates.values()).map(serializeState),
    });
  });

  app.get("/knowledge-base", (_req: Request, res: Response) => {
    res.json(saveKnowledgeBase());
  });

  app.post("/knowledge-base/rebuild", (_req: Request, res: Response) => {
    res.json(saveKnowledgeBase());
  });

  // Add a server
  app.post("/servers", async (req: Request, res: Response) => {
    const incoming = req.body as Record<string, unknown>;
    const config = normalizeIncomingServer(incoming, true);

    if (config.transport === "url" && (!config.url || typeof config.url !== "string")) {
      res.status(400).json({ error: "url is required for url transport" });
      return;
    }
    if (config.transport === "stdio" && (!config.command || typeof config.command !== "string")) {
      res.status(400).json({ error: "command is required for stdio transport" });
      return;
    }

    const state: ServerState = {
      config,
      client: null,
      activeTransport: null,
      status: "stopped",
      error: null,
      tools: [],
    };

    serverStates.set(config.id, state);
    saveConfig();

    if (config.enabled) {
      await startServer(state);
    }

    res.status(201).json(serializeState(state));
  });

  // Update a server
  app.put("/servers/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const state = serverStates.get(id);
    if (!state) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const wasRunning = state.status === "running";
    if (wasRunning) await stopServer(state);

    const incoming = req.body as Record<string, unknown>;
    const transportOverride = normalizeTransport({
      transport: incoming.transport,
      transportType: incoming.transportType,
      url: incoming.url,
    });

    if (incoming.label !== undefined) {
      state.config.label = String(incoming.label).trim() || state.config.label;
    }
    if (incoming.transport !== undefined || incoming.transportType !== undefined || incoming.url !== undefined) {
      state.config.transport = transportOverride;
    }
    if (incoming.url !== undefined) {
      state.config.url = typeof incoming.url === "string" ? incoming.url.trim() : undefined;
    }
    if (incoming.command !== undefined) {
      state.config.command = typeof incoming.command === "string" ? incoming.command.trim() : undefined;
    }
    if (incoming.args !== undefined) {
      state.config.args = Array.isArray(incoming.args)
        ? incoming.args.map(String)
        : state.config.args;
    }
    if (incoming.env !== undefined || incoming.environment !== undefined) {
      state.config.env = normalizeEnv(incoming.env, incoming.environment);
    }
    if (incoming.cwd !== undefined) {
      state.config.cwd = String(incoming.cwd).trim() || undefined;
    }
    if (incoming.enabled !== undefined) {
      state.config.enabled = Boolean(incoming.enabled);
    }

    saveConfig();

    if (state.config.enabled) {
      await startServer(state);
    }

    res.json(serializeState(state));
  });

  // Delete a server
  app.delete("/servers/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const state = serverStates.get(id);
    if (!state) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    await stopServer(state);
    serverStates.delete(id);
    saveConfig();
    res.status(204).end();
  });

  // Start a server
  app.post("/servers/:id/start", async (req: Request, res: Response) => {
    const state = serverStates.get(String(req.params.id));
    if (!state) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    state.config.enabled = true;
    saveConfig();
    await startServer(state);
    res.json(serializeState(state));
  });

  // Stop a server
  app.post("/servers/:id/stop", async (req: Request, res: Response) => {
    const state = serverStates.get(String(req.params.id));
    if (!state) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    state.config.enabled = false;
    saveConfig();
    await stopServer(state);
    res.json(serializeState(state));
  });

  // ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────

  app.post("/", handleJsonRpc);
  app.post("/mcp", handleJsonRpc);

  return app;
}

async function handleJsonRpc(req: Request, res: Response) {
  const { id, method, params } = req.body as {
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
  };

  // Notifications (no id) — just acknowledge.
  if (id === undefined || id === null) {
    res.status(204).end();
    return;
  }

  const ok = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    res.json({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-local-hub", version: "1.0.0" },
      });
      return;
    }
    case "tools/list": {
      ok({ tools: getAggregatedTools() });
      return;
    }
    case "tools/call": {
      const toolName = params?.name as string | undefined;
      if (!toolName) {
        fail(-32602, "Missing tool name.");
        return;
      }

      const serverId = toolRouter.get(toolName);
      if (!serverId) {
        fail(-32602, `Unknown tool: ${toolName}`);
        return;
      }

      const state = serverStates.get(serverId);
      if (!state?.client) {
        fail(-32000, "Server not connected.");
        return;
      }

      const originalName = toolName.replace(`${serverId}__`, "");
      try {
        const result = await state.client.callTool({
          name: originalName,
          arguments: (params?.arguments as Record<string, unknown>) ?? {},
        });
        ok(result);
      } catch (err: any) {
        fail(-32000, err?.message ?? "Tool call failed.");
      }
      return;
    }
    default:
      fail(-32601, `Method not found: ${method}`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  hubConfig = loadConfig();
  const port = Number(process.env.MCP_HUB_PORT) || hubConfig.port || 8808;

  console.log("MCP Local Hub — starting …");

  for (const serverConfig of hubConfig.servers) {
    const state: ServerState = {
      config: serverConfig,
      client: null,
      activeTransport: null,
      status: "stopped",
      error: null,
      tools: [],
    };
    serverStates.set(serverConfig.id, state);

    if (serverConfig.enabled) {
      await startServer(state);
    }
  }

  saveKnowledgeBase();

  const app = buildApp();
  app.listen(port, () => {
    console.log(`\nMCP Hub listening on http://127.0.0.1:${port}`);
    console.log(`  JSON-RPC:  POST /  or  POST /mcp`);
    console.log(`  Manage:    GET|POST /servers   PUT|DELETE /servers/:id`);
    console.log(`  Toggle:    POST /servers/:id/start   POST /servers/:id/stop`);
    console.log(`  Health:    GET /health\n`);
  });

  const shutdown = async () => {
    console.log("\nShutting down MCP Hub …");
    for (const state of serverStates.values()) {
      await stopServer(state);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
