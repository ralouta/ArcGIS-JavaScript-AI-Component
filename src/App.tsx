import React, { useCallback, useEffect, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import IdentityManager from "@arcgis/core/identity/IdentityManager";
import PortalFolder from "@arcgis/core/portal/PortalFolder";
import Portal from "@arcgis/core/portal/Portal";
import WebMap from "@arcgis/core/WebMap";
import mcpServerIcon from "../mcpicon.png";
import { registerMcpPassthroughAgent, refreshMcpAgentDescription } from "./agents/McpPassthroughAgent";
import { registerCreateFeatureLayerAgent } from "./agents/CreateFeatureLayerAgent";
import { registerManageFeatureLayerAgent } from "./agents/ManageFeatureLayerAgent";
import { registerFeatureLayerCapabilitiesAgent } from "./agents/AllCapabilitiesAgent";
import { registerAddLayerToMapAgent } from "./agents/AddLayerToMapAgent";
import { resolveArcgisMcpBaseUrl } from "./utils/arcgisMcp";
import HubServerManager from "./components/HubServerManager";
import {
  createUserFolder,
  fetchPortalItemTitle,
  generateAndSaveWebMapEmbeddings,
  getCredential,
  getWebMapEmbeddingsStatus,
  initializeOAuth,
  listPortalCategoryOptions,
  listUserFolders,
  listUserTags,
  type PortalCategoryOption,
  type PortalTagInfo,
  type UserFolderInfo,
} from "./utils/arcgisOnline";

const LAST_WEBMAP_STORAGE_KEY = "arcgis-assistant:last-webmap";
const NEW_WEBMAP_TITLE = "New Map";
const NEW_WEBMAP_SNIPPET = "Created in ArcGIS Agent Components Demo and saved to ArcGIS Online immediately.";
const CREATE_NEW_FOLDER_OPTION = "__create_new_folder__";
const ROOT_FOLDER_OPTION = "__root_folder__";
const SUMMARY_CHAR_LIMIT = 2048;
const DEFAULT_NEW_MAP_VIEWPOINT = {
  targetGeometry: {
    type: "extent" as const,
    xmin: -13884991,
    ymin: 2870341,
    xmax: -7455066,
    ymax: 6338219,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  },
};

function getClientQueryParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function resolveAppMode(params: URLSearchParams): "default" | "edit" {
  const raw = params.get("mode")?.trim().toLowerCase();
  if (raw === "edit") return raw;
  return "default";
}

function readCalciteInputValue(event: any): string {
  return (
    event?.target?.value ??
    event?.currentTarget?.value ??
    event?.detail?.value ??
    ""
  );
}

function readArcgisErrorMessage(event: any, fallback: string): string {
  return (
    event?.detail?.error?.message ??
    event?.detail?.message ??
    event?.target?.fatalError?.message ??
    fallback
  );
}

function readElementValue(element: any, fallback = ""): string {
  return typeof element?.value === "string" ? element.value.trim() : fallback.trim();
}

function calciteBool(value: boolean): true | undefined {
  return value ? true : undefined;
}

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
const headerActionButtonScale = "l" as const;
const headerActionsContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};
const headerActionIconsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const headerActionMenuStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginLeft: "0.25rem",
};
const mcpIconStyle: React.CSSProperties = {
  width: "24px",
  height: "24px",
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

const ASSISTANT_THEME_STYLE_ID = "assistant-theme-style";
const ASSISTANT_THEME_CSS = `
:host {
  display: block;
  height: 100%;
  min-height: 0;
  --calcite-color-background: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-background-2: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-foreground-1: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-foreground-2: var(--app-chat-panel-bg, #ffffff);
  --calcite-color-text-1: var(--app-chat-message-text, #203040);
  --calcite-color-text-2: var(--app-chat-message-text, #203040);
  --calcite-color-border-1: var(--app-chat-panel-border, #d8e4ee);
  background: var(--app-chat-panel-bg, #ffffff);
  color: var(--app-chat-message-text, #203040);
}

[class*="container"],
[class*="panel"],
[class*="content"],
[class*="shell"],
[class*="messages"],
[class*="body"] {
  min-height: 0 !important;
  background: var(--app-chat-panel-bg, #ffffff) !important;
  color: var(--app-chat-message-text, #203040) !important;
  border-color: var(--app-chat-panel-border, #d8e4ee) !important;
}

[class*="header"],
[class*="footer"],
[class*="composer"],
[class*="prompt"] {
  position: relative;
  z-index: 1;
  background: var(--app-chat-panel-bg, #ffffff) !important;
  color: var(--app-chat-chrome-text, #395164) !important;
  border-color: var(--app-chat-panel-border, #d8e4ee) !important;
}

[class*="header"] *,
[class*="footer"] *,
[class*="composer"] *,
[class*="prompt"] *,
textarea,
input::placeholder {
  color: var(--app-chat-chrome-text, #395164) !important;
}

arcgis-assistant-chat-card,
[class*="message"],
[class*="response"],
[class*="body"] {
  color: var(--app-chat-message-text, #203040) !important;
}

button,
calcite-button {
  color: inherit;
}
`;

const HEADER_FONT_OPTIONS = [
  { label: "Aptos", value: '"Aptos", "Segoe UI", sans-serif' },
  { label: "Arial", value: 'Arial, "Helvetica Neue", sans-serif' },
  { label: "Arial Black", value: '"Arial Black", Gadget, sans-serif' },
  { label: "Avenir Next", value: '"Avenir Next", "Segoe UI", sans-serif' },
  { label: "Book Antiqua", value: '"Book Antiqua", Palatino, serif' },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
  { label: "DIN Next", value: '"DIN Next", "Avenir Next", sans-serif' },
  { label: "Georgia", value: 'Georgia, serif' },
  { label: "Helvetica Neue", value: '"Helvetica Neue", Arial, sans-serif' },
  { label: "Lucida Console", value: '"Lucida Console", Monaco, monospace' },
  { label: "Noto Sans", value: '"Noto Sans", "Helvetica Neue", sans-serif' },
  { label: "Palatino", value: 'Palatino, "Book Antiqua", serif' },
  { label: "Segoe UI", value: '"Segoe UI", Arial, sans-serif' },
  { label: "Tahoma", value: 'Tahoma, "Segoe UI", sans-serif' },
  { label: "Times New Roman", value: '"Times New Roman", Times, serif' },
  { label: "Trebuchet MS", value: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { label: "Verdana", value: 'Verdana, Geneva, sans-serif' },
  { label: "Monospace", value: '"Menlo", "SFMono-Regular", monospace' },
];

const DEFAULT_NEW_MAP_DRAFT: NewMapDraft = {
  title: NEW_WEBMAP_TITLE,
  folderChoice: ROOT_FOLDER_OPTION,
  newFolderName: "",
  selectedCategories: [],
  selectedTags: [],
  summary: "",
};

interface ThemeEditorSnapshot {
  headerTitle: string;
  headerSubtitle: string;
  headerFontFamily: string;
  headerBackground: string;
  headerBorderColor: string;
  headerTextColor: string;
  headerSubtitleColor: string;
  chatPanelTitle: string;
  chatPanelBackground: string;
  chatChromeColor: string;
  chatMessageColor: string;
  chatPanelBorderColor: string;
}

interface NewMapDraft {
  title: string;
  folderChoice: string;
  newFolderName: string;
  selectedCategories: string[];
  selectedTags: string[];
  summary: string;
}

interface CategoryTreeNode {
  label: string;
  value: string;
  fullLabel: string;
  children: CategoryTreeNode[];
}

function getCategoryLeafLabel(categoryValue: string, categoryOptions: PortalCategoryOption[]): string {
  const option = categoryOptions.find((entry) => entry.value === categoryValue);
  if (option) {
    const segments = option.value.split("/").filter(Boolean);
    return segments[segments.length - 1] || option.label;
  }

  const fallbackSegments = categoryValue.split("/").filter(Boolean);
  return fallbackSegments[fallbackSegments.length - 1] || categoryValue;
}

function buildCategoryTree(categoryOptions: PortalCategoryOption[]): CategoryTreeNode[] {
  const rootNodes: CategoryTreeNode[] = [];
  const nodesByValue = new Map<string, CategoryTreeNode>();

  categoryOptions.forEach((option) => {
    const pathSegments = option.value.split("/").filter(Boolean);
    if (!pathSegments.length) return;

    let currentChildren = rootNodes;

    pathSegments.forEach((segment, index) => {
      const currentValue = `/${pathSegments.slice(0, index + 1).join("/")}`;
      let currentNode = nodesByValue.get(currentValue);

      if (!currentNode) {
        currentNode = {
          label: segment,
          value: currentValue,
          fullLabel: pathSegments.slice(0, index + 1).join(" > "),
          children: [],
        };
        nodesByValue.set(currentValue, currentNode);
        currentChildren.push(currentNode);
      }

      currentChildren = currentNode.children;
    });
  });

  return rootNodes;
}

function renderCategoryComboboxItems(
  nodes: CategoryTreeNode[],
  selectedValues: string[],
): React.ReactNode {
  return nodes.map((node) => (
    <calcite-combobox-item
      key={node.value}
      value={node.value}
      heading={node.label}
      shortHeading={node.label}
      title={node.fullLabel}
      selected={calciteBool(selectedValues.includes(node.value))}
    >
      {node.children.length ? renderCategoryComboboxItems(node.children, selectedValues) : null}
    </calcite-combobox-item>
  ));
}

function readSelectedComboboxValues(element: any): string[] {
  const items = Array.isArray(element?.selectedItems)
    ? element.selectedItems
    : Array.from(element?.selectedItems ?? []);

  return items
    .map((item: any) => String(item.value ?? item.textLabel ?? item.heading ?? "").trim())
    .filter(Boolean);
}

async function buildNewWebMap(portalUrl: string): Promise<WebMap> {
  let basemap: any = null;
  let portal: Portal | null = null;

  try {
    portal = new Portal({ url: portalUrl });
    await portal.load();

    basemap =
      (portal.useVectorBasemaps ? portal.defaultVectorBasemap : null) ||
      portal.defaultBasemap ||
      portal.defaultVectorBasemap;

    if (basemap && typeof (basemap as any).load === "function") {
      await (basemap as any).load();
    }
  } catch {
    basemap = null;
  }

  const webMap = new WebMap({
    basemap: basemap || ("streets-vector" as any),
    initialViewProperties: {
      spatialReference: { wkid: 102100, latestWkid: 3857 },
      viewpoint: DEFAULT_NEW_MAP_VIEWPOINT,
    },
  });

  if (typeof (webMap as any).loadAll === "function") {
    await (webMap as any).loadAll();
  } else if (typeof (webMap as any).load === "function") {
    await (webMap as any).load();
  }

  return webMap;
}

function toAssistantPreparationErrorMessage(message: string): string {
  if (/eligible layers or fields|generate embeddings|embedding/i.test(message)) {
    return "This map does not yet have supported data for assistant setup.";
  }

  return message.replace(/embeddings?/gi, "assistant data");
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

function ensureAssistantThemeStyle(element: Element): void {
  const shadowRoot = (element as HTMLElement).shadowRoot;
  if (!shadowRoot || shadowRoot.getElementById(ASSISTANT_THEME_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = ASSISTANT_THEME_STYLE_ID;
  style.textContent = ASSISTANT_THEME_CSS;
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

  function handleAssistantLinkClick(event: Event): void {
    const composedPath = typeof event.composedPath === "function" ? event.composedPath() : [];
    const anchor = composedPath.find(
      (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
    );
    if (!anchor?.href) return;
    event.preventDefault();
    window.open(anchor.href, "_blank", "noopener,noreferrer");
  }

  function observeRoot(root: Element | ShadowRoot): void {
    if (observedRoots.has(root)) {
      return;
    }

    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("click", handleAssistantLinkClick, true);

    root.querySelectorAll("*").forEach((node) => {
      const shadowRoot = (node as HTMLElement).shadowRoot;
      if (shadowRoot) {
        observeRoot(shadowRoot);
      }
    });
  }

  function scanTree(root: Element | ShadowRoot): void {
    if (root instanceof Element && root.matches("arcgis-assistant")) {
      ensureAssistantThemeStyle(root);
    }

    root.querySelectorAll("a[href]").forEach((node) => {
      if (!(node instanceof HTMLAnchorElement)) return;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    });

    root.querySelectorAll("arcgis-assistant-chat-card").forEach((card) => {
      ensureAssistantThemeStyle(card);
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
    if (assistant) {
      assistant.removeEventListener("click", handleAssistantLinkClick, true);
    }
    if (assistant.shadowRoot) {
      assistant.shadowRoot.removeEventListener("click", handleAssistantLinkClick, true);
    }
  };
}

function cloneNavigationTarget(target: any): any {
  if (!target) return null;
  return typeof target.clone === "function" ? target.clone() : target;
}

function resolveSavedWebMapNavigationTarget(map: any): any {
  const initialViewProperties = map?.initialViewProperties;
  const initialViewpoint = cloneNavigationTarget(initialViewProperties?.viewpoint);
  if (initialViewpoint) {
    return initialViewpoint;
  }

  const targetGeometry = cloneNavigationTarget(initialViewProperties?.targetGeometry);
  if (targetGeometry) {
    return targetGeometry;
  }

  const portalItemExtent = cloneNavigationTarget(map?.portalItem?.extent);
  if (portalItemExtent) {
    return portalItemExtent;
  }

  return cloneNavigationTarget(map?.initialExtent) ?? null;
}

function getLoadedWebMapItemId(mapElement: any): string {
  return String(
    mapElement?.map?.portalItem?.id ??
    mapElement?.view?.map?.portalItem?.id ??
    "",
  ).trim();
}

export default function App() {
  const clientParams = getClientQueryParams();
  const appMode = resolveAppMode(clientParams);
  const appName = (import.meta.env.VITE_APP_NAME as string | undefined)?.trim() || "ArcGIS Agent Components Demo";
  const pageHeaderTitle = appName;
  const pageHeaderSubtitle = "Map exploration, MCP-assisted research, and feature editing in one workspace.";
  const showHeaderSubtitle = true;
  const showHeaderActions = true;
  const pageHeaderBackground = "linear-gradient(90deg, #f6fbff 0%, #fffaf2 100%)";
  const pageHeaderBorderColor = "#d8e4ee";
  const portalUrl = (import.meta.env.VITE_ARCGIS_PORTAL_URL as string | undefined)?.trim() || "https://www.arcgis.com";
  const oauthClientId = (import.meta.env.VITE_ARCGIS_OAUTH_APP_ID as string | undefined)?.trim();
  const defaultMcpBaseUrl = resolveArcgisMcpBaseUrl();
  const [webMapId, setWebMapId] = useState<string>("");
  const [inputWebMapId, setInputWebMapId] = useState("");
  const [headerTitle, setHeaderTitle] = useState(pageHeaderTitle);
  const [headerSubtitle, setHeaderSubtitle] = useState(pageHeaderSubtitle);
  const [headerFontFamily, setHeaderFontFamily] = useState(HEADER_FONT_OPTIONS[0].value);
  const [headerBackground, setHeaderBackground] = useState(pageHeaderBackground);
  const [headerBorderColor, setHeaderBorderColor] = useState(pageHeaderBorderColor);
  const [headerTextColor, setHeaderTextColor] = useState("#203040");
  const [headerSubtitleColor, setHeaderSubtitleColor] = useState("#5a6a79");
  const [chatPanelTitle, setChatPanelTitle] = useState(appName);
  const [chatPanelBackground, setChatPanelBackground] = useState("#ffffff");
  const [chatChromeColor, setChatChromeColor] = useState("#395164");
  const [chatMessageColor, setChatMessageColor] = useState("#203040");
  const [chatPanelBorderColor, setChatPanelBorderColor] = useState("#d8e4ee");
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showHubManager, setShowHubManager] = useState(false);
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  const [themeEditorKey, setThemeEditorKey] = useState(0);
  const [showChangeMapDialog, setShowChangeMapDialog] = useState(false);
  const [showNewMapDialog, setShowNewMapDialog] = useState(false);
  const [changeMapDialogInput, setChangeMapDialogInput] = useState("");
  const [newMapDraft, setNewMapDraft] = useState<NewMapDraft>(DEFAULT_NEW_MAP_DRAFT);
  const [newMapFolders, setNewMapFolders] = useState<UserFolderInfo[]>([]);
  const [newMapCategoryOptions, setNewMapCategoryOptions] = useState<PortalCategoryOption[]>([]);
  const [newMapTagOptions, setNewMapTagOptions] = useState<PortalTagInfo[]>([]);
  const [isNewMapMetadataBusy, setIsNewMapMetadataBusy] = useState(false);
  const [isNewMapCreateBusy, setIsNewMapCreateBusy] = useState(false);
  const [newMapDialogError, setNewMapDialogError] = useState<string | null>(null);
  const [showEmbeddingRegenerateButton, setShowEmbeddingRegenerateButton] = useState(false);
  const [isEmbeddingBusy, setIsEmbeddingBusy] = useState(false);
  const [isAssistantPrepared, setIsAssistantPrepared] = useState(false);
  const [embeddingsStatusMessage, setEmbeddingsStatusMessage] = useState<string | null>(null);
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null);
  const [currentMapTitle, setCurrentMapTitle] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [mapHasOperationalData, setMapHasOperationalData] = useState(false);
  const [showEmptyMapAssistantNotice, setShowEmptyMapAssistantNotice] = useState(true);
  const [mapLoadError, setMapLoadError] = useState<string | null>(null);
  const autoCheckedMapIdRef = useRef<string | null>(null);
  const themeEditorSnapshotRef = useRef<ThemeEditorSnapshot | null>(null);
  const mapElementRef = useRef<any>(null);
  const homeElementRef = useRef<any>(null);
  const startupWebMapInputRef = useRef<any>(null);
  const changeMapDialogInputRef = useRef<any>(null);
  const layersExpandRef = useRef<any>(null);
  const basemapExpandRef = useRef<any>(null);
  const legendExpandRef = useRef<any>(null);
  const categoryTree = buildCategoryTree(newMapCategoryOptions);
  const effectiveWebMapId = webMapId;

  useEffect(() => {
    const expandEls = [layersExpandRef.current, basemapExpandRef.current, legendExpandRef.current];
    const cleanups: (() => void)[] = [];
    expandEls.forEach((el, i) => {
      if (!el) return;
      const others = expandEls.filter((_, j) => j !== i);
      const handler = (event: Event) => {
        const e = event as CustomEvent<{ name: string }>;
        if (e.detail?.name === "expanded" && el.expanded) {
          others.forEach((other) => { if (other) other.expanded = false; });
        }
      };
      el.addEventListener("arcgisPropertyChange", handler);
      cleanups.push(() => el.removeEventListener("arcgisPropertyChange", handler));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [effectiveWebMapId]);

  useEffect(() => {
    if (!effectiveWebMapId || !isMapReady) return;

    const assistant = document.querySelector("arcgis-assistant") as HTMLElement | null;
    if (!assistant) return;

    registerCreateFeatureLayerAgent(assistant, {
      oauthClientId,
      portalUrl,
      layerName: "Locations",
    });
    registerManageFeatureLayerAgent(assistant);
    registerAddLayerToMapAgent(assistant);
    registerFeatureLayerCapabilitiesAgent(assistant);
    registerMcpPassthroughAgent(assistant, {
      baseUrl: defaultMcpBaseUrl,
      serverName: "MCP Hub",
    });
  }, [
    defaultMcpBaseUrl,
    effectiveWebMapId,
    isMapReady,
    oauthClientId,
    portalUrl,
  ]);

  useEffect(() => {
    if (!effectiveWebMapId || !isMapReady) return;

    const assistant = document.querySelector("arcgis-assistant") as HTMLElement | null;
    if (!assistant) return;

    return installAssistantUserBubbleStyler(assistant);
  }, [effectiveWebMapId, isMapReady]);

  useEffect(() => {
    if (!effectiveWebMapId) {
      setIsMapReady(false);
      setMapHasOperationalData(false);
      setMapLoadError(null);
      setIsAssistantPrepared(false);
      return;
    }

    setIsMapReady(false);
    setMapHasOperationalData(false);
    setMapLoadError(null);
    setIsAssistantPrepared(false);
    setShowEmptyMapAssistantNotice(true);
  }, [effectiveWebMapId]);

  useEffect(() => {
    const mapElement = mapElementRef.current;
    if (!mapElement || !effectiveWebMapId) return;

    let cancelled = false;
    const requestedMap = new WebMap({
      portalItem: { id: effectiveWebMapId } as any,
    });

    mapElement.map = requestedMap;

    const handleViewReady = () => {
      const loadedItemId = getLoadedWebMapItemId(mapElement);
      if (!loadedItemId || loadedItemId !== effectiveWebMapId || cancelled) {
        return;
      }
      setIsMapReady(true);
      setMapLoadError(null);
    };

    const handleViewReadyError = (event: Event) => {
      setIsMapReady(false);
      setMapLoadError(readArcgisErrorMessage(event, "Failed to initialize the WebMap view."));
    };

    const handleLoadError = (event: Event) => {
      setIsMapReady(false);
      setMapLoadError(readArcgisErrorMessage(event, "Failed to load the requested WebMap."));
    };

    mapElement.addEventListener("arcgisViewReadyChange", handleViewReady);
    mapElement.addEventListener("arcgisViewReadyError", handleViewReadyError);
    mapElement.addEventListener("arcgisLoadError", handleLoadError);

    const waitForRequestedWebMap = async () => {
      for (let attempt = 0; attempt < 120 && !cancelled; attempt += 1) {
        const loadedItemId = getLoadedWebMapItemId(mapElement);
        if (loadedItemId === effectiveWebMapId && (mapElement.ready || mapElement.view)) {
          handleViewReady();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
    };

    void waitForRequestedWebMap();

    return () => {
      cancelled = true;
      mapElement.removeEventListener("arcgisViewReadyChange", handleViewReady);
      mapElement.removeEventListener("arcgisViewReadyError", handleViewReadyError);
      mapElement.removeEventListener("arcgisLoadError", handleLoadError);
    };
  }, [effectiveWebMapId]);

  useEffect(() => {
    const mapElement = mapElementRef.current;
    if (!mapElement || !effectiveWebMapId || !isMapReady) return;

    const map = mapElement.map || mapElement.view?.map;
    const layers = map?.layers;
    const tables = map?.tables;

    const updateMapDataState = () => {
      const layerCount = layers?.length ?? layers?.toArray?.().length ?? 0;
      const tableCount = tables?.length ?? tables?.toArray?.().length ?? 0;
      setMapHasOperationalData(layerCount + tableCount > 0);
    };

    updateMapDataState();

    const layerHandle = layers?.on?.("change", updateMapDataState);
    const tableHandle = tables?.on?.("change", updateMapDataState);

    return () => {
      layerHandle?.remove?.();
      tableHandle?.remove?.();
    };
  }, [effectiveWebMapId, isMapReady]);

  useEffect(() => {
    const mapElement = mapElementRef.current;
    const homeElement = homeElementRef.current;
    const view = mapElement?.view;
    if (!mapElement || !homeElement || !effectiveWebMapId || !isMapReady || !view) return;

    let cancelled = false;

    const syncSavedWebMapView = async () => {
      const map = view.map;

      try {
        await view.when();
        if (typeof map?.load === "function") {
          await map.load();
        }

        const savedTarget = resolveSavedWebMapNavigationTarget(map);
        if (savedTarget) {
          await view.goTo(savedTarget, { animate: false });
        }
      } catch {
        // Ignore readiness/navigation noise and still try to capture the settled view.
      }

      if (cancelled) return;

      const currentViewpoint = typeof view.viewpoint?.clone === "function"
        ? view.viewpoint.clone()
        : view.viewpoint;

      if (currentViewpoint) {
        homeElement.viewpoint = currentViewpoint;
      }
    };

    void syncSavedWebMapView();

    return () => {
      cancelled = true;
    };
  }, [effectiveWebMapId, isMapReady]);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  useEffect(() => {
    setChatPanelTitle(appName);
  }, [appName]);

  useEffect(() => {
    setHeaderTitle(pageHeaderTitle);
  }, [pageHeaderTitle]);

  useEffect(() => {
    setHeaderSubtitle(pageHeaderSubtitle);
  }, [pageHeaderSubtitle]);

  useEffect(() => {
    setHeaderFontFamily(HEADER_FONT_OPTIONS[0].value);
  }, []);

  useEffect(() => {
    setHeaderBackground(pageHeaderBackground);
  }, [pageHeaderBackground]);

  useEffect(() => {
    setHeaderBorderColor(pageHeaderBorderColor);
  }, [pageHeaderBorderColor]);

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

  useEffect(() => {
    if (!isSignedIn || webMapId || typeof window === "undefined") return;

    const storedWebMapId = window.localStorage.getItem(LAST_WEBMAP_STORAGE_KEY)?.trim();
    if (!storedWebMapId) return;

    setWebMapId(storedWebMapId);
    setInputWebMapId(storedWebMapId);
    setEmbeddingsStatusMessage(null);
    setEmbeddingsError(null);
    autoCheckedMapIdRef.current = null;
  }, [isSignedIn, webMapId]);

  useEffect(() => {
    if (!isSignedIn || typeof window === "undefined") return;

    if (!webMapId || !mapHasOperationalData) {
      window.localStorage.removeItem(LAST_WEBMAP_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(LAST_WEBMAP_STORAGE_KEY, webMapId);
  }, [isSignedIn, mapHasOperationalData, webMapId]);

  useEffect(() => {
    if (!effectiveWebMapId) {
      setCurrentMapTitle(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const credential = isSignedIn ? await getCredential(oauthClientId, portalUrl) : null;
        const title = await fetchPortalItemTitle(
          portalUrl,
          effectiveWebMapId,
          credential?.token,
        );
        if (!cancelled) {
          setCurrentMapTitle(title);
        }
      } catch {
        if (!cancelled) {
          setCurrentMapTitle(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveWebMapId, isSignedIn, oauthClientId, portalUrl]);

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

  const handleLoadMap = useCallback(async () => {
    const nextWebMapId = readElementValue(startupWebMapInputRef.current, inputWebMapId);
    if (!nextWebMapId) return;

    setCurrentMapTitle(null);
    setWebMapId(nextWebMapId);
    setInputWebMapId(nextWebMapId);
    setEmbeddingsStatusMessage(null);
    setEmbeddingsError(null);
    autoCheckedMapIdRef.current = null;
  }, [inputWebMapId]);

  const closeTransientWindows = useCallback(() => {
    setShowSignOutConfirm(false);
    setShowHubManager(false);
    setShowThemeEditor(false);
    setShowChangeMapDialog(false);
    setShowNewMapDialog(false);
  }, []);

  const openNewMapDialog = useCallback(async () => {
    closeTransientWindows();
    setShowNewMapDialog(true);
    setNewMapDraft(DEFAULT_NEW_MAP_DRAFT);
    setNewMapDialogError(null);
    setIsNewMapMetadataBusy(true);

    try {
      const credential = await getCredential(oauthClientId, portalUrl);
      const [folders, categoryOptions, tagOptions] = await Promise.all([
        listUserFolders({
          portalUrl,
          token: credential.token,
          username: credential.username,
        }),
        listPortalCategoryOptions({ portalUrl }),
        listUserTags({ portalUrl }),
      ]);
      setNewMapFolders(folders);
      setNewMapCategoryOptions(categoryOptions);
      setNewMapTagOptions(tagOptions);
    } catch (error: any) {
      setNewMapFolders([]);
      setNewMapCategoryOptions([]);
      setNewMapTagOptions([]);
      setNewMapDialogError(error?.message || "Failed to load folders.");
    } finally {
      setIsNewMapMetadataBusy(false);
    }
  }, [closeTransientWindows, oauthClientId, portalUrl]);

  const handleCreateNewMap = useCallback(async () => {
    let newWebMap: WebMap | null = null;

    try {
      setIsNewMapCreateBusy(true);
      setNewMapDialogError(null);
      if (newMapDraft.summary.length > SUMMARY_CHAR_LIMIT) {
        throw new Error(`Summary cannot exceed ${SUMMARY_CHAR_LIMIT} characters.`);
      }

      const credential = await getCredential(oauthClientId, portalUrl);
      let folderId = "";

      if (newMapDraft.folderChoice === CREATE_NEW_FOLDER_OPTION) {
        if (!newMapDraft.newFolderName.trim()) {
          throw new Error("Enter a folder name or choose an existing folder.");
        }
        const createdFolder = await createUserFolder({
          portalUrl,
          token: credential.token,
          username: credential.username,
          title: newMapDraft.newFolderName.trim(),
        });
        folderId = createdFolder.id;
        setNewMapFolders((current) => [createdFolder, ...current.filter((folder) => folder.id !== createdFolder.id)]);
      } else if (newMapDraft.folderChoice !== ROOT_FOLDER_OPTION) {
        folderId = newMapDraft.folderChoice.trim();
      }

      const portal = new Portal({ url: portalUrl });
      await portal.load();

      newWebMap = await buildNewWebMap(portalUrl);

      const selectedFolder = folderId
        ? newMapFolders.find((folder) => folder.id === folderId) ?? null
        : null;
      const saveFolder = selectedFolder
        ? new PortalFolder({
            id: selectedFolder.id,
            title: selectedFolder.title,
            portal,
          })
        : undefined;

      const savedPortalItem = await newWebMap.saveAs({
        title: newMapDraft.title.trim() || NEW_WEBMAP_TITLE,
        snippet: newMapDraft.summary.trim() || NEW_WEBMAP_SNIPPET,
        description: newMapDraft.summary.trim() || undefined,
        tags: newMapDraft.selectedTags,
        categories: newMapDraft.selectedCategories,
        portal,
      }, saveFolder ? { folder: saveFolder } : undefined);

      if (!savedPortalItem?.id) {
        throw new Error("Failed to create a new WebMap.");
      }

      setWebMapId(savedPortalItem.id);
      setInputWebMapId("");
      setCurrentMapTitle(savedPortalItem.title || newMapDraft.title.trim() || NEW_WEBMAP_TITLE);
      setMapLoadError(null);
      setEmbeddingsStatusMessage(null);
      setEmbeddingsError(null);
      autoCheckedMapIdRef.current = null;
      setShowNewMapDialog(false);
    } catch (error: any) {
      const message = error?.message || "Failed to create a new map.";
      setNewMapDialogError(message);
      setEmbeddingsError(toAssistantPreparationErrorMessage(message));
      setEmbeddingsStatusMessage(null);
    } finally {
      newWebMap?.destroy();
      setIsNewMapCreateBusy(false);
    }
  }, [newMapDraft, newMapFolders, oauthClientId, portalUrl]);

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

  const handleNewMapTagAdd = useCallback((rawTag: string) => {
    const nextTag = rawTag.trim();
    if (!nextTag) return;

    setNewMapDraft((current) => ({
      ...current,
      selectedTags: current.selectedTags.includes(nextTag)
        ? current.selectedTags
        : [...current.selectedTags, nextTag],
    }));
    setNewMapTagOptions((current) =>
      current.some((entry) => entry.tag === nextTag)
        ? current
        : [...current, { tag: nextTag, count: 0 }].sort((left, right) => left.tag.localeCompare(right.tag))
    );
  }, []);

  const handleNewMapTagRemove = useCallback((tag: string) => {
    setNewMapDraft((current) => ({
      ...current,
      selectedTags: current.selectedTags.filter((value) => value !== tag),
    }));
  }, []);

  const handleNewMapCategoryRemove = useCallback((category: string) => {
    setNewMapDraft((current) => ({
      ...current,
      selectedCategories: current.selectedCategories.filter((value) => value !== category),
    }));
  }, []);

  const handleNewMapFolderChange = useCallback((event: any) => {
    const values = readSelectedComboboxValues(event.target);
    const folderValue = values[0] || ROOT_FOLDER_OPTION;
    const existingFolderIds = new Set(newMapFolders.map((folder) => folder.id));

    if (folderValue === ROOT_FOLDER_OPTION || existingFolderIds.has(folderValue)) {
      setNewMapDraft((current) => ({
        ...current,
        folderChoice: folderValue,
        newFolderName: "",
      }));
      return;
    }

    setNewMapDraft((current) => ({
      ...current,
      folderChoice: CREATE_NEW_FOLDER_OPTION,
      newFolderName: folderValue,
    }));
  }, [newMapFolders]);

  const handleNewMapTagChange = useCallback((event: any) => {
    const values = readSelectedComboboxValues(event.target);
    const existingTags = new Set(newMapTagOptions.map((entry) => entry.tag));

    values
      .filter((tag) => !existingTags.has(tag))
      .forEach((tag) => handleNewMapTagAdd(tag));

    setNewMapDraft((current) => ({
      ...current,
      selectedTags: values,
    }));
  }, [handleNewMapTagAdd, newMapTagOptions]);

  const handleNewMapCategoryChange = useCallback((event: any) => {
    const values = readSelectedComboboxValues(event.target);
    setNewMapDraft((current) => ({
      ...current,
      selectedCategories: values,
    }));
  }, []);

  const handleChangeWebMapClick = useCallback(() => {
    closeTransientWindows();
    setChangeMapDialogInput("");
    setShowChangeMapDialog(true);
  }, [closeTransientWindows]);

  const handleChangeMapDialogLoad = useCallback(async () => {
    const trimmed = readElementValue(changeMapDialogInputRef.current, changeMapDialogInput);
    if (!trimmed) return;
    setShowChangeMapDialog(false);
    setCurrentMapTitle(null);
    setWebMapId(trimmed);
    setInputWebMapId(trimmed);
    setEmbeddingsStatusMessage(null);
    setEmbeddingsError(null);
    autoCheckedMapIdRef.current = null;
  }, [changeMapDialogInput]);

  const handleMcpButtonClick = useCallback((event?: MouseEvent) => {
    // Easter egg: macOS Command+Shift+click, Windows/Linux Control+Shift+click.
    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
    const hasUnlockModifiers = Boolean(
      event && event.shiftKey && (isMac ? event.metaKey : event.ctrlKey),
    );

    if (hasUnlockModifiers) {
      setShowEmbeddingRegenerateButton((prev) => !prev);
      return;
    }

    closeTransientWindows();
    setShowHubManager(true);
  }, [closeTransientWindows]);

  const handleOpenThemeEditor = useCallback(() => {
    closeTransientWindows();
    themeEditorSnapshotRef.current = {
      headerTitle,
      headerSubtitle,
      headerFontFamily,
      headerBackground,
      headerBorderColor,
      headerTextColor,
      headerSubtitleColor,
      chatPanelTitle,
      chatPanelBackground,
      chatChromeColor,
      chatMessageColor,
      chatPanelBorderColor,
    };
    setThemeEditorKey((current) => current + 1);
    setShowThemeEditor(true);
  }, [
    closeTransientWindows,
    chatChromeColor,
    chatMessageColor,
    chatPanelBackground,
    chatPanelBorderColor,
    chatPanelTitle,
    headerBackground,
    headerBorderColor,
    headerFontFamily,
    headerSubtitle,
    headerSubtitleColor,
    headerTextColor,
    headerTitle,
  ]);

  const handleCloseThemeEditor = useCallback(() => {
    setShowThemeEditor(false);
    themeEditorSnapshotRef.current = null;
  }, []);

  const handleCancelThemeEditor = useCallback(() => {
    const snapshot = themeEditorSnapshotRef.current;
    if (snapshot) {
      setHeaderTitle(snapshot.headerTitle);
      setHeaderSubtitle(snapshot.headerSubtitle);
      setHeaderFontFamily(snapshot.headerFontFamily);
      setHeaderBackground(snapshot.headerBackground);
      setHeaderBorderColor(snapshot.headerBorderColor);
      setHeaderTextColor(snapshot.headerTextColor);
      setHeaderSubtitleColor(snapshot.headerSubtitleColor);
      setChatPanelTitle(snapshot.chatPanelTitle);
      setChatPanelBackground(snapshot.chatPanelBackground);
      setChatChromeColor(snapshot.chatChromeColor);
      setChatMessageColor(snapshot.chatMessageColor);
      setChatPanelBorderColor(snapshot.chatPanelBorderColor);
    }
    setShowThemeEditor(false);
    themeEditorSnapshotRef.current = null;
  }, []);

  const renderAccountMenu = () => (
    <calcite-dropdown placement="bottom-end" type="click" scale="l">
      <calcite-button slot="trigger" appearance="transparent" icon-start="user" scale="l">
        {currentUser || "ArcGIS user"}
      </calcite-button>
      <calcite-dropdown-group group-title="Account" selection-mode="none">
        <calcite-dropdown-item
          icon-start="sign-out"
          onClick={() => {
            closeTransientWindows();
            setShowSignOutConfirm(true);
          }}
        >
          Sign out
        </calcite-dropdown-item>
      </calcite-dropdown-group>
    </calcite-dropdown>
  );

  const ensureWebMapEmbeddings = useCallback(
    async (forceRegenerate = false) => {
      if (!effectiveWebMapId) {
        setIsEmbeddingBusy(false);
        setIsAssistantPrepared(false);
        setEmbeddingsStatusMessage(null);
        setEmbeddingsError(null);
        return;
      }

      if (!mapHasOperationalData) {
        setIsEmbeddingBusy(false);
        setIsAssistantPrepared(false);
        setEmbeddingsError(null);
        setEmbeddingsStatusMessage(null);
        return;
      }

      setEmbeddingsError(null);
      setIsAssistantPrepared(false);
      setIsEmbeddingBusy(true);

      try {
        const cred = await getCredential(oauthClientId, portalUrl);

        if (!forceRegenerate) {
          setEmbeddingsStatusMessage("Preparing assistant for this map...");
          const status = await getWebMapEmbeddingsStatus(portalUrl, cred.token, effectiveWebMapId);
          if (status.exists) {
            setIsAssistantPrepared(true);
            setEmbeddingsStatusMessage("Assistant is ready for this map.");
            autoCheckedMapIdRef.current = effectiveWebMapId;
            return;
          }
        }

        setEmbeddingsStatusMessage(
          forceRegenerate
            ? "Refreshing assistant data for this map..."
            : "Preparing assistant data for this map..."
        );

        const result = await generateAndSaveWebMapEmbeddings({
          portalUrl,
          token: cred.token,
          webMapItemId: effectiveWebMapId,
          removeExisting: true,
        });

        if (!result.success) {
          throw new Error(result.message || "Failed to generate embeddings.");
        }

        setIsAssistantPrepared(true);
        setEmbeddingsStatusMessage("Assistant is ready for this map.");
        autoCheckedMapIdRef.current = effectiveWebMapId;
      } catch (error: any) {
        setIsAssistantPrepared(false);
        const message = toAssistantPreparationErrorMessage(
          error?.message || "Unable to prepare the assistant for this map.",
        );
        setEmbeddingsError(message);
        setEmbeddingsStatusMessage(null);
      } finally {
        setIsEmbeddingBusy(false);
      }
    },
    [effectiveWebMapId, mapHasOperationalData, oauthClientId, portalUrl]
  );

  useEffect(() => {
    if (!isSignedIn || !effectiveWebMapId || !isMapReady || mapLoadError || !mapHasOperationalData) return;
    if (autoCheckedMapIdRef.current === effectiveWebMapId) return;
    void ensureWebMapEmbeddings(false);
  }, [effectiveWebMapId, ensureWebMapEmbeddings, isMapReady, isSignedIn, mapHasOperationalData, mapLoadError]);

  const signInBlocked = isSigningIn || !oauthClientId;
  const loadMapBlocked = !inputWebMapId.trim();
  const shouldShowHeaderActions = showHeaderActions && isSignedIn;
  const isStartupPage = isSignedIn && !webMapId;
  const shouldRenderAssistant = isMapReady && !mapLoadError;

  return (
    <calcite-shell
      style={{ height: "100vh" }}
      className={`app-shell app-shell--${appMode}${isStartupPage ? " app-shell--startup" : ""}`}
    >
      <div
        slot="header"
        className="app-header-bar"
        style={{
          background: headerBackground,
          borderBottomColor: headerBorderColor,
        }}
      >
        <div className="app-header-main">
          {!isStartupPage && (
            <div className="app-header-copy">
              <div
                className="app-header-title"
                style={{ color: headerTextColor, fontFamily: headerFontFamily }}
              >
                {headerTitle}
              </div>
              {showHeaderSubtitle && (
                <div
                  className="app-header-subtitle"
                  style={{ color: headerSubtitleColor, fontFamily: headerFontFamily }}
                >
                  {headerSubtitle}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="app-header-right">
          {shouldShowHeaderActions && (
            <div style={headerActionsContainerStyle}>
              {!isStartupPage && (
                <div style={headerActionIconsRowStyle}>
                  {appMode === "edit" && (
                    <calcite-button
                      appearance="transparent"
                      icon-start="pencil"
                      scale={headerActionButtonScale}
                      title="Edit theme"
                      aria-label="Edit theme"
                      className="app-header-icon-button"
                      onClick={handleOpenThemeEditor}
                    ></calcite-button>
                  )}
                  <calcite-button
                    appearance="transparent"
                    icon-start="map"
                    scale={headerActionButtonScale}
                    title={webMapId ? "Change WebMap" : "Load WebMap"}
                    className="app-header-icon-button"
                    onClick={handleChangeWebMapClick as any}
                  ></calcite-button>
                  {showEmbeddingRegenerateButton && webMapId && (
                    <calcite-button
                      appearance="transparent"
                      icon-start="reset"
                      scale={headerActionButtonScale}
                      className="app-header-icon-button"
                      onClick={() => {
                        if (isEmbeddingBusy) return;
                        void ensureWebMapEmbeddings(true);
                      }}
                      title="Refresh assistant data"
                    ></calcite-button>
                  )}
                  <calcite-button
                    appearance="transparent"
                    scale={headerActionButtonScale}
                    title="Manage MCP servers"
                    aria-label="Manage MCP servers"
                    className="app-header-icon-button"
                    onClick={(event: any) => handleMcpButtonClick(event?.nativeEvent ?? event)}
                  >
                    <span aria-hidden="true" style={mcpIconStyle}></span>
                  </calcite-button>
                </div>
              )}
              <div style={headerActionMenuStyle}>{renderAccountMenu()}</div>
            </div>
          )}
        </div>
      </div>
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
            <div style={panelBodyStyle}>
              <div className="map-picker-stack">
                <calcite-label>
                  Web Map ID
                  <calcite-input
                    ref={startupWebMapInputRef}
                    value={inputWebMapId}
                    placeholder="Enter web map item ID"
                    onCalciteInputInput={(e: any) => setInputWebMapId(readCalciteInputValue(e))}
                    onCalciteInputChange={(e: any) => setInputWebMapId(readCalciteInputValue(e))}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === "Enter") {
                        void handleLoadMap();
                      }
                    }}
                    clearable
                  />
                </calcite-label>
                <calcite-button
                  appearance="solid"
                  kind="brand"
                  width="full"
                  onClick={() => {
                    void handleLoadMap();
                  }}
                >
                  Load map
                </calcite-button>
                <calcite-button appearance="outline" width="full" onClick={() => void openNewMapDialog()}>
                  New map
                </calcite-button>
                <div style={{ fontSize: "0.85rem", color: "#5a6a79", lineHeight: 1.45 }}>
                  New Map creates a fresh Web Map item in ArcGIS Online immediately, then opens it here for editing.
                </div>
              </div>
            </div>
          </calcite-panel>
        </div>
      ) : (
        <>
          <arcgis-map
            key={effectiveWebMapId || "empty-webmap"}
            ref={mapElementRef}
            id="main-map"
          >
            <arcgis-zoom slot="top-left" />
            <arcgis-home ref={homeElementRef} slot="top-left" />
            <arcgis-expand ref={layersExpandRef} slot="top-left" expand-icon="layers" collapse-icon="x">
              <arcgis-layer-list />
            </arcgis-expand>
            <arcgis-expand ref={basemapExpandRef} slot="top-left" expand-icon="basemap" collapse-icon="x">
              <arcgis-basemap-gallery />
            </arcgis-expand>
            <arcgis-expand ref={legendExpandRef} slot="bottom-left" expand-icon="legend" collapse-icon="x">
              <arcgis-legend />
            </arcgis-expand>
          </arcgis-map>
          <calcite-shell-panel
            slot="panel-end"
            width="l"
            id="assistant-panel"
            style={{ borderLeft: `1px solid ${chatPanelBorderColor}` }}
          >
              <div
                className="chat-panel-theme"
                style={{
                  backgroundColor: chatPanelBackground,
                  color: chatMessageColor,
                  borderColor: chatPanelBorderColor,
                }}
              >
                {mapLoadError ? (
                  <div style={{ padding: "1rem", lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>Map failed to load</div>
                    <div>{mapLoadError}</div>
                  </div>
                ) : !isMapReady ? (
                  <div style={{ padding: "1rem", lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>Loading map</div>
                    <div>The assistant will appear after the WebMap view is ready.</div>
                  </div>
                ) : (
                  <>
                    {!mapHasOperationalData && showEmptyMapAssistantNotice && (
                      <div className="chat-panel-theme__notice" style={{ marginBottom: "0.9rem" }}>
                        <div>
                          This map is empty, so map navigation and data exploration stay disabled until layers or tables are added. MCP and custom assistant workflows are still available.
                        </div>
                        <button
                          type="button"
                          className="chat-panel-theme__notice-close"
                          aria-label="Dismiss empty map notice"
                          title="Dismiss"
                          onClick={() => setShowEmptyMapAssistantNotice(false)}
                        >
                          ×
                        </button>
                      </div>
                    )}
                    {mapHasOperationalData && !isAssistantPrepared && !embeddingsError && (
                      <div style={{ padding: "0.25rem 0.9rem 0.9rem", lineHeight: 1.5 }}>
                        <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>Preparing map-aware assistant tools</div>
                        <div>
                          {embeddingsStatusMessage || "Map-specific assistant data is still being prepared. MCP and custom assistant workflows remain available."}
                        </div>
                      </div>
                    )}
                    {shouldRenderAssistant && (
                      <arcgis-assistant
                        reference-element="#main-map"
                        heading={chatPanelTitle}
                        class="chat-panel-theme__assistant"
                        style={{
                          backgroundColor: chatPanelBackground,
                          color: chatMessageColor,
                          border: "none",
                          borderRadius: "14px",
                          padding: 0,
                          ["--app-chat-panel-bg" as any]: chatPanelBackground,
                          ["--app-chat-chrome-text" as any]: chatChromeColor,
                          ["--app-chat-message-text" as any]: chatMessageColor,
                          ["--app-chat-panel-border" as any]: chatPanelBorderColor,
                        }}
                      >
                        <arcgis-assistant-help-agent></arcgis-assistant-help-agent>
                        <arcgis-assistant-navigation-agent></arcgis-assistant-navigation-agent>
                        <arcgis-assistant-data-exploration-agent></arcgis-assistant-data-exploration-agent>
                        {/* Custom agent is appended programmatically via useEffect */}
                      </arcgis-assistant>
                    )}
                  </>
                )}
              {(embeddingsStatusMessage || embeddingsError) && (
                <div className="chat-panel-theme__status" style={{ padding: "0.4rem 0.9rem 0.8rem", fontSize: "0.85rem", color: chatMessageColor }}>
                  {embeddingsStatusMessage && (
                    <div>
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
              </div>
          </calcite-shell-panel>
        </>
      )}

      {showSignOutConfirm && (
        <calcite-dialog
          open
          overlay-positioning="fixed"
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

      {showThemeEditor && (
        <calcite-dialog
          key={themeEditorKey}
          open
          overlay-positioning="fixed"
          heading="Edit theme"
          width="m"
          onCalciteDialogClose={handleCancelThemeEditor}
        >
          <div className="theme-editor-dialog">
            <div className="theme-editor-grid theme-editor-grid--text">
              <label className="theme-editor-field theme-editor-field--wide">
                <span>Title</span>
                <input
                  value={headerTitle}
                  onChange={(event) => setHeaderTitle(event.target.value)}
                  placeholder="Header title"
                />
              </label>
              {showHeaderSubtitle && (
                <label className="theme-editor-field theme-editor-field--wide">
                  <span>Subtitle</span>
                  <input
                    value={headerSubtitle}
                    onChange={(event) => setHeaderSubtitle(event.target.value)}
                    placeholder="Header subtitle"
                  />
                </label>
              )}
              <label className="theme-editor-field theme-editor-field--wide">
                <span>Font</span>
                <select
                  value={headerFontFamily}
                  onChange={(event) => setHeaderFontFamily(event.target.value)}
                >
                  {HEADER_FONT_OPTIONS.map((fontOption) => (
                    <option key={fontOption.label} value={fontOption.value}>
                      {fontOption.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="theme-editor-section-label">Header</div>
            <div className="theme-editor-grid">
              <label className="theme-editor-color-field">
                <span>Title</span>
                <input
                  type="color"
                  value={headerTextColor}
                  onChange={(event) => setHeaderTextColor(event.target.value)}
                />
              </label>
              <label className="theme-editor-color-field">
                <span>Subtitle</span>
                <input
                  type="color"
                  value={headerSubtitleColor}
                  onChange={(event) => setHeaderSubtitleColor(event.target.value)}
                />
              </label>
              <label className="theme-editor-color-field">
                <span>Background</span>
                <input
                  type="color"
                  value={headerBackground.startsWith("#") ? headerBackground : "#f6fbff"}
                  onChange={(event) => setHeaderBackground(event.target.value)}
                />
              </label>
              <label className="theme-editor-color-field">
                <span>Border</span>
                <input
                  type="color"
                  value={headerBorderColor}
                  onChange={(event) => setHeaderBorderColor(event.target.value)}
                />
              </label>
            </div>

            <div className="theme-editor-section-label">Chat panel</div>
            <div className="theme-editor-grid theme-editor-grid--text">
              <label className="theme-editor-field theme-editor-field--wide">
                <span>Panel title</span>
                <input
                  value={chatPanelTitle}
                  onChange={(event) => setChatPanelTitle(event.target.value)}
                  placeholder="Chat panel title"
                />
              </label>
            </div>
            <div className="theme-editor-grid">
              <label className="theme-editor-color-field">
                <span>Background</span>
                <input
                  type="color"
                  value={chatPanelBackground}
                  onChange={(event) => setChatPanelBackground(event.target.value)}
                />
              </label>
              <label className="theme-editor-color-field">
                <span>Title + input</span>
                <input
                  type="color"
                  value={chatChromeColor}
                  onChange={(event) => setChatChromeColor(event.target.value)}
                />
              </label>
              <label className="theme-editor-color-field">
                <span>Chat</span>
                <input
                  type="color"
                  value={chatMessageColor}
                  onChange={(event) => setChatMessageColor(event.target.value)}
                />
              </label>
              <label className="theme-editor-color-field">
                <span>Border</span>
                <input
                  type="color"
                  value={chatPanelBorderColor}
                  onChange={(event) => setChatPanelBorderColor(event.target.value)}
                />
              </label>
            </div>
          </div>
          <calcite-button
            slot="footer-start"
            appearance="outline"
            kind="neutral"
            onClick={handleCancelThemeEditor}
          >
            Cancel
          </calcite-button>
          <calcite-button
            slot="footer-end"
            appearance="solid"
            kind="brand"
            onClick={handleCloseThemeEditor}
          >
            Done
          </calcite-button>
        </calcite-dialog>
      )}

      {showNewMapDialog && (
        <calcite-dialog
          open
          overlay-positioning="fixed"
          heading="Create New Web Map"
          width-scale="m"
          onCalciteDialogClose={() => setShowNewMapDialog(false)}
        >
          <div className="new-map-dialog">
            <div className="new-map-dialog__intro">
              This saves the map to ArcGIS Online first so the assistant can work with a real WebMap item.
            </div>
            {isNewMapMetadataBusy && (
              <div className="new-map-dialog__helper-text">
                Loading ArcGIS Online folders, categories, and tags...
              </div>
            )}
            <div className="new-map-dialog__grid">
              <label className="new-map-dialog__field new-map-dialog__field--wide">
                <span>Title</span>
                <input
                  value={newMapDraft.title}
                  onChange={(event) =>
                    setNewMapDraft((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="New Map"
                />
              </label>
              <label className="new-map-dialog__field new-map-dialog__field--wide">
                <span>Folder</span>
                <calcite-combobox
                  selection-mode="single"
                  selection-display="single"
                  allow-custom-values
                  placeholder="Choose a folder or type a new folder"
                  onCalciteComboboxChange={handleNewMapFolderChange}
                >
                  <calcite-combobox-item
                    value={ROOT_FOLDER_OPTION}
                    heading="Root folder"
                    selected={calciteBool(newMapDraft.folderChoice === ROOT_FOLDER_OPTION)}
                  ></calcite-combobox-item>
                  <calcite-combobox-item-group label="Folders">
                    {newMapFolders.map((folder) => (
                      <calcite-combobox-item
                        key={folder.id}
                        value={folder.id}
                        heading={folder.title}
                        selected={calciteBool(newMapDraft.folderChoice === folder.id)}
                      ></calcite-combobox-item>
                    ))}
                  </calcite-combobox-item-group>
                  {newMapDraft.folderChoice === CREATE_NEW_FOLDER_OPTION && newMapDraft.newFolderName.trim() && (
                    <calcite-combobox-item
                      value={newMapDraft.newFolderName.trim()}
                      heading={newMapDraft.newFolderName.trim()}
                      selected
                    ></calcite-combobox-item>
                  )}
                </calcite-combobox>
                <div className="new-map-dialog__helper-text">
                  Type a new folder name directly in the folder picker to create it.
                </div>
              </label>
              <label className="new-map-dialog__field new-map-dialog__field--wide new-map-dialog__field--category">
                <span>Search categories</span>
                <calcite-combobox
                  selection-mode="multiple"
                  selection-display="fit"
                  placeholder="Search categories"
                  onCalciteComboboxChange={handleNewMapCategoryChange}
                >
                  <calcite-combobox-item-group label="Organization categories">
                    {renderCategoryComboboxItems(categoryTree, newMapDraft.selectedCategories)}
                  </calcite-combobox-item-group>
                </calcite-combobox>
                <div className="new-map-dialog__helper-text">
                  {newMapCategoryOptions.length
                    ? "Search and select one or more organization categories."
                    : "No organization categories were found."}
                </div>
                {newMapDraft.selectedCategories.length > 0 && (
                  <div className="new-map-dialog__selection-list">
                    {newMapDraft.selectedCategories.map((category) => (
                      <button
                        key={category}
                        type="button"
                        className="new-map-dialog__selection-chip"
                        title={newMapCategoryOptions.find((option) => option.value === category)?.label || category}
                        onClick={() => handleNewMapCategoryRemove(category)}
                      >
                        {getCategoryLeafLabel(category, newMapCategoryOptions)}
                      </button>
                    ))}
                  </div>
                )}
              </label>
              <label className="new-map-dialog__field new-map-dialog__field--wide">
                <span>Tags</span>
                <calcite-combobox
                  selection-mode="multiple"
                  selection-display="fit"
                  allow-custom-values
                  placeholder="Choose or add tags"
                  onCalciteComboboxChange={handleNewMapTagChange}
                >
                  <calcite-combobox-item-group label="Suggested tags">
                    {newMapTagOptions.map((entry) => (
                      <calcite-combobox-item
                        key={entry.tag}
                        value={entry.tag}
                        heading={entry.tag}
                        selected={calciteBool(newMapDraft.selectedTags.includes(entry.tag))}
                      ></calcite-combobox-item>
                    ))}
                  </calcite-combobox-item-group>
                </calcite-combobox>
                {newMapDraft.selectedTags.length > 0 && (
                  <div className="new-map-dialog__selection-list">
                    {newMapDraft.selectedTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="new-map-dialog__selection-chip"
                        onClick={() => handleNewMapTagRemove(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </label>
              <label className="new-map-dialog__field new-map-dialog__field--wide">
                <span>Summary</span>
                <calcite-text-area
                  class="new-map-dialog__summary"
                  value={newMapDraft.summary}
                  onChange={(event: { target: { value: string } }) =>
                    setNewMapDraft((current) => ({
                      ...current,
                      summary: event.target.value.slice(0, SUMMARY_CHAR_LIMIT),
                    }))
                  }
                  placeholder="Short summary shown with the item"
                ></calcite-text-area>
                <div className="new-map-dialog__character-count">
                  {newMapDraft.summary.length}/{SUMMARY_CHAR_LIMIT}
                </div>
              </label>
            </div>
            {newMapDialogError && <div className="new-map-dialog__error">{newMapDialogError}</div>}
          </div>
          <calcite-button
            slot="footer-start"
            appearance="outline"
            kind="neutral"
            onClick={() => setShowNewMapDialog(false)}
          >
            Cancel
          </calcite-button>
          <calcite-button
            slot="footer-end"
            appearance="solid"
            kind="brand"
            disabled={calciteBool(isNewMapCreateBusy || !newMapDraft.title.trim())}
            onClick={() => void handleCreateNewMap()}
          >
            {isNewMapCreateBusy ? "Creating..." : "Create map"}
          </calcite-button>
        </calcite-dialog>
      )}

      <HubServerManager
        open={showHubManager}
        onClose={useCallback(() => setShowHubManager(false), [])}
        onServersChange={useCallback((_servers: unknown[]) => {
          const assistant = document.querySelector("arcgis-assistant") as HTMLElement | null;
          if (assistant) void refreshMcpAgentDescription(assistant);
        }, [])}
      />

      {showChangeMapDialog && (
        <calcite-dialog
          open
          overlay-positioning="fixed"
          heading="Change Web Map"
          onCalciteDialogClose={() => setShowChangeMapDialog(false)}
        >
          <div style={{ padding: "0.75rem 0" }}>
            {webMapId && (
              <div
                style={{
                  marginBottom: "1rem",
                  padding: "0.6rem 0.75rem",
                  background: "var(--calcite-color-background, #f3f3f3)",
                  borderRadius: "4px",
                  borderLeft: "3px solid var(--calcite-color-brand, #007ac2)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.72rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--calcite-color-text-3, #6b6b6b)",
                    marginBottom: "0.2rem",
                  }}
                >
                  Current map
                </div>
                {currentMapTitle && (
                  <div
                    style={{
                      fontSize: "0.98rem",
                      fontWeight: 700,
                      color: "var(--calcite-color-text-1, #203040)",
                      lineHeight: 1.3,
                    }}
                  >
                    {currentMapTitle}
                  </div>
                )}
                <div
                  style={{
                    fontFamily: "monospace",
                    fontSize: "0.78rem",
                    color: "var(--calcite-color-text-3, #6b6b6b)",
                    marginTop: "0.15rem",
                  }}
                >
                  {webMapId}
                </div>
              </div>
            )}

            <calcite-label>
              New Web Map Item ID
              <calcite-input
                ref={changeMapDialogInputRef}
                type="text"
                placeholder="Enter web map item ID"
                value={changeMapDialogInput}
                onCalciteInputInput={(e: any) => setChangeMapDialogInput(readCalciteInputValue(e))}
                onCalciteInputChange={(e: any) => setChangeMapDialogInput(readCalciteInputValue(e))}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Enter" && changeMapDialogInput.trim()) {
                    void handleChangeMapDialogLoad();
                  }
                }}
                clearable
              />
            </calcite-label>
          </div>
          <calcite-button
            slot="footer-start"
            appearance="outline"
            kind="neutral"
            onClick={() => {
              setShowChangeMapDialog(false);
              void openNewMapDialog();
            }}
          >
            New map
          </calcite-button>
          <calcite-button
            slot="footer-start"
            appearance="outline"
            kind="neutral"
            onClick={() => setShowChangeMapDialog(false)}
          >
            Cancel
          </calcite-button>
          <calcite-button
            slot="footer-end"
            appearance="solid"
            kind="brand"
            onClick={() => void handleChangeMapDialogLoad()}
          >
            Load map
          </calcite-button>
        </calcite-dialog>
      )}
    </calcite-shell>
  );
}
