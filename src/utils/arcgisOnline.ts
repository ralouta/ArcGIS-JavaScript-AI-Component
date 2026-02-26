// Utility functions for ArcGIS Online OAuth and creating hosted feature services
import esriConfig from "@arcgis/core/config";
import IdentityManager from "@arcgis/core/identity/IdentityManager";
import OAuthInfo from "@arcgis/core/identity/OAuthInfo";

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

function resolveLayerUrl(operationalLayer: any): string | null {
  const directUrl = safeString(operationalLayer?.url);
  if (directUrl) return directUrl;

  const itemUrl = safeString(operationalLayer?.item?.url);
  if (!itemUrl) return null;

  const layerId =
    typeof operationalLayer?.layerId === "number"
      ? operationalLayer.layerId
      : typeof operationalLayer?.id === "number"
      ? operationalLayer.id
      : null;

  if (layerId === null) return itemUrl;
  return `${itemUrl.replace(/\/+$/, "")}/${layerId}`;
}

function shouldEmbedLayer(operationalLayer: any): boolean {
  const layerType = safeString(operationalLayer?.layerType).toLowerCase();
  const url = safeString(operationalLayer?.url).toLowerCase();
  return (
    layerType.includes("feature") ||
    url.includes("/featureserver/") ||
    url.includes("/mapserver/")
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
  const candidateLayers = operationalLayers.filter(shouldEmbedLayer);

  const layerRecords: LayerEmbeddingRecord[] = [];
  const embeddingInputs: string[] = [];
  const embeddingTargetIndex: Array<{ layerIndex: number; fieldIndex: number | null }> = [];

  for (const operationalLayer of candidateLayers) {
    const layerUrl = resolveLayerUrl(operationalLayer);
    if (!layerUrl) continue;

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
