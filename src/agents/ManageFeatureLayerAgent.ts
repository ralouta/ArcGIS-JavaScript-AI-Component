import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import {
  addPointFeaturesToLayer,
  buildPointFeatureDraftsFromMemory,
  deleteFeaturesByName,
  PointFeatureDraft,
  updateFeaturesByName,
  upsertPointFeaturesByName,
} from "../utils/featureLayerEdits";
import {
  getLastAssistantGeoSnapshot,
  getLastCreatedFeatureLayer,
} from "../utils/assistantState";

type EditAction = "add" | "update" | "delete" | null;

function extractLastUserText(state: any): string {
  const rawMessages = Array.isArray(state?.messages) ? state.messages : [];
  const messages = rawMessages.length > 0 && Array.isArray(rawMessages[0]) ? rawMessages.flat() : rawMessages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (typeof message.lc_kwargs?.content === "string") return message.lc_kwargs.content.trim();
    if (typeof message.kwargs?.content === "string") return message.kwargs.content.trim();
    if (typeof message.content === "string") return message.content.trim();
  }

  return "";
}

function detectAction(text: string): EditAction {
  if (/\b(delete|remove)\b/i.test(text)) return "delete";
  if (/\b(update|edit|modify)\b/i.test(text)) return "update";
  if (/\b(add|append|insert|load|sync)\b/i.test(text)) return "add";
  return null;
}

function wantsMemoryFeatures(text: string): boolean {
  return /\b(?:in memory|from memory|current results|latest results|last results|returned by the agent|returned by the assistant|these results|those results|loaded data|current map data|data in the map|data on the map|results in the map|results on the map|use the data in the map|use data from the map|using .* data in the map|using .* data on the map)\b/i.test(text);
}

function extractServiceUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+\/FeatureServer(?:\/\d+)?/i);
  return match ? match[0].replace(/[),.]+$/, "") : null;
}

function extractFeatureName(text: string): string | null {
  const explicit = text.match(/\b(?:named|called|feature)\s+["']([^"']+)["']/i);
  if (explicit?.[1]?.trim()) return explicit[1].trim();
  const fallback = text.match(/\b(?:named|called)\s+([A-Za-z0-9 _-]{2,80})/i);
  return fallback?.[1]?.trim() || null;
}

function extractAttributeAssignments(text: string): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const regex = /\bset\s+([A-Za-z_][A-Za-z0-9_]*)\s+to\s+([A-Za-z0-9_ .:-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const field = match[1].trim();
    const rawValue = match[2].trim().replace(/[.,;]+$/, "");
    const numberValue = Number(rawValue);
    attributes[field] = !isNaN(numberValue) && rawValue !== "" ? numberValue : rawValue;
  }
  return attributes;
}

function extractCoordinates(text: string): { latitude: number; longitude: number } | null {
  const coordPatterns = [
    /\b(?:lat(?:itude)?\s*[:=]?\s*)(-?\d{1,3}(?:\.\d+)?)\s*[, ]+\s*(?:lon(?:gitude)?\s*[:=]?\s*)(-?\d{1,3}(?:\.\d+)?)/i,
    /\b(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\b/,
  ];
  for (const pattern of coordPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (!isNaN(latitude) && !isNaN(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude };
    }
  }
  return null;
}

function buildManualDraft(text: string): PointFeatureDraft | null {
  const coordinates = extractCoordinates(text);
  if (!coordinates) return null;
  const name = extractFeatureName(text) || `Feature ${coordinates.latitude.toFixed(4)}, ${coordinates.longitude.toFixed(4)}`;
  const attributes = {
    Name: name,
    Category: "point",
    Origin: "manual",
    ...extractAttributeAssignments(text),
  };

  return {
    geometry: { type: "point", latitude: coordinates.latitude, longitude: coordinates.longitude },
    attributes,
  };
}

export function registerManageFeatureLayerAgent(assistant: HTMLElement) {
  const agentId = "manage-feature-layer-agent";

  const createGraph = () => {
    const state = ANNOTATION.Root({
      messages: ANNOTATION({ reducer: (cur: any[] = [], update: any) => [...cur, update], default: () => [] }),
      outputMessage: ANNOTATION({
        reducer: (current: string = "", update: any) =>
          typeof update === "string" && update.trim()
            ? current
              ? `${current}\n\n${update}`
              : update
            : current,
        default: () => "",
      }),
    });

    async function performEditNode(s: any) {
      const text = extractLastUserText(s);
      const action = detectAction(text);
      const explicitLayerUrl = extractServiceUrl(text);
      const lastCreatedLayer = getLastCreatedFeatureLayer();
      const layerUrl = explicitLayerUrl || lastCreatedLayer?.layerUrl || null;
      const useMemory = wantsMemoryFeatures(text);

      if (!action) {
        return { outputMessage: "I need an edit action: add, update, or delete." };
      }
      if (!layerUrl) {
        return { outputMessage: "No target feature layer was provided and there is no recently created layer in memory. Provide a FeatureServer URL or create a layer first." };
      }

      if (action === "add") {
        if (useMemory) {
          const drafts = await buildPointFeatureDraftsFromMemory(getLastAssistantGeoSnapshot());
          const result = /\b(sync|upsert|update)\b/i.test(text)
            ? await upsertPointFeaturesByName(layerUrl, drafts)
            : await addPointFeaturesToLayer(layerUrl, drafts);
          return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
        }

        const manualDraft = buildManualDraft(text);
        if (!manualDraft) {
          return { outputMessage: "For manual adds, provide coordinates such as lat 33.8881 lon 35.5040 and optionally a name." };
        }
        const result = await addPointFeaturesToLayer(layerUrl, [manualDraft]);
        return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
      }

      if (action === "delete") {
        if (useMemory) {
          const drafts = await buildPointFeatureDraftsFromMemory(getLastAssistantGeoSnapshot());
          let deletedCount = 0;
          const messages: string[] = [];
          for (const draft of drafts) {
            const name = String(draft.attributes.Name ?? "").trim();
            if (!name) continue;
            const result = await deleteFeaturesByName(layerUrl, name);
            deletedCount += result.deletedCount ?? 0;
            if (result.success) messages.push(result.message);
          }
          return { outputMessage: deletedCount ? `${messages.join("\n")}\nTarget layer: ${layerUrl}` : `No matching memory features were deleted from ${layerUrl}.` };
        }

        const featureName = extractFeatureName(text);
        if (!featureName) {
          return { outputMessage: "For deletes, specify the feature name, for example: delete feature named Beirut." };
        }
        const result = await deleteFeaturesByName(layerUrl, featureName);
        return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
      }

      if (useMemory) {
        const drafts = await buildPointFeatureDraftsFromMemory(getLastAssistantGeoSnapshot());
        const result = await upsertPointFeaturesByName(layerUrl, drafts);
        return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
      }

      const featureName = extractFeatureName(text);
      const attributes = extractAttributeAssignments(text);
      if (!featureName || !Object.keys(attributes).length) {
        return { outputMessage: "For updates, specify the feature name and at least one field assignment, for example: update feature named Beirut set Status to Active." };
      }
      const result = await updateFeaturesByName(layerUrl, featureName, attributes);
      return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
    }

    return new StateGraph(state)
      .addNode("performEditNode", performEditNode)
      .addEdge(START, "performEditNode")
      .addEdge("performEditNode", END);
  };

  const agent = {
    id: agentId,
    name: "Manage Feature Layer Features",
    description:
      "Adds, updates, deletes, or syncs features in a hosted feature layer. It can operate on the latest created layer automatically and can use the latest assistant results currently in memory.",
    createGraph,
    workspace: {},
  } as any;

  const existing = assistant.querySelector(`[data-agent-id="${agentId}"]`);
  if (existing) existing.remove();

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", agentId);
  agentEl.agent = agent;
  assistant.appendChild(agentEl);
}