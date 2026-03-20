import type { CreateHostedFeatureServiceResult } from "../utils/arcgisOnline";
import { getCredential, createHostedFeatureService } from "../utils/arcgisOnline";
import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
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
}

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

const extractionTool = tool(
  async (args) => JSON.stringify(args),
  {
    name: "extract_layer_intent",
    description: "Extract all feature layer creation parameters from the user message.",
    schema: z.object({
      isNewLayerRequest: z.boolean().describe(
        "True ONLY when the user explicitly wants to CREATE or MAKE a brand-new layer/service from scratch. False if the user wants to ADD features/records/points TO an existing layer (e.g. 'add to X layer', 'insert into X', 'add Utrecht Science Park to X')."
      ),
      name: z.string().nullable().describe(
        "The title/name for the NEW layer. Look for it after words like 'called', 'named', 'titled', 'with title', 'with name', or as a standalone identifier. Examples: 'called UtrechtParks' → 'UtrechtParks', 'title My Layer' → 'My Layer', 'layer IncidentData' → 'IncidentData'."
      ),
      geometryType: z.enum(["point", "polyline", "polygon"]).nullable().describe(
        "Geometry type. 'point' for point/marker/location layers, 'polyline' for line/route/road layers, 'polygon' for area/zone/region/park layers."
      ),
      fields: z.array(
        z.object({
          name: z.string().describe("Field name"),
          type: z.string().describe("Field type as given by the user, e.g. str, int, double, date"),
        })
      ).nullable().describe(
        "Fields specified by the user, e.g. 'fields: park_area:double, tree_count:int' → [{name:'park_area',type:'double'},{name:'tree_count',type:'int'}]"
      ),
      useMemory: z.boolean().describe(
        "True if the user wants to populate the new layer from current/latest assistant results, returned data, or data already in the map."
      ),
    }),
  }
);

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

      let extracted: {
        isNewLayerRequest: boolean;
        name: string | null;
        geometryType: "point" | "polyline" | "polygon" | null;
        fields: Array<{ name: string; type: string }> | null;
        useMemory: boolean;
      } = { isNewLayerRequest: true, name: null, geometryType: null, fields: null, useMemory: false };

      try {
        const response = await invokeToolPrompt({
          promptText:
            "You extract feature layer CREATION parameters from user messages. " +
            "Set isNewLayerRequest=false if the user is adding features/records to an EXISTING layer. " +
            "Always call extract_layer_intent with the values you find. " +
            "If a value is not present, use null or false.",
          messages: [new HumanMessage(text || "create a feature layer")],
          tools: [extractionTool],
          temperature: 0,
        });
        const toolCalls = Array.isArray((response as any)?.tool_calls) ? (response as any).tool_calls : [];
        const call = toolCalls.find((tc: any) => tc?.name === "extract_layer_intent");
        if (call?.args) extracted = { ...extracted, ...call.args };
      } catch {
        // proceed with empty extraction — createLayerNode will ask for clarification
      }

      if (extracted.isNewLayerRequest === false) {
        return {
          desiredName: null, desiredGeometryType: null, desiredFields: null,
          fieldsRequested: false, useMemory: false,
          outputMessage: "This looks like a request to add to an existing layer. Please use the Manage Feature Layer agent.",
        };
      }

      const desiredName = typeof extracted.name === "string" && extracted.name.trim()
        ? extracted.name.trim()
        : null;
      const desiredGeometryType = normalizeGeometryType(extracted.geometryType) || null;
      const desiredFields = Array.isArray(extracted.fields) && extracted.fields.length
        ? extracted.fields
            .filter((f: any) => f?.name && f?.type)
            .map((f: any) => {
              const type = esriFieldTypeFrom(String(f.type));
              const field: { name: string; type: string; alias?: string; length?: number } = {
                name: String(f.name),
                alias: String(f.name),
                type,
              };
              if (type === "esriFieldTypeString") field.length = 255;
              return field;
            })
        : null;
      const useMemory = Boolean(extracted.useMemory);
      const fieldsRequested = Boolean(desiredFields?.length);

      let message = desiredName
        ? `Using requested name: ${desiredName}`
        : "No title/name detected in your prompt.";
      if (desiredGeometryType) {
        message += `\nGeometry type detected: ${desiredGeometryType.replace("esriGeometry", "")}`;
      } else if (!ctx.geometryType) {
        message += "\nNo geometry type specified. Please reply with point, polyline, or polygon.";
      }
      if (desiredFields?.length) {
        message += `\nParsed fields: ${desiredFields.map((f) => `${f.name}:${f.type.replace("esriFieldType", "")}`).join(", ")}`;
      }
      if (useMemory) {
        message += "\nWill seed the new layer with the latest assistant results currently in memory or loaded on the map.";
      }

      return { desiredName, desiredGeometryType, desiredFields, fieldsRequested, useMemory, outputMessage: message };
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
      .addConditionalEdges("parseRequestNode", (s: any) => s.desiredName === null && /existing layer/i.test(s.outputMessage ?? "") ? "replyNode" : "createLayerNode")
      .addEdge("createLayerNode", "replyNode")
      .addEdge("replyNode", END);
  };

  const agent = {
    id: agentId,
    name: "Create Feature Layer",
    description:
      "Creates a brand-new hosted feature layer/service in ArcGIS Online from scratch. Use ONLY when the user explicitly wants to create a new layer. Do NOT use to add features or records to an existing layer — use the Manage Feature Layer agent for that.",
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