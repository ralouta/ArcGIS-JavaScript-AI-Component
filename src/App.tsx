import React, { useCallback, useEffect, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import IdentityManager from "@arcgis/core/identity/IdentityManager";
import mcpServerIcon from "../mcpicon.png";
import { registerArcgisMcpPassthroughAgent } from "./agents/ArcgisMcpPassthroughAgent";
import { registerCreateFeatureLayerAgent } from "./agents/CreateFeatureLayerAgent";
import { registerFeatureLayerCapabilitiesAgent } from "./agents/AllCapabilitiesAgent";
import { getArcgisMcpHealth, resolveArcgisMcpBaseUrl } from "./utils/arcgisMcp";
import {
  generateAndSaveWebMapEmbeddings,
  getCredential,
  getWebMapEmbeddingsStatus,
  initializeOAuth,
} from "./utils/arcgisOnline";

const centeredScreenStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  backgroundColor: "#f8f8f8",
};

const signInPanelStyle: React.CSSProperties = { width: "340px", maxWidth: "90vw" };
const mapPickerPanelStyle: React.CSSProperties = { width: "420px" };
const panelBodyStyle: React.CSSProperties = { padding: "1.5rem" };
const centeredRowStyle: React.CSSProperties = { display: "flex", justifyContent: "center" };
const webMapInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  borderRadius: "4px",
  border: "1px solid #c7c7c7",
  fontSize: "1rem",
};
const dialogBodyStyle: React.CSSProperties = { padding: "0.75rem 0", display: "grid", gap: "0.85rem" };
const mcpServerCardStyle: React.CSSProperties = {
  border: "1px solid #d9d9d9",
  borderRadius: "8px",
  padding: "0.85rem",
  display: "grid",
  gap: "0.65rem",
};
const mcpServerHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};
const mcpServerRadioLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontWeight: 600,
  color: "#3c3c3c",
};
const secondaryInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.7rem",
  borderRadius: "4px",
  border: "1px solid #c7c7c7",
  fontSize: "0.95rem",
};
const headerActionButtonScale = "l" as const;
const headerActionsContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const headerActionIconsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.375rem",
};
const headerActionMenuStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginLeft: "0.125rem",
};
const mcpIconStyle: React.CSSProperties = {
  width: "18px",
  height: "18px",
  display: "block",
  backgroundColor: "#007ac2",
  WebkitMaskImage: `url(${mcpServerIcon})`,
  maskImage: `url(${mcpServerIcon})`,
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskSize: "contain",
  maskSize: "contain",
};

interface McpServerConfig {
  id: string;
  label: string;
  url: string;
}

interface McpServerHealthState {
  status: "checking" | "ok" | "error";
  message: string;
}

const MCP_SERVER_STORAGE_KEY = "arcgis-assistant-mcp-servers";
const ACTIVE_MCP_SERVER_STORAGE_KEY = "arcgis-assistant-active-mcp-server";
const ASSISTANT_USER_BUBBLE_STYLE_ID = "assistant-user-bubble-wrap-style";
const ASSISTANT_USER_BUBBLE_CSS = `
.assistant-chat-card__prompt-container {
  max-width: min(100%, 34rem) !important;
  width: auto !important;
  box-sizing: border-box;
  align-items: flex-start;
}

.assistant-chat-card__prompt-container > div:first-child {
  min-width: 0;
  white-space: normal !important;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.45;
}
`;

function createMcpServerId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createMcpServerConfig(url: string, label: string): McpServerConfig {
  return {
    id: createMcpServerId(),
    label,
    url,
  };
}

function getDefaultMcpServerConfig(defaultUrl: string): McpServerConfig {
  return {
    id: "default-mcp-server",
    label: "Default MCP server",
    url: defaultUrl,
  };
}

function sanitizeMcpServers(servers: McpServerConfig[], defaultUrl: string): McpServerConfig[] {
  const sanitized = servers
    .map((server) => ({
      ...server,
      label: server.label.trim(),
      url: server.url.trim(),
    }))
    .filter((server) => server.url);

  return sanitized.length ? sanitized : [getDefaultMcpServerConfig(defaultUrl)];
}

function loadMcpServerConfig(defaultUrl: string): {
  servers: McpServerConfig[];
  activeServerId: string;
} {
  if (typeof window === "undefined") {
    const fallback = getDefaultMcpServerConfig(defaultUrl);
    return { servers: [fallback], activeServerId: fallback.id };
  }

  try {
    const rawServers = window.localStorage.getItem(MCP_SERVER_STORAGE_KEY);
    const rawActiveServerId = window.localStorage.getItem(ACTIVE_MCP_SERVER_STORAGE_KEY);
    const parsedServers = rawServers ? (JSON.parse(rawServers) as McpServerConfig[]) : [];
    const servers = sanitizeMcpServers(parsedServers, defaultUrl);
    const activeServerId =
      rawActiveServerId && servers.some((server) => server.id === rawActiveServerId)
        ? rawActiveServerId
        : servers[0].id;

    return { servers, activeServerId };
  } catch {
    const fallback = getDefaultMcpServerConfig(defaultUrl);
    return { servers: [fallback], activeServerId: fallback.id };
  }
}

function getMcpStatusPresentation(health?: McpServerHealthState): { color: string; text: string } {
  if (!health) {
    return { color: "#6b6b6b", text: "Not checked yet." };
  }

  if (health.status === "ok") {
    return { color: "#2d6a4f", text: health.message };
  }

  if (health.status === "checking") {
    return { color: "#6b6b6b", text: health.message };
  }

  return { color: "#8a1f11", text: health.message };
}

function ensureAssistantUserBubbleStyle(cardElement: Element): void {
  const shadowRoot = (cardElement as HTMLElement).shadowRoot;
  if (!shadowRoot || shadowRoot.getElementById(ASSISTANT_USER_BUBBLE_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = ASSISTANT_USER_BUBBLE_STYLE_ID;
  style.textContent = ASSISTANT_USER_BUBBLE_CSS;
  shadowRoot.appendChild(style);
}

function installAssistantUserBubbleStyler(assistant: HTMLElement): () => void {
  const observer = new MutationObserver(() => {
    scanTree(assistant);
    if (assistant.shadowRoot) {
      scanTree(assistant.shadowRoot);
    }
  });
  const observedRoots = new WeakSet<Node>();

  function observeRoot(root: Element | ShadowRoot): void {
    if (observedRoots.has(root)) {
      return;
    }

    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });

    root.querySelectorAll("*").forEach((node) => {
      const shadowRoot = (node as HTMLElement).shadowRoot;
      if (shadowRoot) {
        observeRoot(shadowRoot);
      }
    });
  }

  function scanTree(root: Element | ShadowRoot): void {
    if (root instanceof Element && root.matches("arcgis-assistant-chat-card")) {
      ensureAssistantUserBubbleStyle(root);
    }

    root.querySelectorAll("arcgis-assistant-chat-card").forEach((card) => {
      ensureAssistantUserBubbleStyle(card);
    });

    root.querySelectorAll("*").forEach((node) => {
      const shadowRoot = (node as HTMLElement).shadowRoot;
      if (shadowRoot) {
        observeRoot(shadowRoot);
        scanTree(shadowRoot);
      }
    });
  }

  observeRoot(assistant);
  scanTree(assistant);

  if (assistant.shadowRoot) {
    observeRoot(assistant.shadowRoot);
    scanTree(assistant.shadowRoot);
  }

  return () => {
    observer.disconnect();
  };
}

export default function App() {
  const appName = (import.meta.env.VITE_APP_NAME as string | undefined)?.trim() || "ArcGIS Assistant Demo";
  const portalUrl = (import.meta.env.VITE_ARCGIS_PORTAL_URL as string | undefined)?.trim() || "https://www.arcgis.com";
  const oauthClientId = (import.meta.env.VITE_ARCGIS_OAUTH_APP_ID as string | undefined)?.trim();
  const defaultMcpBaseUrl = resolveArcgisMcpBaseUrl();
  const [webMapId, setWebMapId] = useState<string>("");
  const [inputWebMapId, setInputWebMapId] = useState("");
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showMcpConfigDialog, setShowMcpConfigDialog] = useState(false);
  const [isEmbeddingBusy, setIsEmbeddingBusy] = useState(false);
  const [embeddingsStatusMessage, setEmbeddingsStatusMessage] = useState<string | null>(null);
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => loadMcpServerConfig(defaultMcpBaseUrl).servers);
  const [activeMcpServerId, setActiveMcpServerId] = useState<string>(
    () => loadMcpServerConfig(defaultMcpBaseUrl).activeServerId
  );
  const [draftMcpServers, setDraftMcpServers] = useState<McpServerConfig[]>([]);
  const [draftActiveMcpServerId, setDraftActiveMcpServerId] = useState<string>("");
  const [mcpHealthByServerId, setMcpHealthByServerId] = useState<Record<string, McpServerHealthState>>({});
  const autoCheckedMapIdRef = useRef<string | null>(null);
  const activeMcpServer = mcpServers.find((server) => server.id === activeMcpServerId) || mcpServers[0];
  const arcgisMcpBaseUrl = activeMcpServer?.url || defaultMcpBaseUrl;
  const activeMcpHealth = activeMcpServer ? mcpHealthByServerId[activeMcpServer.id] : undefined;
  const mcpError = activeMcpHealth?.status === "error" ? activeMcpHealth.message : null;

  useEffect(() => {
    if (!webMapId) return;

    const assistant = document.querySelector("arcgis-assistant") as HTMLElement | null;
    if (!assistant) return;

    registerCreateFeatureLayerAgent(assistant, {
      oauthClientId,
      portalUrl,
      layerName: "Locations",
      geometryType: "esriGeometryPoint",
      llmSystemPrompt:
        "You are a strict information extraction assistant. Extract the requested feature layer details from the user text and return only valid JSON. Schema: {\"name\": string|null, \"geometryType\": \"point\"|\"polyline\"|\"polygon\"|null, \"fields\": [{\"name\": string, \"type\": string}]|null}. Do not include any extra keys or commentary.",
    });
    registerFeatureLayerCapabilitiesAgent(assistant);
    registerArcgisMcpPassthroughAgent(assistant, {
      baseUrl: arcgisMcpBaseUrl,
    });
  }, [arcgisMcpBaseUrl, oauthClientId, portalUrl, webMapId]);

  useEffect(() => {
    if (!webMapId) return;

    const assistant = document.querySelector("arcgis-assistant") as HTMLElement | null;
    if (!assistant) return;

    return installAssistantUserBubbleStyler(assistant);
  }, [webMapId]);

  useEffect(() => {
    if (!mcpServers.length) {
      setMcpHealthByServerId({});
      return;
    }

    let cancelled = false;

    setMcpHealthByServerId((current) => {
      const next: Record<string, McpServerHealthState> = {};
      for (const server of mcpServers) {
        next[server.id] = {
          status: "checking",
          message: current[server.id]?.status === "ok" ? current[server.id].message : "Checking MCP server...",
        };
      }
      return next;
    });

    void Promise.all(
      mcpServers.map(async (server) => {
        try {
          const health = await getArcgisMcpHealth(server.url);
          if (cancelled) return;
          const summary = typeof health.status === "string" ? health.status : "connected";
          setMcpHealthByServerId((current) => ({
            ...current,
            [server.id]: {
              status: "ok",
              message: `Connection ok: ${summary}`,
            },
          }));
        } catch (error: any) {
          if (cancelled) return;
          setMcpHealthByServerId((current) => ({
            ...current,
            [server.id]: {
              status: "error",
              message: error?.message || "Unable to reach this MCP server.",
            },
          }));
        }
      })
    );

    return () => {
      cancelled = true;
    };
  }, [mcpServers]);

  useEffect(() => {
    if (!mcpServers.some((server) => server.id === activeMcpServerId)) {
      setActiveMcpServerId(mcpServers[0]?.id || "");
    }
  }, [activeMcpServerId, mcpServers]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MCP_SERVER_STORAGE_KEY, JSON.stringify(mcpServers));
    window.localStorage.setItem(ACTIVE_MCP_SERVER_STORAGE_KEY, activeMcpServerId);
  }, [activeMcpServerId, mcpServers]);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  useEffect(() => {
    esriConfig.portalUrl = portalUrl;
    initializeOAuth(oauthClientId, portalUrl);
    const sharingUrl = `${portalUrl}/sharing/rest`;
    void IdentityManager.checkSignInStatus(sharingUrl)
      .then((cred) => {
        setIsSignedIn(true);
        setCurrentUser(cred?.userId ?? null);
      })
      .catch(() => {
        setIsSignedIn(false);
        setCurrentUser(null);
      });
  }, [oauthClientId, portalUrl]);

  const handleSignIn = async () => {
    setAuthError(null);
    setIsSigningIn(true);
    try {
      const cred = await getCredential(oauthClientId, portalUrl);
      setIsSignedIn(true);
      setCurrentUser(cred.username);
    } catch (error: any) {
      setAuthError(error?.message || "Sign in failed.");
      setIsSignedIn(false);
      setCurrentUser(null);
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleLoadMap = () => {
    if (!inputWebMapId.trim()) return;
    setWebMapId(inputWebMapId.trim());
    setEmbeddingsStatusMessage(null);
    setEmbeddingsError(null);
    autoCheckedMapIdRef.current = null;
  };

  const handleSignOut = () => {
    IdentityManager.destroyCredentials();
    setIsSignedIn(false);
    setCurrentUser(null);
    setWebMapId("");
    setInputWebMapId("");
    setAuthError(null);
    setEmbeddingsStatusMessage(null);
    setEmbeddingsError(null);
    autoCheckedMapIdRef.current = null;
    setShowSignOutConfirm(false);
  };

  const openMcpConfig = () => {
    setDraftMcpServers(mcpServers.map((server) => ({ ...server })));
    setDraftActiveMcpServerId(activeMcpServerId);
    setShowMcpConfigDialog(true);
  };

  const handleAddMcpServer = () => {
    const nextServer = createMcpServerConfig("", `MCP server ${draftMcpServers.length + 1}`);
    setDraftMcpServers((current) => [...current, nextServer]);
    setDraftActiveMcpServerId((current) => current || nextServer.id);
  };

  const handleDraftMcpServerChange = (serverId: string, field: "label" | "url", value: string) => {
    setDraftMcpServers((current) =>
      current.map((server) => (server.id === serverId ? { ...server, [field]: value } : server))
    );
  };

  const handleRemoveDraftMcpServer = (serverId: string) => {
    setDraftMcpServers((current) => {
      const next = current.filter((server) => server.id !== serverId);
      if (!next.length) {
        const fallback = getDefaultMcpServerConfig(defaultMcpBaseUrl);
        setDraftActiveMcpServerId(fallback.id);
        return [fallback];
      }
      if (draftActiveMcpServerId === serverId) {
        setDraftActiveMcpServerId(next[0].id);
      }
      return next;
    });
  };

  const handleSaveMcpConfig = () => {
    const nextServers = sanitizeMcpServers(draftMcpServers, defaultMcpBaseUrl);
    const nextActiveServerId =
      nextServers.some((server) => server.id === draftActiveMcpServerId)
        ? draftActiveMcpServerId
        : nextServers[0].id;

    setMcpServers(nextServers);
    setActiveMcpServerId(nextActiveServerId);
    setShowMcpConfigDialog(false);
  };

  const renderAccountMenu = () => (
    <calcite-dropdown placement="bottom-end" type="click" scale="m">
      <calcite-button slot="trigger" appearance="transparent" icon-start="user" scale="m">
        {currentUser || "ArcGIS user"}
      </calcite-button>
      <calcite-dropdown-group group-title="Account" selection-mode="none">
        <calcite-dropdown-item icon-start="sign-out" onClick={() => setShowSignOutConfirm(true)}>
          Sign out
        </calcite-dropdown-item>
      </calcite-dropdown-group>
    </calcite-dropdown>
  );

  const ensureWebMapEmbeddings = useCallback(
    async (forceRegenerate = false) => {
      if (!webMapId) return;

      setEmbeddingsError(null);
      setIsEmbeddingBusy(true);

      try {
        const cred = await getCredential(oauthClientId, portalUrl);

        if (!forceRegenerate) {
          setEmbeddingsStatusMessage("Checking WebMap embeddings...");
          const status = await getWebMapEmbeddingsStatus(portalUrl, cred.token, webMapId);
          if (status.exists) {
            setEmbeddingsStatusMessage("Embeddings are ready for this WebMap.");
            autoCheckedMapIdRef.current = webMapId;
            return;
          }
        }

        setEmbeddingsStatusMessage(
          forceRegenerate
            ? "Regenerating embeddings..."
            : "Embeddings not found. Generating embeddings..."
        );

        const result = await generateAndSaveWebMapEmbeddings({
          portalUrl,
          token: cred.token,
          webMapItemId: webMapId,
          removeExisting: true,
        });

        if (!result.success) {
          throw new Error(result.message || "Failed to generate embeddings.");
        }

        const layerCount = result.layerCount ?? 0;
        const fieldCount = result.fieldCount ?? 0;
        setEmbeddingsStatusMessage(`Embeddings saved (${layerCount} layers, ${fieldCount} fields).`);
        autoCheckedMapIdRef.current = webMapId;
      } catch (error: any) {
        const message = error?.message || "Embedding generation failed.";
        setEmbeddingsError(message);
        setEmbeddingsStatusMessage(null);
      } finally {
        setIsEmbeddingBusy(false);
      }
    },
    [oauthClientId, portalUrl, webMapId]
  );

  useEffect(() => {
    if (!isSignedIn || !webMapId) return;
    if (autoCheckedMapIdRef.current === webMapId) return;
    void ensureWebMapEmbeddings(false);
  }, [ensureWebMapEmbeddings, isSignedIn, webMapId]);

  const signInBlocked = isSigningIn || !oauthClientId;
  const loadMapBlocked = !inputWebMapId.trim();

  return (
    <calcite-shell style={{ height: "100vh" }}>
      {!isSignedIn ? (
        <div style={centeredScreenStyle}>
          <calcite-panel heading="Sign in to ArcGIS" style={signInPanelStyle}>
            <div style={{ ...panelBodyStyle, textAlign: "center" }}>
              <p style={{ marginTop: 0, marginBottom: "0.35rem", color: "#4a4a4a" }}>
                Sign in first, then you can provide the WebMap item ID.
              </p>
              <p style={{ marginTop: 0, marginBottom: "1rem", color: "#6b6b6b", fontSize: "0.9rem" }}>
                You will be redirected to the official ArcGIS sign-in page.
              </p>
              {!oauthClientId && (
                <p style={{ color: "#8a1f11", marginBottom: "0.75rem" }}>
                  Missing <code>VITE_ARCGIS_OAUTH_APP_ID</code>. Add it to <code>.env.local</code> and restart.
                  Optional for Enterprise: <code>VITE_ARCGIS_PORTAL_URL=https://your-enterprise-portal</code>.
                </p>
              )}
              {authError && <p style={{ color: "#8a1f11" }}>{authError}</p>}
              <div style={centeredRowStyle}>
                <calcite-button
                  appearance="solid"
                  kind="brand"
                  onClick={() => {
                    if (signInBlocked) {
                      if (!oauthClientId) {
                        setAuthError("Missing VITE_ARCGIS_OAUTH_APP_ID. Add it to .env.local and restart npm run dev.");
                      }
                      return;
                    }
                    void handleSignIn();
                  }}
                  style={{ minWidth: "180px" }}
                >
                  {isSigningIn ? "Signing in..." : "Sign in"}
                </calcite-button>
              </div>
            </div>
          </calcite-panel>
        </div>
      ) : !webMapId ? (
        <div style={centeredScreenStyle}>
          <calcite-panel heading="Load Web Map" style={mapPickerPanelStyle}>
            <div slot="header-actions-end">{renderAccountMenu()}</div>
            <div style={panelBodyStyle}>
              <calcite-label>
                Web Map ID
                <input
                  id="webmap-id-input"
                  value={inputWebMapId}
                  placeholder="Enter web map item ID"
                  onChange={(e) => setInputWebMapId(e.target.value)}
                  style={webMapInputStyle}
                />
              </calcite-label>
              <div style={{ marginTop: "1rem" }}>
                <calcite-button
                  appearance="solid"
                  kind="brand"
                  width="full"
                  onClick={() => {
                    if (loadMapBlocked) return;
                    handleLoadMap();
                  }}
                >
                  Load map
                </calcite-button>
              </div>
            </div>
          </calcite-panel>
        </div>
      ) : (
        <>
          <arcgis-map key={webMapId} id="main-map" item-id={webMapId}>
            <arcgis-zoom slot="top-left" />
            <arcgis-home slot="top-left" />
            <arcgis-expand slot="bottom-left" expand-icon="legend" collapse-icon="x" expanded>
              <arcgis-legend />
            </arcgis-expand>
          </arcgis-map>
          <calcite-shell-panel slot="panel-end" width="l" id="assistant-panel">
            <calcite-panel>
              <div slot="header-actions-end">
                <div style={headerActionsContainerStyle}>
                  <div style={headerActionIconsRowStyle}>
                    <calcite-button
                      appearance="transparent"
                      icon-start="map"
                      scale={headerActionButtonScale}
                      onClick={() => {
                        setWebMapId("");
                        setEmbeddingsStatusMessage(null);
                        setEmbeddingsError(null);
                        autoCheckedMapIdRef.current = null;
                      }}
                      title="Change WebMap"
                    ></calcite-button>
                    <calcite-button
                      appearance="transparent"
                      icon-start="reset"
                      scale={headerActionButtonScale}
                      onClick={() => {
                        if (isEmbeddingBusy) return;
                        void ensureWebMapEmbeddings(true);
                      }}
                      title="Regenerate embeddings"
                    ></calcite-button>
                    <calcite-button
                      appearance="transparent"
                      scale={headerActionButtonScale}
                      onClick={openMcpConfig}
                      title="Configure MCP servers"
                    >
                      <span aria-hidden="true" style={mcpIconStyle}></span>
                    </calcite-button>
                  </div>
                  <div style={headerActionMenuStyle}>{renderAccountMenu()}</div>
                </div>
              </div>
              <arcgis-assistant
                reference-element="#main-map"
                heading={appName}
                description="Ask questions about the current web map, get data insights, or request geospatial analysis."
              >
                <arcgis-assistant-navigation-agent></arcgis-assistant-navigation-agent>
                <arcgis-assistant-data-exploration-agent></arcgis-assistant-data-exploration-agent>
                {/* Custom agent is appended programmatically via useEffect */}
              </arcgis-assistant>
              {(embeddingsStatusMessage || embeddingsError || mcpError) && (
                <div style={{ padding: "0.5rem 1rem 1rem", fontSize: "0.85rem" }}>
                  {embeddingsStatusMessage && (
                    <div style={{ color: "#4a4a4a" }}>
                      {embeddingsStatusMessage}
                    </div>
                  )}
                  {embeddingsError && (
                    <div style={{ color: "#8a1f11", marginTop: embeddingsStatusMessage ? "0.35rem" : 0 }}>
                      {embeddingsError}
                    </div>
                  )}
                  {mcpError && (
                    <div
                      style={{
                        color: "#8a1f11",
                        marginTop:
                          embeddingsStatusMessage || embeddingsError ? "0.35rem" : 0,
                      }}
                    >
                      {mcpError}
                    </div>
                  )}
                </div>
              )}
            </calcite-panel>
          </calcite-shell-panel>
        </>
      )}

      {showSignOutConfirm && (
        <calcite-dialog
          open
          heading="Sign out"
          onCalciteDialogClose={() => setShowSignOutConfirm(false)}
        >
          <div style={{ padding: "0.75rem 0" }}>
            Do you want to sign out of this app session?
          </div>
          <calcite-button
            slot="footer-start"
            appearance="outline"
            kind="neutral"
            onClick={() => setShowSignOutConfirm(false)}
          >
            Cancel
          </calcite-button>
          <calcite-button
            slot="footer-end"
            appearance="solid"
            kind="danger"
            onClick={handleSignOut}
          >
            Sign out
          </calcite-button>
        </calcite-dialog>
      )}

      {showMcpConfigDialog && (
        <calcite-dialog
          open
          heading="Configure MCP servers"
          onCalciteDialogClose={() => setShowMcpConfigDialog(false)}
        >
          <div style={dialogBodyStyle}>
            <div style={{ color: "#4a4a4a", lineHeight: 1.5 }}>
              Add one or more MCP servers here. The assistant uses the selected active server, while the others remain saved for quick switching.
            </div>

            {draftMcpServers.map((server, index) => {
              const status = getMcpStatusPresentation(mcpHealthByServerId[server.id]);

              return (
                <div key={server.id} style={mcpServerCardStyle}>
                  <div style={mcpServerHeaderStyle}>
                    <label style={mcpServerRadioLabelStyle}>
                      <input
                        type="radio"
                        name="active-mcp-server"
                        checked={draftActiveMcpServerId === server.id}
                        onChange={() => setDraftActiveMcpServerId(server.id)}
                      />
                      Active server
                    </label>
                    <calcite-button
                      appearance="transparent"
                      kind="neutral"
                      icon-start="trash"
                      scale="s"
                      onClick={() => handleRemoveDraftMcpServer(server.id)}
                      title="Remove MCP server"
                    ></calcite-button>
                  </div>

                  <label>
                    <div style={{ marginBottom: "0.35rem", color: "#3c3c3c", fontWeight: 600 }}>
                      Name
                    </div>
                    <input
                      value={server.label}
                      onChange={(event) => handleDraftMcpServerChange(server.id, "label", event.target.value)}
                      placeholder={`MCP server ${index + 1}`}
                      style={secondaryInputStyle}
                    />
                  </label>

                  <label>
                    <div style={{ marginBottom: "0.35rem", color: "#3c3c3c", fontWeight: 600 }}>
                      Base URL
                    </div>
                    <input
                      value={server.url}
                      onChange={(event) => handleDraftMcpServerChange(server.id, "url", event.target.value)}
                      placeholder="http://127.0.0.1:8000 or /api/arcgis-mcp"
                      style={secondaryInputStyle}
                    />
                  </label>

                  <div style={{ color: status.color, fontSize: "0.85rem" }}>
                    {status.text}
                  </div>
                </div>
              );
            })}

            <div>
              <calcite-button appearance="outline" kind="neutral" icon-start="plus" onClick={handleAddMcpServer}>
                Add MCP server
              </calcite-button>
            </div>
          </div>

          <calcite-button
            slot="footer-start"
            appearance="outline"
            kind="neutral"
            onClick={() => setShowMcpConfigDialog(false)}
          >
            Cancel
          </calcite-button>
          <calcite-button slot="footer-end" appearance="solid" kind="brand" onClick={handleSaveMcpConfig}>
            Save MCP servers
          </calcite-button>
        </calcite-dialog>
      )}
    </calcite-shell>
  );
}
