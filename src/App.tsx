import React, { useCallback, useEffect, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import IdentityManager from "@arcgis/core/identity/IdentityManager";
import { registerCreateFeatureLayerAgent } from "./agents/CreateFeatureLayerAgent";
import { registerFeatureLayerCapabilitiesAgent } from "./agents/AllCapabilitiesAgent";
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

export default function App() {
  const appName = (import.meta.env.VITE_APP_NAME as string | undefined)?.trim() || "ArcGIS Assistant Demo";
  const portalUrl = (import.meta.env.VITE_ARCGIS_PORTAL_URL as string | undefined)?.trim() || "https://www.arcgis.com";
  const oauthClientId = (import.meta.env.VITE_ARCGIS_OAUTH_APP_ID as string | undefined)?.trim();
  const [webMapId, setWebMapId] = useState<string>("");
  const [inputWebMapId, setInputWebMapId] = useState("");
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [isEmbeddingBusy, setIsEmbeddingBusy] = useState(false);
  const [embeddingsStatusMessage, setEmbeddingsStatusMessage] = useState<string | null>(null);
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null);
  const autoCheckedMapIdRef = useRef<string | null>(null);

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
  }, [oauthClientId, portalUrl, webMapId]);

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
            <arcgis-expand slot="bottom-left" expand-icon="legend" collapse-icon="x" expanded>
              <arcgis-legend />
            </arcgis-expand>
          </arcgis-map>
          <calcite-shell-panel slot="panel-end" width="l" id="assistant-panel">
            <calcite-panel>
              <div slot="header-actions-end">
                <calcite-button
                  appearance="transparent"
                  icon-start="home"
                  scale="m"
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
                  scale="m"
                  onClick={() => {
                    if (isEmbeddingBusy) return;
                    void ensureWebMapEmbeddings(true);
                  }}
                  title="Regenerate embeddings"
                ></calcite-button>
                {renderAccountMenu()}
              </div>
              <arcgis-assistant
                reference-element="#main-map"
                heading={appName}
                description="Interact with a web map using natural language"
              >
                <arcgis-assistant-navigation-agent></arcgis-assistant-navigation-agent>
                <arcgis-assistant-data-exploration-agent></arcgis-assistant-data-exploration-agent>
                {/* Custom agent is appended programmatically via useEffect */}
              </arcgis-assistant>
              {(embeddingsStatusMessage || embeddingsError) && (
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
    </calcite-shell>
  );
}
