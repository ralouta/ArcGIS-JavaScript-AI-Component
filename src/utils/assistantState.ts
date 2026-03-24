export interface AssistantResultLink {
  url: string;
  label: string;
}

export interface AssistantResultField {
  label: string;
  value: string;
}

export interface AssistantResultEntity {
  kind: "point" | "country" | "region" | "extent";
  origin: "source" | "context";
  label: string;
  lat?: number;
  lon?: number;
  west?: number;
  south?: number;
  east?: number;
  north?: number;
  description?: string;
  summary?: string;
  links?: AssistantResultLink[];
  fields?: AssistantResultField[];
}

export interface AssistantGeoMemorySnapshot {
  title: string;
  responseText: string;
  entities: AssistantResultEntity[];
  updatedAt: string;
}

export interface CreatedFeatureLayerSnapshot {
  title: string;
  serviceUrl: string;
  layerUrl: string;
  geometryType: string;
  serviceItemId?: string;
  updatedAt: string;
}

interface AssistantStateShape {
  lastGeoSnapshot?: AssistantGeoMemorySnapshot;
  lastCreatedFeatureLayer?: CreatedFeatureLayerSnapshot;
}

function getAssistantState(): AssistantStateShape {
  const root = globalThis as typeof globalThis & {
    __arcgisAssistantState__?: AssistantStateShape;
  };
  if (!root.__arcgisAssistantState__) {
    root.__arcgisAssistantState__ = {};
  }
  return root.__arcgisAssistantState__;
}

export function setLastAssistantGeoSnapshot(snapshot: AssistantGeoMemorySnapshot): void {
  const state = getAssistantState();
  state.lastGeoSnapshot = snapshot;
}

export function getLastAssistantGeoSnapshot(): AssistantGeoMemorySnapshot | null {
  return getAssistantState().lastGeoSnapshot ?? null;
}

export function clearLastAssistantGeoSnapshot(): void {
  delete getAssistantState().lastGeoSnapshot;
}

export function setLastCreatedFeatureLayer(snapshot: CreatedFeatureLayerSnapshot): void {
  const state = getAssistantState();
  state.lastCreatedFeatureLayer = snapshot;
}

export function getLastCreatedFeatureLayer(): CreatedFeatureLayerSnapshot | null {
  return getAssistantState().lastCreatedFeatureLayer ?? null;
}