// Custom agent that creates a hosted feature layer/service in ArcGIS Online
// Uses a simple LangGraph workflow with two nodes: create layer and reply.

import type { CreateHostedFeatureServiceResult } from "../utils/arcgisOnline";
import { getCredential, createHostedFeatureService } from "../utils/arcgisOnline";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";

export interface CreateFeatureLayerAgentContext {
  oauthClientId?: string; // ArcGIS OAuth App ID (optional; use existing session if omitted)
  portalUrl?: string; // optional; inherits from esriConfig.portalUrl if omitted
  serviceName?: string; // Optional desired service name; defaults if not provided
  layerName?: string; // Optional layer name within the service
  geometryType?: "esriGeometryPoint" | "esriGeometryPolyline" | "esriGeometryPolygon";
  fields?: Array<{ name: string; type: string; alias?: string; length?: number }>;
  llm?: {
    invoke: (input: any) => Promise<any>;
  };
  llmSystemPrompt?: string;
}

export function registerCreateFeatureLayerAgent(
  assistant: HTMLElement,
  ctx: CreateFeatureLayerAgentContext
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
      desiredName: ANNOTATION({
        reducer: (_c: any, u: any) => (typeof u === "string" ? u : null),
        default: () => null,
      }),
      desiredGeometryType: ANNOTATION({
        reducer: (_c: any, u: any) => (typeof u === "string" ? u : null),
        default: () => null,
      }),
      desiredFields: ANNOTATION({
        reducer: (_c: any, u: any) => (Array.isArray(u) ? u : null),
        default: () => null,
      }),
    });

    type ExtractedIntent = {
      name?: string | null;
      geometryType?: "esriGeometryPoint" | "esriGeometryPolyline" | "esriGeometryPolygon" | null;
      fields?: Array<{ name: string; type: string; alias?: string; length?: number }> | null;
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
      if (t.includes("string") || t.includes("text")) return "esriFieldTypeString";
      if (t.includes("int") || t.includes("integer")) return "esriFieldTypeInteger";
      if (t.includes("double") || t.includes("float") || t.includes("number") || t.includes("decimal")) {
        return "esriFieldTypeDouble";
      }
      if (t.includes("date") || t.includes("datetime")) return "esriFieldTypeDate";
      return "esriFieldTypeString";
    }

    function parseNameFallback(text: string): string | null {
      const t = text.trim();
      
      // Simply look for 'named ' or 'called ' and extract the next quoted or non-quoted word
      let idx = t.toLowerCase().indexOf("named ");
      if (idx < 0) idx = t.toLowerCase().indexOf("called ");
      
      if (idx < 0) return null;
      
      // Get the text after 'named ' or 'called '
      let remainder = t.substring(idx + (t.substring(idx).startsWith("named") ? 6 : 7)).trim();
      
      // Extract quoted string or first word
      let name = "";
      if (remainder.startsWith("'")) {
        // Extract content between single quotes
        const endIdx = remainder.indexOf("'", 1);
        name = endIdx > 0 ? remainder.substring(1, endIdx) : remainder.substring(1);
      } else if (remainder.startsWith('"')) {
        // Extract content between double quotes
        const endIdx = remainder.indexOf('"', 1);
        name = endIdx > 0 ? remainder.substring(1, endIdx) : remainder.substring(1);
      } else {
        // Extract first word (up to space or "with")
        const spaceIdx = remainder.indexOf(" ");
        const withIdx = remainder.toLowerCase().indexOf("with");
        let endIdx = remainder.length;
        if (spaceIdx > 0) endIdx = Math.min(endIdx, spaceIdx);
        if (withIdx > 0) endIdx = Math.min(endIdx, withIdx);
        name = remainder.substring(0, endIdx).trim();
      }
      
      // Clean up: remove any remaining quotes and trailing punctuation (no regex)
      const quoteChars = new Set(["'", "\"", "\u2018", "\u2019", "\u201C", "\u201D"]);
      while (name.length && quoteChars.has(name[0])) name = name.slice(1);
      while (name.length && quoteChars.has(name[name.length - 1])) name = name.slice(0, -1);
      while (name.length && [".", ",", ";", ":"].includes(name[name.length - 1])) {
        name = name.slice(0, -1).trim();
      }
      name = name.trim();

      return name || null;
    }

    function parseFieldsFallback(text: string): Array<{ name: string; type: string; alias?: string; length?: number }> | null {
      const t = text.trim();
      
      // Find 'fields:' or 'with fields'
      let fieldsIdx = t.toLowerCase().indexOf("fields:");
      if (fieldsIdx < 0) {
        fieldsIdx = t.toLowerCase().indexOf("with fields");
        if (fieldsIdx >= 0) {
          fieldsIdx += "with fields".length;
        }
      } else {
        fieldsIdx += "fields:".length;
      }
      
      if (fieldsIdx < 0) {
        return null;
      }
      
      // Extract text after 'fields:' or 'with fields'
      let fieldsText = t.substring(fieldsIdx).trim();
      
      // Remove trailing period, semicolon, or quote
      fieldsText = fieldsText.replace(/[.;"\s]+$/, "").trim();
      
      // Split by comma and parse each field
      const fieldParts = fieldsText.split(",").map(f => f.trim()).filter(f => f.length > 0);
      
      const fields: Array<{ name: string; type: string; alias?: string; length?: number }> = [];
      
      for (const part of fieldParts) {
        // Look for 'Name:string' or 'Name (string)' format
        let colonIdx = part.indexOf(":");
        let parenIdx = part.indexOf("(");
        
        let fieldName = "";
        let fieldType = "";
        
        if (colonIdx > 0) {
          // Format: Name:string
          fieldName = part.substring(0, colonIdx).trim();
          fieldType = part.substring(colonIdx + 1).trim();
        } else if (parenIdx > 0) {
          // Format: Name(string)
          fieldName = part.substring(0, parenIdx).trim();
          const closeParenIdx = part.indexOf(")", parenIdx);
          fieldType = closeParenIdx > parenIdx 
            ? part.substring(parenIdx + 1, closeParenIdx).trim()
            : part.substring(parenIdx + 1).trim();
        }
        
        if (!fieldName || !fieldType) {
          continue;
        }
        
        // Clean up field type
        fieldType = fieldType.replace(/[).;\s]+$/, "").trim();
        
        const esriType = esriFieldTypeFrom(fieldType);
        const field: any = { name: fieldName, type: esriType };
        if (esriType === "esriFieldTypeString") field.length = 255;
        fields.push(field);
      }

      return fields.length > 0 ? fields : null;
    }

    function extractLastUserText(state: any): string {
      const rawMessages = Array.isArray(state?.messages) ? state.messages : [];
      const messages = rawMessages.length > 0 && Array.isArray(rawMessages[0]) ? rawMessages.flat() : rawMessages;

      let lastUser: any = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message) continue;
        if (message.lc_kwargs?.content || message.kwargs?.content) {
          lastUser = message;
          break;
        }
        if (message.role === "user" || message.sender === "user" || message.type === "HumanMessage") {
          lastUser = message;
          break;
        }
      }

      if (!lastUser) return "";
      if (typeof lastUser.lc_kwargs?.content === "string") return lastUser.lc_kwargs.content.trim();
      if (typeof lastUser.kwargs?.content === "string") return lastUser.kwargs.content.trim();
      if (typeof lastUser.content === "string") return lastUser.content.trim();
      if (Array.isArray(lastUser.content)) {
        return lastUser.content
          .filter(Boolean)
          .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
          .join(" ")
          .trim();
      }
      if (typeof lastUser.text === "string") return lastUser.text.trim();
      if (typeof lastUser.message === "string") return lastUser.message.trim();
      return "";
    }

    async function extractWithLLM(text: string): Promise<ExtractedIntent | null> {
      if (!ctx.llm) return null;
      const systemPrompt = ctx.llmSystemPrompt ||
        "You are a strict information extraction assistant. Extract the requested feature layer details from the user text and return only valid JSON. Schema: {\"name\": string|null, \"geometryType\": \"point\"|\"polyline\"|\"polygon\"|null, \"fields\": [{\"name\": string, \"type\": string}]|null}. Do not include any extra keys or commentary.";
      const userPrompt = `User text:\n${text}`;

      try {
        const response = await ctx.llm.invoke({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        const raw = typeof response === "string" ? response : response?.content || response?.text || "";
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end < 0 || end <= start) return null;
        const jsonText = raw.slice(start, end + 1);
        const parsed = JSON.parse(jsonText) as any;
        const geometryType = normalizeGeometryType(parsed.geometryType);
        let fields: Array<{ name: string; type: string; alias?: string; length?: number }> | null = null;
        if (Array.isArray(parsed.fields)) {
          fields = parsed.fields
            .filter((f: any) => f && f.name && f.type)
            .map((f: any) => {
              const esriType = esriFieldTypeFrom(String(f.type));
              const field: any = { name: String(f.name), type: esriType };
              if (esriType === "esriFieldTypeString") field.length = 255;
              return field;
            });
        }
        return {
          name: parsed.name || null,
          geometryType,
          fields: fields && fields.length ? fields : null,
        };
      } catch {
        return null;
      }
    }

    async function parseNameNode(s: any) {
      const text = extractLastUserText(s);
      const llmExtracted = typeof text === "string" && text ? await extractWithLLM(text) : null;
      
      const desired = llmExtracted?.name || (typeof text === "string" && text ? parseNameFallback(text) : null);
      const chosen = desired || `FeatureService_${Date.now()}`;
      const geom = llmExtracted?.geometryType || (typeof text === "string" && text ? normalizeGeometryType(text) : null);
      const fields = llmExtracted?.fields || (typeof text === "string" && text ? parseFieldsFallback(text) : null);

      let msg = desired ? `Using requested name: ${chosen}` : `No name found; using default: ${chosen}`;
      if (geom) {
        msg += `\nGeometry type detected: ${geom.replace("esriGeometry", "")}`;
      } else if (!ctx.geometryType) {
        msg += `\nNo geometry type specified. Please reply with one of: point, polyline, or polygon.`;
      }
      if (fields && fields.length) {
        msg += `\nParsed fields: ${fields.map((f) => `${f.name}:${(f.type || "").replace("esriFieldType", "")}`).join(", ")}`;
      }
      return { desiredName: chosen, desiredGeometryType: geom || null, desiredFields: fields || null, outputMessage: msg };
    }

    async function createLayerNode(s: any) {
      const serviceName = s.desiredName || ctx.serviceName || `FeatureService_${Date.now()}`;
      const layerName = ctx.layerName || "Layer0";
      const geometryType = s.desiredGeometryType || ctx.geometryType || null;
      const fields = s.desiredFields || ctx.fields || null;
      if (!geometryType) {
        return {
          outputMessage:
            "Awaiting clarification: What geometry type should I create? Reply with point, polyline, or polygon.",
        };
      }
      try {
        const cred = await getCredential(ctx.oauthClientId, ctx.portalUrl);
        const res = await createHostedFeatureService({
          portalUrl: cred.portalUrl,
          token: cred.token,
          username: cred.username,
          serviceName,
          layerName,
          geometryType: geometryType,
          fields: fields || undefined,
        });
        const itemUrl = res.serviceItemId ? `${cred.portalUrl}/home/item.html?id=${res.serviceItemId}` : null;
        const restUrl = res.serviceUrl || null;
        return {
          outputMessage: res.success
            ? `Success: ${res.message}\nItem ID: ${res.serviceItemId}${itemUrl ? `\nItem Page: ${itemUrl}` : ""}${restUrl ? `\nService REST: ${restUrl}` : ""}`
            : `Error: ${res.message}`,
          result: res,
        };
      } catch (e: any) {
        return { outputMessage: `Error creating feature service: ${e?.message || e}` };
      }
    }

    function replyNode(s: any) {
      const tail = "Create feature layer/service workflow completed.";
      return { outputMessage: tail };
    }

    const graph = new StateGraph(state)
      .addNode("parseNameNode", parseNameNode)
      .addNode("createLayerNode", createLayerNode)
      .addNode("replyNode", replyNode)
      .addEdge(START, "parseNameNode")
      .addEdge("parseNameNode", "createLayerNode")
      .addEdge("createLayerNode", "replyNode")
      .addEdge("replyNode", END);

    return graph;
  };

  const myAgent = {
    id: agentId,
    name: "Create Feature Layer",
    description:
      "Creates a hosted feature layer/service in ArcGIS Online. Use this when users ask to create a layer, feature layer, feature service, or point layer.",
    createGraph,
    workspace: {}, // State is defined in createGraph
  } as any;

  const existing = assistant.querySelector('[data-agent-id="create-feature-layer-agent"]');
  if (existing) {
    existing.remove();
  }

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", agentId);
  agentEl.agent = myAgent;
  agentEl.context = ctx;
  assistant.appendChild(agentEl);
}
