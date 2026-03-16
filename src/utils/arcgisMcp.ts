type ArcgisMcpBaseUrl = string;

export interface ArcgisMcpLayerMatch {
  name: string;
  url: string;
  item_title?: string;
}

export interface ArcgisMcpContentMatch {
  title: string;
  item_id: string;
  type: string;
}

interface ArcgisMcpLayerSearchResponse {
  keyword?: string;
  count?: number;
  matches?: ArcgisMcpLayerMatch[];
}

interface ArcgisMcpContentSearchResponse {
  keyword?: string;
  count?: number;
  matches?: ArcgisMcpContentMatch[];
}

export interface ArcgisMcpFeatureTable {
  service_url: string;
  sample_size: number;
  fields: string[];
  rows: Array<Record<string, unknown>>;
  csv: string;
}

export interface ArcgisMcpFieldSummary {
  field: string;
  type: string;
  total_features: number;
  null_count: number;
  null_percentage: number;
  unique_values: number;
  top_values: Array<{ value: unknown; count: number; percentage: number }>;
  statistics: Record<string, unknown>;
  message?: string;
}

export interface ArcgisMcpHealth {
  [key: string]: unknown;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildUrl(baseUrl: ArcgisMcpBaseUrl, path: string, params?: Record<string, string>): string {
  const url = new URL(`${trimTrailingSlash(baseUrl)}${path}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

function normalizeArrayResponse<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value as T[];
    }
  }

  return [];
}

export function resolveArcgisMcpBaseUrl(): string {
  const configured = (import.meta.env.VITE_ARCGIS_MCP_BASE_URL as string | undefined)?.trim();
  return configured || "/api/arcgis-mcp";
}

export async function getArcgisMcpHealth(baseUrl = resolveArcgisMcpBaseUrl()): Promise<ArcgisMcpHealth> {
  return fetchJson<ArcgisMcpHealth>(buildUrl(baseUrl, "/health"));
}

export async function searchArcgisMcpLayers(
  keyword: string,
  baseUrl = resolveArcgisMcpBaseUrl()
): Promise<ArcgisMcpLayerMatch[]> {
  const response = await fetchJson<ArcgisMcpLayerSearchResponse | ArcgisMcpLayerMatch[]>(
    buildUrl(baseUrl, "/api/search/layers", { keyword })
  );

  return normalizeArrayResponse<ArcgisMcpLayerMatch>(response, "matches");
}

export async function searchArcgisMcpContent(
  keyword: string,
  itemType: string | undefined,
  baseUrl = resolveArcgisMcpBaseUrl()
): Promise<ArcgisMcpContentMatch[]> {
  const params: Record<string, string> = { keyword };
  if (itemType) {
    params.item_type = itemType;
  }

  const response = await fetchJson<ArcgisMcpContentSearchResponse | ArcgisMcpContentMatch[]>(
    buildUrl(baseUrl, "/api/search/content", params)
  );

  return normalizeArrayResponse<ArcgisMcpContentMatch>(response, "matches");
}

export async function getArcgisMcpFeatureTable(
  serviceUrl: string,
  baseUrl = resolveArcgisMcpBaseUrl()
): Promise<ArcgisMcpFeatureTable> {
  return fetchJson<ArcgisMcpFeatureTable>(
    buildUrl(baseUrl, "/api/feature-table", { service_url: serviceUrl })
  );
}

export async function summarizeArcgisMcpField(
  serviceUrl: string,
  fieldName: string,
  baseUrl = resolveArcgisMcpBaseUrl()
): Promise<ArcgisMcpFieldSummary> {
  return fetchJson<ArcgisMcpFieldSummary>(
    buildUrl(baseUrl, "/api/field-summary", {
      service_url: serviceUrl,
      field_name: fieldName,
    })
  );
}