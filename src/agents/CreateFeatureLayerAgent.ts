import type { CreateHostedFeatureServiceResult } from "../utils/arcgisOnline";
import { getCredential, createHostedFeatureService } from "../utils/arcgisOnline";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import {
  addFeatureLayerToCurrentMap,
  addPointFeaturesToLayer,
  buildPointFeatureDraftsFromMemory,
  inferFieldsFromPointFeatureDrafts,
} from "../utils/featureLayerEdits";
import {
  getLastAssistantGeoSnapshot,
  setLastCreatedFeatureLayer,
} from "../utils/assistantState";

export interface CreateFeatureLayerAgentContext {
  oauthClientId?: string;
  portalUrl?: string;
  serviceName?: string;
  layerName?: string;
  geometryType?: "esriGeometryPoint" | "esriGeometryPolyline" | "esriGeometryPolygon";
  fields?: Array<{ name: string; type: string; alias?: string; length?: number }>;
  llm?: {
    invoke: (input: any) => Promise<any>;
  };
  llmSystemPrompt?: string;
}

type ExtractedIntent = {
  name?: string | null;
  geometryType?: "esriGeometryPoint" | "esriGeometryPolyline" | "esriGeometryPolygon" | null;
  fields?: Array<{ name: string; type: string; alias?: string; length?: number }> | null;
  useMemory?: boolean;
};

function normalizeGeometryType(value?: string | null): CreateFeatureLayerAgentContext["geometryType"] | null {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  if (v.includes("point")) return "esriGeometryPoint";
  if (v.includes("polyline") || v.includes("line")) return "esriGeometryPolyline";
  if (v.includes("polygon") || v.includes("area")) return "esriGeometryPolygon";
  return null;
}

function esriFieldTypeFrom(textType: string): string {
  const t = textType.toLowerCase().trim();
  if (t === "str" || t === "string" || t === "text") return "esriFieldTypeString";
  if (t === "int" || t === "integer") return "esriFieldTypeInteger";
  if (t === "float" || t === "double" || t === "number" || t === "decimal") return "esriFieldTypeDouble";
  if (t === "date" || t === "datetime") return "esriFieldTypeDate";
  if (t.includes("date")) return "esriFieldTypeDate";
  if (t.includes("int")) return "esriFieldTypeInteger";
  if (t.includes("double") || t.includes("float") || t.includes("number") || t.includes("decimal")) return "esriFieldTypeDouble";
  return "esriFieldTypeString";
}

function parseNameFallback(text: string): string | null {
  const explicitPatterns = [
    /\btitle\s+["']([^"']+)["']/i,
    /\bname\s+["']([^"']+)["']/i,
    /\bcalled\s+["']([^"']+)["']/i,
    /\bnamed\s+["']([^"']+)["']/i,
  ];
  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  const generic = text.match(/\b(?:create|make|build)\s+(?:a\s+)?(?:hosted\s+)?(?:feature\s+)?(?:layer|service)\s+(?:called|named)?\s*([A-Za-z0-9 _-]{3,80})/i);
  return generic?.[1]?.trim() || null;
}

function parseFieldsFallback(text: string): Array<{ name: string; type: string; alias?: string; length?: number }> | null {
  const match = text.match(/\bfields?\b\s*:?(.*)$/i);
  if (!match?.[1]?.trim()) return null;

  const tokens = match[1]
    .replace(/[;]+/g, ",")
    .split(",")
    .flatMap((segment) => segment.split(/\s+/))
    .map((token) => token.trim())
    .filter(Boolean);

  const fields: Array<{ name: string; type: string; alias?: string; length?: number }> = [];
  for (const token of tokens) {
    const colonIdx = token.indexOf(":");
    const parenIdx = token.indexOf("(");
    let fieldName = "";
    let fieldType = "";

    if (colonIdx > 0) {
      fieldName = token.slice(0, colonIdx).trim();
      fieldType = token.slice(colonIdx + 1).trim();
    } else if (parenIdx > 0) {
      fieldName = token.slice(0, parenIdx).trim();
      const closeParenIdx = token.indexOf(")", parenIdx);
      fieldType = closeParenIdx > parenIdx ? token.slice(parenIdx + 1, closeParenIdx).trim() : token.slice(parenIdx + 1).trim();
    }

    if (!fieldName || !fieldType) continue;
    const normalizedType = esriFieldTypeFrom(fieldType.replace(/[).;\s]+$/, ""));
    const field: { name: string; type: string; alias?: string; length?: number } = {
      name: fieldName,
      alias: fieldName,
      type: normalizedType,
    };
    if (normalizedType === "esriFieldTypeString") field.length = 255;
    fields.push(field);
  }

  return fields.length ? fields : null;
}

function wantsMemoryFeatures(text: string): boolean {
  return /\b(?:in memory|from memory|current results|latest results|last results|returned by the agent|returned by the assistant|returned data|current result|latest result|these results|those results|this data|its data|with data|populate it|seed it|loaded data|current map data|data in the map|data on the map|results in the map|results on the map|weather data in the map|use the data in the map|use data from the map|using .* data in the map|using .* data on the map)\b/i.test(text);
}

function hasFieldsIntent(text: string): boolean {
  return /\bfields?\b/i.test(text);
}

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

async function extractWithLLM(text: string, ctx: CreateFeatureLayerAgentContext): Promise<ExtractedIntent | null> {
  if (!ctx.llm) return null;
  const systemPrompt = ctx.llmSystemPrompt ||
    "You are a strict information extraction assistant. Return only valid JSON with schema {\"name\": string|null, \"geometryType\": \"point\"|\"polyline\"|\"polygon\"|null, \"fields\": [{\"name\": string, \"type\": string}]|null, \"useMemory\": boolean}.";

  try {
    const response = await ctx.llm.invoke({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    });
    const raw = typeof response === "string" ? response : response?.content || response?.text || "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const fields = Array.isArray(parsed?.fields)
      ? parsed.fields
          .filter((field: any) => field?.name && field?.type)
          .map((field: any) => {
            const type = esriFieldTypeFrom(String(field.type));
            const nextField: { name: string; type: string; alias?: string; length?: number } = {
              name: String(field.name),
              alias: String(field.name),
              type,
            };
            if (type === "esriFieldTypeString") nextField.length = 255;
            return nextField;
          })
      : null;

    return {
      name: parsed?.name || null,
      geometryType: normalizeGeometryType(parsed?.geometryType),
      fields,
      useMemory: Boolean(parsed?.useMemory),
    };
  } catch {
    return null;
  }
}

export function registerCreateFeatureLayerAgent(
  assistant: HTMLElement,
  ctx: CreateFeatureLayerAgentContext,
) {
  const agentId = "create-feature-layer-agent";

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
      result: ANNOTATION({
        reducer: (_current: any, update: CreateHostedFeatureServiceResult | null) => update ?? null,
        default: () => null,
      }),
      desiredName: ANNOTATION({ reducer: (_c: any, u: any) => (typeof u === "string" ? u : null), default: () => null }),
      desiredGeometryType: ANNOTATION({ reducer: (_c: any, u: any) => (typeof u === "string" ? u : null), default: () => null }),
      desiredFields: ANNOTATION({ reducer: (_c: any, u: any) => (Array.isArray(u) ? u : null), default: () => null }),
      fieldsRequested: ANNOTATION({ reducer: (_c: any, u: any) => Boolean(u), default: () => false }),
      useMemory: ANNOTATION({ reducer: (_c: any, u: any) => Boolean(u), default: () => false }),
    });

    async function parseRequestNode(s: any) {
      const text = extractLastUserText(s);
      const llmExtracted = text ? await extractWithLLM(text, ctx) : null;
      const desiredName = llmExtracted?.name || parseNameFallback(text) || null;
      const desiredGeometryType = llmExtracted?.geometryType || normalizeGeometryType(text) || null;
      const desiredFields = llmExtracted?.fields || parseFieldsFallback(text) || null;
      const fieldsRequested = hasFieldsIntent(text);
      const useMemory = llmExtracted?.useMemory || wantsMemoryFeatures(text);

      let message = desiredName ? `Using requested name: ${desiredName}` : "No title/name detected in your prompt.";
      if (desiredGeometryType) {
        message += `\nGeometry type detected: ${desiredGeometryType.replace("esriGeometry", "")}`;
      } else if (!ctx.geometryType) {
        message += "\nNo geometry type specified. Please reply with point, polyline, or polygon.";
      }
      if (desiredFields?.length) {
        message += `\nParsed fields: ${desiredFields.map((field) => `${field.name}:${field.type.replace("esriFieldType", "")}`).join(", ")}`;
      } else if (fieldsRequested) {
        message += "\nI detected a fields request but could not parse it. Use format like: fields name:str, status:str, count:int";
      }
      if (useMemory) {
        message += "\nWill seed the new layer with the latest assistant results currently in memory or loaded on the map.";
      }

      return {
        desiredName,
        desiredGeometryType,
        desiredFields,
        fieldsRequested,
        useMemory,
        outputMessage: message,
      };
    }

    async function createLayerNode(s: any) {
      const serviceName = s.desiredName || ctx.serviceName || null;
      const geometryType = s.desiredGeometryType || ctx.geometryType || null;
      const layerName = ctx.layerName || "Layer0";
      const memorySnapshot = s.useMemory ? getLastAssistantGeoSnapshot() : null;
      const memoryDrafts = s.useMemory ? await buildPointFeatureDraftsFromMemory(memorySnapshot) : [];
      const inferredMemoryFields = memoryDrafts.length ? inferFieldsFromPointFeatureDrafts(memoryDrafts) : [];
      const fields = s.desiredFields || ctx.fields || (inferredMemoryFields.length ? inferredMemoryFields : null);

      if (!serviceName) {
        return { outputMessage: 'Awaiting clarification: What title/name should I use for the feature layer? Example: title "Incident Results".' };
      }
      if (!geometryType) {
        return { outputMessage: "Awaiting clarification: What geometry type should I create? Reply with point, polyline, or polygon." };
      }
      if (Boolean(s.fieldsRequested) && (!fields || !fields.length)) {
        return { outputMessage: "Awaiting clarification: I couldn't parse the fields list. Provide fields like: fields status:str, observed_at:date, score:int" };
      }
      if (Boolean(s.useMemory) && !memoryDrafts.length) {
        return { outputMessage: "No assistant results with usable locations are currently in memory. Ask the MCP agent for locations first, then retry creating the layer from memory." };
      }

      try {
        const cred = await getCredential(ctx.oauthClientId, ctx.portalUrl);
        const result = await createHostedFeatureService({
          portalUrl: cred.portalUrl,
          token: cred.token,
          username: cred.username,
          serviceName,
          layerName,
          geometryType,
          fields: fields || undefined,
        });

        if (!result.success || !result.serviceUrl) {
          return { outputMessage: `Error: ${result.message}`, result };
        }

        const layerUrl = `${result.serviceUrl.replace(/\/+$/, "")}/0`;
        let seedMessage = "";
        if (memoryDrafts.length && geometryType === "esriGeometryPoint") {
          const seedResult = await addPointFeaturesToLayer(layerUrl, memoryDrafts);
          seedMessage = `\n${seedResult.message}`;
          if (!seedResult.success) {
            seedMessage += "\nThe layer was created with the inferred schema, but no features were added from memory.";
          }
        }

        await addFeatureLayerToCurrentMap(layerUrl, serviceName);
        setLastCreatedFeatureLayer({
          title: serviceName,
          serviceUrl: result.serviceUrl,
          layerUrl,
          geometryType,
          serviceItemId: result.serviceItemId,
          updatedAt: new Date().toISOString(),
        });

        const itemUrl = result.serviceItemId ? `${cred.portalUrl}/home/item.html?id=${result.serviceItemId}` : null;
        return {
          outputMessage:
            `Success: ${result.message}` +
            `\nItem ID: ${result.serviceItemId ?? "(not returned)"}` +
            (itemUrl ? `\nItem Page: ${itemUrl}` : "") +
            `\nLayer URL: ${layerUrl}` +
            `\nAdded the new layer to the active map.` +
            seedMessage,
          result,
        };
      } catch (error: any) {
        return { outputMessage: `Error creating feature service: ${error?.message || error}` };
      }
    }

    function replyNode() {
      return { outputMessage: "Create feature layer workflow completed." };
    }

    return new StateGraph(state)
      .addNode("parseRequestNode", parseRequestNode)
      .addNode("createLayerNode", createLayerNode)
      .addNode("replyNode", replyNode)
      .addEdge(START, "parseRequestNode")
      .addEdge("parseRequestNode", "createLayerNode")
      .addEdge("createLayerNode", "replyNode")
      .addEdge("replyNode", END);
  };

  const agent = {
    id: agentId,
    name: "Create Feature Layer",
    description:
      "Creates a hosted feature layer/service in ArcGIS Online. It can create an empty schema or seed a new point layer from the latest assistant results currently in memory.",
    createGraph,
    workspace: {},
  } as any;

  const existing = assistant.querySelector(`[data-agent-id="${agentId}"]`);
  if (existing) existing.remove();

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", agentId);
  agentEl.agent = agent;
  agentEl.context = ctx;
  assistant.appendChild(agentEl);
}