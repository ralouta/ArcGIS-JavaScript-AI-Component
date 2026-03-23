// Utility functions for ArcGIS Online OAuth and creating hosted feature services
import esriConfig from "@arcgis/core/config";
import IdentityManager from "@arcgis/core/identity/IdentityManager";
import OAuthInfo from "@arcgis/core/identity/OAuthInfo";
import Portal from "@arcgis/core/portal/Portal";

export interface CredentialInfo {
  token: string;
  username: string;
  portalUrl: string;
}

export function initializeOAuth(
  oauthClientId?: string,
  portalUrl?: string
): OAuthInfo | null {
  if (!oauthClientId) return null;

  const resolvedPortalUrl: string = portalUrl || esriConfig?.portalUrl || "https://www.arcgis.com";
  const info = new OAuthInfo({
    appId: oauthClientId,
    portalUrl: resolvedPortalUrl,
    popup: false,
  });

  IdentityManager.registerOAuthInfos([info]);
  return info;
}

/**
 * Fetch the title of an ArcGIS portal item by its item ID.
 * Returns null if the item cannot be reached or the token is missing.
 */
export async function fetchPortalItemTitle(
  portalUrl: string,
  itemId: string,
  token?: string,
): Promise<string | null> {
  if (!itemId) return null;
  try {
    const base = portalUrl.replace(/\/$/, "");
    const url = `${base}/sharing/rest/content/items/${encodeURIComponent(itemId)}?f=json${
      token ? `&token=${encodeURIComponent(token)}` : ""
    }`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.title === "string" ? json.title : null;
  } catch {
    return null;
  }
}

export async function getCredential(
  oauthClientId?: string,
  portalUrl?: string
): Promise<CredentialInfo> {
  const resolvedPortalUrl: string = portalUrl || esriConfig?.portalUrl || "https://www.arcgis.com";
  const sharingRestUrl = `${resolvedPortalUrl}/sharing/rest`;

  const asCredentialInfo = (credential: any): CredentialInfo => ({
    token: credential.token,
    username: credential.userId,
    portalUrl: resolvedPortalUrl,
  });

  const existingCredential = IdentityManager.findCredential(sharingRestUrl);
  if (existingCredential) {
    return asCredentialInfo(existingCredential);
  }

  // If an OAuth App ID is provided, perform OAuth sign-in; otherwise, rely on existing session.
  if (oauthClientId) {
    initializeOAuth(oauthClientId, resolvedPortalUrl);
    const credential = await IdentityManager.getCredential(sharingRestUrl);
    return asCredentialInfo(credential); 
  }

  throw new Error("Not signed in. Please sign in via the portal popup and try again.");
}

export interface CreateHostedFeatureServiceParams {
  portalUrl: string;
  token: string;
  username: string;
  serviceName: string;
  layerName?: string;
  geometryType?: "esriGeometryPoint" | "esriGeometryPolyline" | "esriGeometryPolygon";
  fields?: Array<{ name: string; type: string; alias?: string; length?: number }>;
}

export interface CreateHostedFeatureServiceResult {
  success: boolean;
  message: string;
  serviceItemId?: string;
  serviceUrl?: string;
}

const WEBMAP_EMBEDDINGS_RESOURCE = "embeddings-v01.json";
const EMBEDDINGS_MODEL = "text-embedding-ada-002";

export interface WebMapEmbeddingsStatusResult {
  exists: boolean;
  owner?: string;
  ownerFolder?: string;
}

export interface GenerateWebMapEmbeddingsResult {
  success: boolean;
  message: string;
  itemId?: string;
  layerCount?: number;
  fieldCount?: number;
}

export interface CreateWebMapItemParams {
  portalUrl: string;
  token: string;
  username: string;
  title: string;
  text: Record<string, any>;
  folderId?: string;
  snippet?: string;
  description?: string;
  tags?: string[];
  categories?: string[];
}

export interface CreateWebMapItemResult {
  success: boolean;
  message: string;
  itemId?: string;
}

export interface UpdateWebMapItemParams {
  portalUrl: string;
  token: string;
  username: string;
  itemId: string;
  text: Record<string, any>;
  title?: string;
  snippet?: string;
  description?: string;
  tags?: string[];
}

export interface PortalItemMutationResult {
  success: boolean;
  message: string;
}

export interface UserFolderInfo {
  id: string;
  title: string;
}

export interface PortalCategoryOption {
  value: string;
  label: string;
}

export interface PortalTagInfo {
  tag: string;
  count: number;
}

interface PortalCategoryNode {
  title?: string;
  categories?: PortalCategoryNode[];
}

interface LayerEmbeddingRecord {
  id: string;
  name: string;
  title: string;
  description: string;
  vector: number[];
  fields: Array<{
    name: string;
    alias: string;
    description: string;
    vector: number[];
  }>;
}

interface FlattenedOperationalLayer {
  id?: string | number;
  layerId?: string | number;
  sublayerId?: string | number;
  url?: string;
  item?: {
    url?: string;
  };
  layerType?: string;
  title?: string;
  description?: string;
  layers?: FlattenedOperationalLayer[];
  featureCollection?: {
    layers?: FlattenedOperationalLayer[];
  };
  __serviceUrl?: string;
  __itemUrl?: string;
  [key: string]: any;
}

function buildUserItemUrl(
  portalUrl: string,
  owner: string,
  ownerFolder: string | undefined,
  itemId: string,
  operation: "resources" | "addResources" | "removeResources"
): string {
  const folderPath = ownerFolder ? `/${encodeURIComponent(ownerFolder)}` : "";
  return `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(owner)}${folderPath}/items/${encodeURIComponent(itemId)}/${operation}`;
}

function buildUserRootContentUrl(portalUrl: string, owner: string, operation: "addItem") {
  return `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(owner)}/${operation}`;
}

function buildUserFolderContentUrl(
  portalUrl: string,
  owner: string,
  folderId: string,
  operation: "addItem"
) {
  return `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(owner)}/${encodeURIComponent(folderId)}/${operation}`;
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = await response.json();
  return json as T;
}

function decodeBase64ToFloat32Vector(base64: string): number[] {
  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  const floatValues = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  return Array.from(floatValues);
}

async function getItemInfo(portalUrl: string, token: string, itemId: string): Promise<any> {
  const url = `${portalUrl}/sharing/rest/content/items/${encodeURIComponent(itemId)}?f=json&token=${encodeURIComponent(token)}`;
  return fetchJson(url);
}

async function listItemResources(
  portalUrl: string,
  token: string,
  owner: string,
  ownerFolder: string | undefined,
  itemId: string
): Promise<any> {
  const url = `${buildUserItemUrl(portalUrl, owner, ownerFolder, itemId, "resources")}?f=json&token=${encodeURIComponent(token)}`;
  return fetchJson(url);
}

function safeString(value: any): string {
  return typeof value === "string" ? value : "";
}

function normalizePortalUrl(portalUrl: string): string {
  return portalUrl.replace(/\/$/, "");
}

function flattenCategoryNodes(
  nodes: PortalCategoryNode[],
  parentPath: string[] = [],
  options: PortalCategoryOption[] = []
): PortalCategoryOption[] {
  for (const node of nodes) {
    const title = safeString(node?.title).trim();
    if (!title) continue;

    const pathSegments = [...parentPath, title];
    options.push({
      value: `/${pathSegments.join("/")}`,
      label: pathSegments.join(" > "),
    });

    if (Array.isArray(node?.categories) && node.categories.length) {
      flattenCategoryNodes(node.categories, pathSegments, options);
    }
  }

  return options;
}

function normalizeServiceUrl(value: any): string {
  return safeString(value).trim().replace(/\?.*$/, "").replace(/\/+$/, "");
}

function extractLayerId(operationalLayer: FlattenedOperationalLayer): number | null {
  const candidates = [operationalLayer?.layerId, operationalLayer?.sublayerId, operationalLayer?.id];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
      return Number(candidate);
    }
  }

  return null;
}

function isConcreteServiceLayerUrl(url: string): boolean {
  return /\/(?:FeatureServer|MapServer)\/\d+$/i.test(url);
}

function isServiceRootUrl(url: string): boolean {
  return /\/(?:FeatureServer|MapServer)$/i.test(url);
}

function resolveConcreteServiceUrl(serviceUrl: string, layerId: number | null): string | null {
  const normalizedUrl = normalizeServiceUrl(serviceUrl);
  if (!normalizedUrl) return null;
  if (isConcreteServiceLayerUrl(normalizedUrl)) return normalizedUrl;
  if (layerId !== null && isServiceRootUrl(normalizedUrl)) {
    return `${normalizedUrl}/${layerId}`;
  }
  return null;
}

function flattenOperationalLayers(
  operationalLayers: FlattenedOperationalLayer[]
): FlattenedOperationalLayer[] {
  const flattened: FlattenedOperationalLayer[] = [];

  const visit = (
    layer: FlattenedOperationalLayer,
    inheritedServiceUrl?: string,
    inheritedItemUrl?: string
  ) => {
    const serviceUrl = normalizeServiceUrl(layer?.url) || inheritedServiceUrl || undefined;
    const itemUrl = normalizeServiceUrl(layer?.item?.url) || inheritedItemUrl || undefined;

    flattened.push({
      ...layer,
      __serviceUrl: serviceUrl,
      __itemUrl: itemUrl,
    });

    const nestedLayers = [
      ...(Array.isArray(layer?.layers) ? layer.layers : []),
      ...(Array.isArray(layer?.featureCollection?.layers) ? layer.featureCollection.layers : []),
    ];

    for (const nestedLayer of nestedLayers) {
      visit(nestedLayer, serviceUrl || itemUrl, itemUrl || serviceUrl);
    }
  };

  for (const operationalLayer of operationalLayers) {
    visit(operationalLayer);
  }

  return flattened;
}

function resolveLayerUrl(operationalLayer: FlattenedOperationalLayer): string | null {
  const layerId = extractLayerId(operationalLayer);
  const directUrl = resolveConcreteServiceUrl(
    safeString(operationalLayer?.url) || safeString(operationalLayer?.__serviceUrl),
    layerId
  );
  if (directUrl) return directUrl;

  return resolveConcreteServiceUrl(
    safeString(operationalLayer?.item?.url) || safeString(operationalLayer?.__itemUrl),
    layerId
  );
}

function shouldEmbedLayer(operationalLayer: FlattenedOperationalLayer): boolean {
  const layerType = safeString(operationalLayer?.layerType).toLowerCase();
  const url = normalizeServiceUrl(
    operationalLayer?.url || operationalLayer?.__serviceUrl || operationalLayer?.item?.url || operationalLayer?.__itemUrl
  ).toLowerCase();

  if (
    layerType.includes("group") ||
    layerType.includes("tile") ||
    layerType.includes("vector") ||
    layerType.includes("scene") ||
    layerType.includes("imagery")
  ) {
    return false;
  }

  return (
    isConcreteServiceLayerUrl(url) ||
    isServiceRootUrl(url) ||
    layerType.includes("feature") ||
    layerType.includes("map service") ||
    layerType.includes("mapimage") ||
    layerType.includes("map-image") ||
    layerType.includes("subtype")
  );
}

export async function getWebMapEmbeddingsStatus(
  portalUrl: string,
  token: string,
  webMapItemId: string
): Promise<WebMapEmbeddingsStatusResult> {
  const itemInfo = await getItemInfo(portalUrl, token, webMapItemId);

  if (itemInfo?.error) {
    const message = itemInfo?.error?.message || "Failed to retrieve WebMap item details.";
    throw new Error(message);
  }

  const owner = safeString(itemInfo?.owner);
  const ownerFolder = safeString(itemInfo?.ownerFolder) || undefined;
  if (!owner) {
    throw new Error("Unable to resolve WebMap owner.");
  }

  const resourcesJson = await listItemResources(portalUrl, token, owner, ownerFolder, webMapItemId);
  if (resourcesJson?.error) {
    const message = resourcesJson?.error?.message || "Failed to list WebMap resources.";
    throw new Error(message);
  }

  const resources = Array.isArray(resourcesJson?.resources) ? resourcesJson.resources : [];
  const exists = resources.some((resource: any) => safeString(resource?.resource) === WEBMAP_EMBEDDINGS_RESOURCE);

  return {
    exists,
    owner,
    ownerFolder,
  };
}

export async function createWebMapItem(
  params: CreateWebMapItemParams
): Promise<CreateWebMapItemResult> {
  const { portalUrl, token, username, title, text, folderId, snippet, description, tags, categories } = params;
  const url = folderId?.trim()
    ? buildUserFolderContentUrl(portalUrl, username, folderId.trim(), "addItem")
    : buildUserRootContentUrl(portalUrl, username, "addItem");
  const body = new URLSearchParams({
    f: "json",
    token,
    title,
    type: "Web Map",
    text: JSON.stringify(text),
  });

  if (snippet?.trim()) body.set("snippet", snippet.trim());
  if (description?.trim()) body.set("description", description.trim());
  if (tags?.length) body.set("tags", tags.join(","));
  if (categories?.length) body.set("categories", categories.join(","));

  const json = await fetchJson<any>(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (json?.error) {
    return { success: false, message: json.error?.message || "Failed to create WebMap item." };
  }

  const itemId = safeString(json?.id || json?.itemId);
  if (!itemId) {
    return { success: false, message: "WebMap item creation completed without returning an item id." };
  }

  return { success: true, message: "WebMap item created.", itemId };
}

export async function listUserFolders(params: {
  portalUrl: string;
  token: string;
  username: string;
}): Promise<UserFolderInfo[]> {
  const { portalUrl, token, username } = params;
  const url = `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(username)}?f=json&token=${encodeURIComponent(token)}`;
  const json = await fetchJson<any>(url);

  if (json?.error) {
    throw new Error(json?.error?.message || "Failed to load folders.");
  }

  const folders = Array.isArray(json?.folders) ? json.folders : [];
  return folders
    .map((folder: any) => ({
      id: safeString(folder?.id),
      title: safeString(folder?.title),
    }))
    .filter((folder: UserFolderInfo) => Boolean(folder.id && folder.title));
}

export async function createUserFolder(params: {
  portalUrl: string;
  token: string;
  username: string;
  title: string;
}): Promise<UserFolderInfo> {
  const { portalUrl, token, username, title } = params;
  const url = `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(username)}/createFolder`;
  const body = new URLSearchParams({
    f: "json",
    token,
    title,
  });

  const json = await fetchJson<any>(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (json?.error) {
    throw new Error(json?.error?.message || "Failed to create folder.");
  }

  const folder = json?.folder;
  const folderId = safeString(folder?.id);
  const folderTitle = safeString(folder?.title) || title.trim();

  if (!folderId) {
    throw new Error("Folder creation completed without returning a folder id.");
  }

  return {
    id: folderId,
    title: folderTitle,
  };
}

export async function listPortalCategoryOptions(params: {
  portalUrl: string;
}): Promise<PortalCategoryOption[]> {
  const portal = new Portal({
    url: normalizePortalUrl(params.portalUrl),
  });

  await portal.load();
  if (!portal.hasCategorySchema) {
    return [];
  }

  const schema = await portal.fetchCategorySchema();
  const options = Array.isArray(schema)
    ? schema.flatMap((entry: any) => {
        const rootTitle = safeString(entry?.title).trim();
        const categories = Array.isArray(entry?.categories) ? entry.categories : [];
        if (!rootTitle || !categories.length) {
          return [];
        }
        return flattenCategoryNodes(categories, [rootTitle]);
      })
    : [];

  return options.sort((left, right) => left.label.localeCompare(right.label));
}

export async function listUserTags(params: {
  portalUrl: string;
}): Promise<PortalTagInfo[]> {
  const portal = new Portal({
    url: normalizePortalUrl(params.portalUrl),
  });

  await portal.load();
  if (!portal.user) {
    return [];
  }

  const tags = await portal.user.fetchTags();
  return tags
    .map((entry) => ({
      tag: safeString(entry?.tag).trim(),
      count: typeof entry?.count === "number" ? entry.count : 0,
    }))
    .filter((entry) => Boolean(entry.tag))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

export async function updateWebMapItem(
  params: UpdateWebMapItemParams
): Promise<PortalItemMutationResult> {
  const { portalUrl, token, username, itemId, text, title, snippet, description, tags } = params;
  const url = `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(username)}/items/${encodeURIComponent(itemId)}/update`;
  const body = new URLSearchParams({
    f: "json",
    token,
    text: JSON.stringify(text),
  });

  if (title?.trim()) body.set("title", title.trim());
  if (snippet?.trim()) body.set("snippet", snippet.trim());
  if (description?.trim()) body.set("description", description.trim());
  if (tags?.length) body.set("tags", tags.join(","));

  const json = await fetchJson<any>(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (json?.error || json?.success === false) {
    return { success: false, message: json?.error?.message || "Failed to update WebMap item." };
  }

  return { success: true, message: "WebMap item updated." };
}

export async function deletePortalItem(params: {
  portalUrl: string;
  token: string;
  username: string;
  itemId: string;
  keepalive?: boolean;
}): Promise<PortalItemMutationResult> {
  const { portalUrl, token, username, itemId, keepalive = false } = params;
  const url = `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(username)}/items/${encodeURIComponent(itemId)}/delete`;
  const body = new URLSearchParams({
    f: "json",
    token,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    keepalive,
  });
  const json = await response.json();

  if (!response.ok || json?.error || json?.success === false) {
    return { success: false, message: json?.error?.message || "Failed to delete portal item." };
  }

  return { success: true, message: "Portal item deleted." };
}

export async function generateAndSaveWebMapEmbeddings(params: {
  portalUrl: string;
  token: string;
  webMapItemId: string;
  removeExisting?: boolean;
}): Promise<GenerateWebMapEmbeddingsResult> {
  const { portalUrl, token, webMapItemId, removeExisting = true } = params;

  const itemInfo = await getItemInfo(portalUrl, token, webMapItemId);
  if (itemInfo?.error) {
    const message = itemInfo?.error?.message || "Failed to retrieve WebMap item details.";
    return { success: false, message };
  }

  const owner = safeString(itemInfo?.owner);
  const ownerFolder = safeString(itemInfo?.ownerFolder) || undefined;
  if (!owner) {
    return { success: false, message: "Unable to resolve WebMap owner." };
  }

  const webMapDataUrl = `${portalUrl}/sharing/rest/content/items/${encodeURIComponent(webMapItemId)}/data?f=json&token=${encodeURIComponent(token)}`;
  const webMapData = await fetchJson<any>(webMapDataUrl);
  if (webMapData?.error) {
    const message = webMapData?.error?.message || "Failed to load WebMap data.";
    return { success: false, message };
  }

  const operationalLayers = Array.isArray(webMapData?.operationalLayers) ? webMapData.operationalLayers : [];
  const flattenedLayers = flattenOperationalLayers(operationalLayers);
  const candidateLayers = flattenedLayers.filter(shouldEmbedLayer);
  const processedLayerUrls = new Set<string>();

  const layerRecords: LayerEmbeddingRecord[] = [];
  const embeddingInputs: string[] = [];
  const embeddingTargetIndex: Array<{ layerIndex: number; fieldIndex: number | null }> = [];

  for (const operationalLayer of candidateLayers) {
    const layerUrl = resolveLayerUrl(operationalLayer);
    if (!layerUrl) continue;
    if (processedLayerUrls.has(layerUrl)) continue;
    processedLayerUrls.add(layerUrl);

    const layerInfoUrl = `${layerUrl}${layerUrl.includes("?") ? "&" : "?"}f=json&token=${encodeURIComponent(token)}`;
    const layerInfo = await fetchJson<any>(layerInfoUrl);
    if (layerInfo?.error) continue;

    const layerName = safeString(layerInfo?.name) || safeString(operationalLayer?.id) || "Layer";
    const layerTitle = safeString(operationalLayer?.title) || safeString(layerInfo?.name) || safeString(itemInfo?.title);
    const layerDescription = safeString(layerInfo?.description) || safeString(operationalLayer?.description);

    const layerRecord: LayerEmbeddingRecord = {
      id: safeString(operationalLayer?.id) || layerName,
      name: layerName,
      title: layerTitle,
      description: layerDescription,
      vector: [],
      fields: [],
    };

    const layerInput = `Name: ${layerRecord.name} Title: ${layerRecord.title} Description: ${layerRecord.description}`;
    embeddingInputs.push(layerInput);
    embeddingTargetIndex.push({ layerIndex: layerRecords.length, fieldIndex: null });

    const fields = Array.isArray(layerInfo?.fields) ? layerInfo.fields : [];
    for (const field of fields) {
      const fieldName = safeString(field?.name);
      if (!fieldName) continue;

      const fieldAlias = safeString(field?.alias);
      const fieldDescription = safeString(field?.description);
      const fieldEntry = {
        name: fieldName,
        alias: fieldAlias,
        description: fieldDescription,
        vector: [] as number[],
      };
      const fieldIndex = layerRecord.fields.length;
      layerRecord.fields.push(fieldEntry);

      const fieldInput = `Name: ${fieldName} Alias: ${fieldAlias} Description: ${fieldDescription}`;
      embeddingInputs.push(fieldInput);
      embeddingTargetIndex.push({ layerIndex: layerRecords.length, fieldIndex });
    }

    layerRecords.push(layerRecord);
  }

  if (!layerRecords.length || !embeddingInputs.length) {
    return {
      success: false,
      message: "No eligible layers or fields were found to generate embeddings.",
    };
  }

  const embeddingsResponse = await fetch("https://aimodels.arcgis.com/text-embedding-ada-002/openai/v1/embeddings", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-esri-authorization": `Bearer ${token}`,
      "x-esri-request-source": "MapsSDK",
    },
    body: JSON.stringify({
      model: EMBEDDINGS_MODEL,
      input: embeddingInputs,
      encoding_format: "base64",
    }),
  });

  const embeddingsJson = await embeddingsResponse.json();
  if (!embeddingsResponse.ok || embeddingsJson?.error) {
    const message = embeddingsJson?.error?.message || "Failed to generate embeddings.";
    return { success: false, message };
  }

  const embeddingRows = Array.isArray(embeddingsJson?.data) ? embeddingsJson.data : [];
  if (embeddingRows.length !== embeddingTargetIndex.length) {
    return {
      success: false,
      message: "Embedding response size does not match the prepared input count.",
    };
  }

  for (let rowIndex = 0; rowIndex < embeddingRows.length; rowIndex++) {
    const row = embeddingRows[rowIndex];
    const target = embeddingTargetIndex[rowIndex];
    const layer = layerRecords[target.layerIndex];
    if (!layer) continue;

    const encodedEmbedding = safeString(row?.embedding);
    const vector = encodedEmbedding ? decodeBase64ToFloat32Vector(encodedEmbedding) : [];
    if (!vector.length) continue;

    if (target.fieldIndex === null) {
      layer.vector = vector;
    } else {
      const fieldEntry = layer.fields[target.fieldIndex];
      if (fieldEntry) fieldEntry.vector = vector;
    }
  }

  if (removeExisting) {
    const removeUrl = buildUserItemUrl(portalUrl, owner, ownerFolder, webMapItemId, "removeResources");
    const removeBody = new URLSearchParams({
      f: "json",
      resource: WEBMAP_EMBEDDINGS_RESOURCE,
      token,
    });

    await fetch(removeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: removeBody,
    });
  }

  const payload = {
    schemaVersion: "0.1",
    modified: Date.now(),
    embeddings: {
      modelProvider: "openai",
      model: EMBEDDINGS_MODEL,
      dimensions: 1536,
      templates: {
        layer: "Name: {name}\nTitle: {title}\nDescription: {description}",
        field: "Name: {name}\nAlias: {alias}\nDescription: {description}",
      },
    },
    layers: layerRecords,
  };

  const addUrl = buildUserItemUrl(portalUrl, owner, ownerFolder, webMapItemId, "addResources");
  const form = new FormData();
  form.append("file1", new Blob([JSON.stringify(payload)], { type: "application/json" }), WEBMAP_EMBEDDINGS_RESOURCE);
  form.append("f", "json");
  form.append("token", token);

  const addResp = await fetch(addUrl, {
    method: "POST",
    body: form,
  });
  const addJson = await addResp.json();

  if (!addResp.ok || addJson?.error || addJson?.success === false) {
    const message = addJson?.error?.message || "Failed to save embeddings resource to the WebMap item.";
    return { success: false, message };
  }

  const fieldCount = layerRecords.reduce((sum, layer) => sum + layer.fields.length, 0);
  return {
    success: true,
    message: "Embeddings generated and saved.",
    itemId: webMapItemId,
    layerCount: layerRecords.length,
    fieldCount,
  };
}

export async function searchPortalLayerByName(name: string): Promise<string | null> {
  let credential: any;
  try { credential = await getCredential(); } catch { return null; }

  const { token, portalUrl } = credential;
  const query = `title:"${name}" type:"Feature Service" owner:${credential.username}`;
  const params = new URLSearchParams({
    f: "json",
    q: query,
    num: "10",
    sortField: "modified",
    sortOrder: "desc",
    token,
  });

  try {
    const resp = await fetch(`${portalUrl}/sharing/rest/search?${params}`);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const items: any[] = Array.isArray(json?.results) ? json.results : [];
    // exact title match first, then case-insensitive
    const search = name.trim().toLowerCase();
    const supportedItems = items.filter((item) => {
      const itemUrl = typeof item?.url === "string" ? item.url.trim() : "";
      if (!itemUrl) return false;
      return /\/(?:FeatureServer)(?:\/\d+)?$/i.test(itemUrl.replace(/\?.*$/, "").replace(/\/+$/, ""));
    });
    const exact = supportedItems.find((item) => item?.title?.toLowerCase() === search);
    const item = exact ?? supportedItems.find((item) => item?.title?.toLowerCase().includes(search));
    if (!item) return null;
    // item.url is the FeatureServer root; append /0 if needed
    if (item.url) {
      const base = item.url.replace(/\/+$/, "");
      return /\/\d+$/.test(base) ? base : `${base}/0`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function createHostedFeatureService(
  params: CreateHostedFeatureServiceParams
): Promise<CreateHostedFeatureServiceResult> {
  const {
    portalUrl,
    token,
    username,
    serviceName,
    layerName = "Layer0",
    geometryType = "esriGeometryPoint",
    fields,
  } = params;

  // Only OBJECTID is always included; Name/Description only if no custom fields
  const defaultFields = [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "Name", type: "esriFieldTypeString", alias: "Name", length: 255 },
    { name: "Description", type: "esriFieldTypeString", alias: "Description", length: 1024 },
  ];
  let layerFields;
  if (fields && fields.length) {
    layerFields = [{ name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" }, ...fields];
  } else {
    layerFields = defaultFields;
  }

  const extent = {
    xmin: -180,
    ymin: -90,
    xmax: 180,
    ymax: 90,
    spatialReference: { wkid: 4326 },
  };

  // First: create an empty Feature Service item
  const serviceDefinition = {
    name: serviceName,
    serviceDescription: "Hosted feature service created by custom agent",
    hasStaticData: false,
    maxRecordCount: 2000,
    supportedQueryFormats: "JSON",
    capabilities: "Create,Delete,Query,Update,Editing",
    allowGeometryUpdates: true,
    units: "esriDecimalDegrees",
    xssPreventionInfo: {
      xssPreventionEnabled: true,
      xssPreventionRule: "InputOnly",
      xssInputRule: "rejectInvalid",
    },
  } as any;

  const url = `${portalUrl}/sharing/rest/content/users/${encodeURIComponent(
    username
  )}/createService`;

  const body = new URLSearchParams({
    f: "json",
    token,
    outputType: "featureService",
    createParameters: JSON.stringify(serviceDefinition),
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await resp.json();

  if (json && json.success) {
    const serviceUrl: string = json.serviceurl || json.serviceUrl;
    const baseServiceUrl = serviceUrl.replace(/\/\d+$/, "");
    // Second: add the layer definition to the empty service
    const layerDef = {
      name: layerName,
      type: "Feature Layer",
      geometryType,
      fields: layerFields,
      extent,
      objectIdField: "OBJECTID",
      spatialReference: { wkid: 4326 },
      displayField: "Name",
      capabilities: "Create,Delete,Query,Update,Editing",
    } as any;

    const addBody = new URLSearchParams({
      f: "json",
      token,
      addToDefinition: JSON.stringify({ layers: [layerDef] }),
    });

    const adminBaseUrl = baseServiceUrl.includes("/rest/services/")
      ? baseServiceUrl.replace("/rest/services/", "/rest/admin/services/")
      : baseServiceUrl.replace("/rest/", "/rest/admin/");

    // Try admin endpoint first (required for addToDefinition on hosted services)
    const addRespAdmin = await fetch(`${adminBaseUrl}/addToDefinition`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: addBody,
    });
    const addJsonAdmin = await addRespAdmin.json();

    if (addJsonAdmin?.success !== false && !addJsonAdmin?.error) {
      return {
        success: true,
        message: `Created hosted feature layer/service: ${serviceName}`,
        serviceItemId: json.serviceItemId,
        serviceUrl: baseServiceUrl,
      };
    }

    // Fallback to public service URL if admin fails
    const addResp = await fetch(`${baseServiceUrl}/addToDefinition`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: addBody,
    });
    const addJson = await addResp.json();

    if (addJson?.success !== false && !addJson?.error) {
      return {
        success: true,
        message: `Created hosted feature layer/service: ${serviceName}`,
        serviceItemId: json.serviceItemId,
        serviceUrl: baseServiceUrl,
      };
    }
    const adminErr = addJsonAdmin?.error?.message || JSON.stringify(addJsonAdmin);
    const publicErr = addJson?.error?.message || JSON.stringify(addJson);
    return {
      success: false,
      message: `Service created, but failed to add layer definition. Admin: ${adminErr}. Public: ${publicErr}`,
      serviceItemId: json.serviceItemId,
      serviceUrl: baseServiceUrl,
    };
  }

  const message = json?.error?.message || "Failed to create hosted feature layer/service";
  return { success: false, message };
}
