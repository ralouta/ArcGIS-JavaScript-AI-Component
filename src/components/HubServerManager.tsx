import React, { useCallback, useEffect, useRef, useState } from "react";

// ── Types (matches hub REST API responses) ────────────────────────────────────

export interface HubServer {
  id: string;
  label: string;
  transport: "stdio" | "url" | string;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  enabled: boolean;
  status: "stopped" | "starting" | "running" | "error";
  error: string | null;
  toolCount: number;
  tools: string[];
}

interface EnvEntry {
  key: string;
  value: string;
}

interface DraftServer {
  transport: "stdio" | "url";
  label: string;
  url: string;
  command: string;
  argsText: string;
  envEntries: EnvEntry[];
  cwd: string;
}

interface DesktopServerSnippet {
  command?: string;
  args?: unknown[];
  env?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  transportType?: "stdio";
  cwd?: string;
}

// ── Hub API helpers ───────────────────────────────────────────────────────────

const HUB_API = "/api/mcp";

async function fetchServers(): Promise<HubServer[]> {
  const res = await fetch(`${HUB_API}/servers`);
  if (!res.ok) throw new Error(`Hub returned ${res.status}`);
  const data = await res.json();
  return data.servers ?? [];
}

async function apiAddServer(body: Record<string, unknown>): Promise<HubServer> {
  const res = await fetch(`${HUB_API}/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Add failed: ${res.status}`);
  return res.json();
}

async function apiUpdateServer(
  id: string,
  body: Record<string, unknown>,
): Promise<HubServer> {
  const res = await fetch(
    `${HUB_API}/servers/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  return res.json();
}

async function apiDeleteServer(id: string): Promise<void> {
  const res = await fetch(
    `${HUB_API}/servers/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

async function apiStartServer(id: string): Promise<HubServer> {
  const res = await fetch(
    `${HUB_API}/servers/${encodeURIComponent(id)}/start`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Start failed: ${res.status}`);
  return res.json();
}

async function apiStopServer(id: string): Promise<HubServer> {
  const res = await fetch(
    `${HUB_API}/servers/${encodeURIComponent(id)}/stop`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Stop failed: ${res.status}`);
  return res.json();
}

// ── Arg / env helpers ─────────────────────────────────────────────────────────

function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of text) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
        continue;
      }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function argsToText(args: string[]): string {
  return args
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");
}

function envToEntries(env: Record<string, string>): EnvEntry[] {
  const entries = Object.entries(env).map(([key, value]) => ({
    key,
    value,
  }));
  return entries.length ? entries : [{ key: "", value: "" }];
}

function entriesToEnv(entries: EnvEntry[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const e of entries) {
    const k = e.key.trim();
    if (k) env[k] = e.value;
  }
  return env;
}

function emptyDraft(): DraftServer {
  return {
    transport: "stdio",
    label: "",
    url: "",
    command: "",
    argsText: "",
    envEntries: [{ key: "", value: "" }],
    cwd: "",
  };
}

function serverToDraft(s: HubServer): DraftServer {
  return {
    transport: s.transport === "url" ? "url" : "stdio",
    label: s.label,
    url: s.url ?? "",
    command: s.command ?? "",
    argsText: argsToText(s.args),
    envEntries: envToEntries(s.env),
    cwd: s.cwd ?? "",
  };
}

function draftToPayload(draft: DraftServer, enabled: boolean) {
  if (draft.transport === "url") {
    return {
      label: draft.label.trim() || "Untitled",
      transport: "url",
      url: draft.url.trim(),
      enabled,
    };
  }
  return {
    label: draft.label.trim() || "Untitled",
    transport: "stdio",
    enabled,
    command: draft.command.trim(),
    args: parseArgs(draft.argsText),
    env: entriesToEnv(draft.envEntries),
    cwd: draft.cwd.trim() || undefined,
  };
}

function isDraftValid(draft: DraftServer): boolean {
  if (draft.transport === "url") return !!draft.url.trim();
  return !!draft.command.trim();
}

function parseImportedServers(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();

  const tryParse = (raw: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // 1) Full JSON object
  // 2) Object with trailing comma
  // 3) Bare entry fragment: "mcp-newsapi": { ... }
  const parsed =
    tryParse(trimmed) ||
    tryParse(trimmed.replace(/,\s*$/, "")) ||
    tryParse(`{${trimmed.replace(/,\s*$/, "")}}`);

  if (!parsed) {
    throw new Error(
      "Invalid JSON. Paste either a full object, an mcpServers object, or a single named entry like \"mcp-newsapi\": { ... }.",
    );
  }

  const toPayload = (
    label: string,
    cfg: DesktopServerSnippet,
  ): Record<string, unknown> => {
    const env =
      cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
        ? cfg.env
        : cfg.environment &&
            typeof cfg.environment === "object" &&
            !Array.isArray(cfg.environment)
          ? cfg.environment
          : {};

    return {
      label,
      transport: "stdio",
      command: cfg.command ?? "",
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, String(v ?? "")]),
      ),
      cwd: cfg.cwd,
      enabled: true,
    };
  };

  const mcpServers = parsed.mcpServers;
  if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
    return Object.entries(mcpServers as Record<string, DesktopServerSnippet>).map(
      ([name, cfg]) => toPayload(name, cfg ?? {}),
    );
  }

  // Allow pasting a bare server map without the mcpServers wrapper.
  const isServerMap = Object.values(parsed).every(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ("command" in (value as Record<string, unknown>) ||
        "transportType" in (value as Record<string, unknown>)),
  );

  if (isServerMap) {
    return Object.entries(parsed as Record<string, DesktopServerSnippet>).map(
      ([name, cfg]) => toPayload(name, cfg ?? {}),
    );
  }

  // Also allow pasting a single server object directly.
  return [toPayload("Imported MCP", parsed as unknown as DesktopServerSnippet)];
}

// ── Styles ────────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: "1px solid #d9d9d9",
  borderRadius: "8px",
  padding: "0.85rem",
  display: "grid",
  gap: "0.5rem",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};

const labelTextStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "#3c3c3c",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.7rem",
  borderRadius: "4px",
  border: "1px solid #c7c7c7",
  fontSize: "0.92rem",
  boxSizing: "border-box",
};

const envRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.35rem",
  alignItems: "center",
  marginBottom: "0.25rem",
};

function statusDot(color: string): React.CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    backgroundColor: color,
    display: "inline-block",
    flexShrink: 0,
  };
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "#2da838";
    case "starting":
      return "#e4a822";
    case "error":
      return "#d83020";
    default:
      return "#999";
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function HubServerManager({ open, onClose }: Props) {
  const [servers, setServers] = useState<HubServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [draft, setDraft] = useState<DraftServer>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  // Imperative dialog control — avoids Calcite's attributeChangedCallback
  // desync where setting open=true after a React-driven close is silently ignored.
  const dialogRef = useRef<HTMLElement | null>(null);
  // Keep a ref to onClose so the native listener never goes stale.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = dialogRef.current as any;
    if (!el) return;
    el.open = open;
  }, [open]);

  useEffect(() => {
    const el = dialogRef.current as any;
    if (!el) return;
    const handler = () => { onCloseRef.current(); };
    el.addEventListener("calciteDialogClose", handler);
    return () => { el.removeEventListener("calciteDialogClose", handler); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setHubError(null);
    try {
      setServers(await fetchServers());
    } catch (err: any) {
      setHubError(
        err?.message ?? "Cannot reach MCP Hub. Is it running?",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setEditingId(null);
      setAddingNew(false);
      void load();
    }
  }, [open, load]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const handleToggle = async (server: HubServer) => {
    setBusy(true);
    try {
      const updated = server.enabled
        ? await apiStopServer(server.id)
        : await apiStartServer(server.id);
      setServers((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s)),
      );
    } catch {}
    setBusy(false);
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      await apiDeleteServer(id);
      setServers((prev) => prev.filter((s) => s.id !== id));
    } catch {}
    setBusy(false);
  };

  const startEdit = (server: HubServer) => {
    setEditingId(server.id);
    setDraft(serverToDraft(server));
    setAddingNew(false);
  };

  const startAdd = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setAddingNew(true);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setAddingNew(false);
  };

  const saveEdit = async () => {
    if (!isDraftValid(draft)) return;
    setBusy(true);
    try {
      if (addingNew) {
        const created = await apiAddServer(draftToPayload(draft, true));
        setServers((prev) => [...prev, created]);
      } else if (editingId) {
        const server = servers.find((s) => s.id === editingId);
        const updated = await apiUpdateServer(
          editingId,
          draftToPayload(draft, server?.enabled ?? true),
        );
        setServers((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s)),
        );
      }
      cancelEdit();
    } catch {}
    setBusy(false);
  };

  const importServers = async () => {
    if (!importText.trim()) return;

    setBusy(true);
    setImportError(null);
    try {
      const payloads = parseImportedServers(importText);
      for (const payload of payloads) {
        await apiAddServer(payload);
      }
      setImportText("");
      await load();
    } catch (err: any) {
      setImportError(
        err?.message ??
          "Import failed. Paste valid JSON in desktop MCP config format.",
      );
    }
    setBusy(false);
  };

  // ── Draft helpers ───────────────────────────────────────────────────────

  const updateDraft = (field: keyof DraftServer, value: unknown) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const updateEnvEntry = (
    index: number,
    field: "key" | "value",
    val: string,
  ) => {
    setDraft((prev) => {
      const next = [...prev.envEntries];
      next[index] = { ...next[index], [field]: val };
      return { ...prev, envEntries: next };
    });
  };

  const addEnvEntry = () =>
    setDraft((prev) => ({
      ...prev,
      envEntries: [...prev.envEntries, { key: "", value: "" }],
    }));

  const removeEnvEntry = (index: number) =>
    setDraft((prev) => ({
      ...prev,
      envEntries:
        prev.envEntries.length > 1
          ? prev.envEntries.filter((_, i) => i !== index)
          : [{ key: "", value: "" }],
    }));

  // ── Render ──────────────────────────────────────────────────────────────

  const renderForm = () => (
    <div style={{ ...cardStyle, borderColor: "#007ac2" }}>
      <div style={{ ...labelTextStyle, marginBottom: "0.25rem" }}>
        {addingNew ? "Add MCP server" : "Edit MCP server"}
      </div>

      {/* Transport type selector */}
      <div>
        <div style={{ ...labelTextStyle, fontSize: "0.85rem", marginBottom: "0.35rem" }}>
          Type
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {(["stdio", "url"] as const).map((t) => (
            <button
              key={t}
              onClick={() => updateDraft("transport", t)}
              style={{
                padding: "0.3rem 0.8rem",
                borderRadius: "4px",
                border: draft.transport === t ? "2px solid #007ac2" : "1px solid #c7c7c7",
                background: draft.transport === t ? "#e8f4fc" : "#fff",
                color: draft.transport === t ? "#007ac2" : "#3c3c3c",
                fontWeight: draft.transport === t ? 600 : 400,
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              {t === "stdio" ? "Command (stdio)" : "HTTP URL"}
            </button>
          ))}
        </div>
      </div>

      <label>
        <div
          style={{
            ...labelTextStyle,
            fontSize: "0.85rem",
            marginBottom: "0.2rem",
          }}
        >
          Label
        </div>
        <input
          style={inputStyle}
          value={draft.label}
          onChange={(e) => updateDraft("label", e.target.value)}
          placeholder="e.g. Weather, News API"
        />
      </label>

      {draft.transport === "url" ? (
        <>
          <div style={{ fontSize: "0.75rem", color: "#6a6a6a" }}>
            Connect directly to a running streamable HTTP or SSE MCP server.
          </div>
          <label>
            <div style={{ ...labelTextStyle, fontSize: "0.85rem", marginBottom: "0.2rem" }}>
              Server URL
            </div>
            <input
              style={inputStyle}
              value={draft.url}
              onChange={(e) => updateDraft("url", e.target.value)}
              placeholder="https://example.com/mcp"
              type="url"
            />
            <div style={{ fontSize: "0.75rem", color: "#6a6a6a", marginTop: "0.15rem" }}>
              Streamable HTTP is tried first; falls back to SSE automatically.
            </div>
          </label>
        </>
      ) : (
        <>
          <div
            style={{
              fontSize: "0.75rem",
              color: "#6a6a6a",
            }}
          >
            Run any MCP server through a command (npx, node, python, uvx, etc.).
          </div>

          <label>
            <div
              style={{
                ...labelTextStyle,
                fontSize: "0.85rem",
                marginBottom: "0.2rem",
              }}
            >
              Command
            </div>
            <input
              style={inputStyle}
              value={draft.command}
              onChange={(e) => updateDraft("command", e.target.value)}
              placeholder="e.g. npx, node, python"
            />
          </label>

          <label>
            <div
              style={{
                ...labelTextStyle,
                fontSize: "0.85rem",
                marginBottom: "0.2rem",
              }}
            >
              Arguments
            </div>
            <input
              style={inputStyle}
              value={draft.argsText}
              onChange={(e) =>
                updateDraft("argsText", e.target.value)
              }
              placeholder="e.g. mcp-remote https://example.com/mcp"
            />
            <div
              style={{
                fontSize: "0.75rem",
                color: "#6a6a6a",
                marginTop: "0.15rem",
              }}
            >
              Space-separated. Use quotes for arguments with spaces.
            </div>
          </label>

          <div>
            <div
              style={{
                ...labelTextStyle,
                fontSize: "0.85rem",
                marginBottom: "0.25rem",
              }}
            >
              Environment Variables
            </div>
            {draft.envEntries.map((entry, i) => (
              <div key={i} style={envRowStyle}>
                <input
                  style={{ ...inputStyle, width: "40%" }}
                  value={entry.key}
                  onChange={(e) =>
                    updateEnvEntry(i, "key", e.target.value)
                  }
                  placeholder="KEY"
                />
                <input
                  style={{ ...inputStyle, width: "55%" }}
                  value={entry.value}
                  onChange={(e) =>
                    updateEnvEntry(i, "value", e.target.value)
                  }
                  placeholder="value"
                />
                <calcite-button
                  appearance="transparent"
                  kind="neutral"
                  icon-start="minus"
                  scale="s"
                  onClick={() => removeEnvEntry(i)}
                />
              </div>
            ))}
            <calcite-button
              appearance="transparent"
              kind="neutral"
              icon-start="plus"
              scale="s"
              onClick={addEnvEntry}
            >
              Add variable
            </calcite-button>
          </div>

          <label>
            <div
              style={{
                ...labelTextStyle,
                fontSize: "0.85rem",
                marginBottom: "0.2rem",
              }}
            >
              Working Directory{" "}
              <span style={{ fontWeight: 400, color: "#6a6a6a" }}>
                (optional)
              </span>
            </div>
            <input
              style={inputStyle}
              value={draft.cwd}
              onChange={(e) => updateDraft("cwd", e.target.value)}
              placeholder="/path/to/project"
            />
          </label>
        </>
      )}

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          justifyContent: "flex-end",
          marginTop: "0.25rem",
        }}
      >
        <calcite-button
          appearance="outline"
          kind="neutral"
          scale="s"
          onClick={cancelEdit}
        >
          Cancel
        </calcite-button>
        <calcite-button
          appearance="solid"
          kind="brand"
          scale="s"
          onClick={saveEdit}
          disabled={busy || !isDraftValid(draft) || undefined}
        >
          Save
        </calcite-button>
      </div>
    </div>
  );

  return (
    <calcite-dialog
      ref={dialogRef as any}
      overlay-positioning="fixed"
      heading="Manage MCP Servers"
      widthScale="m"
    >
      <div
        style={{ padding: "0.75rem 0", display: "grid", gap: "0.75rem" }}
      >
        {hubError ? (
          <div style={{ color: "#d83020", lineHeight: 1.5 }}>
            <strong>Cannot connect to MCP Hub.</strong> Start it with{" "}
            <code
              style={{
                background: "#f0f0f0",
                padding: "0.15rem 0.4rem",
                borderRadius: "3px",
              }}
            >
              npm run hub
            </code>
            , then reopen this dialog.
            <br />
            <span style={{ fontSize: "0.85rem" }}>{hubError}</span>
          </div>
        ) : loading ? (
          <div
            style={{
              color: "#4a4a4a",
              padding: "1rem 0",
              textAlign: "center",
            }}
          >
            Loading…
          </div>
        ) : (
          <>
            <div style={{ color: "#4a4a4a", lineHeight: 1.5 }}>
              Configure MCP servers as command-based stdio processes.
              Use any launcher pattern (for example, <code>npx mcp-remote ...</code>, <code>node dist/index.js</code>, <code>uvx ...</code>).
              The hub aggregates all enabled servers into one endpoint.
            </div>

            <div style={cardStyle}>
              <div style={labelTextStyle}>Import Desktop MCP JSON</div>
              <div style={{ fontSize: "0.82rem", color: "#666" }}>
                Paste a snippet using <code>mcpServers</code>, <code>command</code>, <code>args</code>, <code>env</code> or <code>environment</code>.
              </div>
              <textarea
                style={{
                  ...inputStyle,
                  minHeight: "95px",
                  fontFamily: "monospace",
                  resize: "vertical",
                }}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='{"mcpServers":{"my-server":{"command":"npx","args":["-y","my-mcp-package@latest"]}}}'
              />
              {importError && (
                <div style={{ color: "#d83020", fontSize: "0.82rem" }}>
                  {importError}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <calcite-button
                  appearance="outline"
                  kind="neutral"
                  scale="s"
                  onClick={importServers}
                  disabled={busy || !importText.trim() || undefined}
                >
                  Import json
                </calcite-button>
              </div>
            </div>

            {servers.map((server) =>
              editingId === server.id ? (
                <React.Fragment key={server.id}>
                  {renderForm()}
                </React.Fragment>
              ) : (
                <div key={server.id} style={cardStyle}>
                  <div style={headerRowStyle}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <span
                        style={statusDot(
                          statusColor(server.status),
                        )}
                        title={server.status}
                      />
                      <span style={labelTextStyle}>
                        {server.label}
                      </span>
                      <span
                        style={{
                          fontSize: "0.8rem",
                          color: "#6a6a6a",
                        }}
                      >
                        {server.status === "running"
                          ? `${server.toolCount} tool${server.toolCount !== 1 ? "s" : ""}`
                          : server.status}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "0.25rem" }}>
                      <calcite-button
                        appearance="transparent"
                        kind="neutral"
                        icon-start="pencil"
                        scale="s"
                        onClick={() => startEdit(server)}
                        title="Edit"
                      />
                      <calcite-button
                        appearance="transparent"
                        kind={
                          server.enabled ? "brand" : "neutral"
                        }
                        icon-start={
                          server.enabled
                            ? "check-circle"
                            : "circle"
                        }
                        scale="s"
                        onClick={() => handleToggle(server)}
                        title={
                          server.enabled ? "Disable" : "Enable"
                        }
                        disabled={busy || undefined}
                      />
                      <calcite-button
                        appearance="transparent"
                        kind="danger"
                        icon-start="trash"
                        scale="s"
                        onClick={() => handleDelete(server.id)}
                        title="Remove"
                        disabled={busy || undefined}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: "0.85rem",
                      color: "#555",
                      fontFamily: "monospace",
                    }}
                  >
                    {server.transport === "url"
                      ? server.url ?? ""
                      : `${server.command} ${server.args.join(" ")}`}
                  </div>
                    {Object.keys(server.env).length > 0 && (
                    <div
                      style={{ fontSize: "0.8rem", color: "#777" }}
                    >
                      env: {Object.keys(server.env).join(", ")}
                    </div>
                  )}
                  {server.error && (
                    <div
                      style={{
                        fontSize: "0.82rem",
                        color: "#d83020",
                      }}
                    >
                      {server.error}
                    </div>
                  )}
                </div>
              ),
            )}

            {addingNew ? (
              renderForm()
            ) : (
              <div>
                <calcite-button
                  appearance="outline"
                  kind="neutral"
                  icon-start="plus"
                  onClick={startAdd}
                >
                  Add MCP server
                </calcite-button>
              </div>
            )}
          </>
        )}
      </div>

      <calcite-button
        slot="footer-end"
        appearance="solid"
        kind="brand"
        onClick={onClose}
      >
        Done
      </calcite-button>
    </calcite-dialog>
  );
}
