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
  /** For transport "url": the endpoint URL (e.g. http://host:port/sse). */
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

// ── Config persistence ────────────────────────────────────────────────────────

const CONFIG_PATH = resolve(
  process.argv.includes("--config") && process.argv[process.argv.indexOf("--config") + 1]
    ? process.argv[process.argv.indexOf("--config") + 1]
    : "mcp-hub.config.json",
);

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

      // Try StreamableHTTP first (/mcp style), fall back to SSE (/sse style).
      try {
        const streamable = new StreamableHTTPClientTransport(endpoint);
        // Validate connectivity by attempting connect on a temp client.
        const probe = new Client({ name: "mcp-hub/probe", version: "1.0.0" });
        await probe.connect(streamable);
        await probe.close();
        // Reconnect with a fresh transport for the real client.
        transport = new StreamableHTTPClientTransport(endpoint);
      } catch {
        transport = new SSEClientTransport(endpoint);
      }
    }

    const client = new Client({
      name: `mcp-hub/${state.config.id}`,
      version: "1.0.0",
    });

    await client.connect(transport);

    state.client = client;
    state.activeTransport = transport;
    state.status = "running";

    // Discover tools
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
