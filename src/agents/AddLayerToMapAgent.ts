import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { addFeatureLayerToCurrentMap } from "../utils/featureLayerEdits";
import { getCredential, searchPortalLayerByName } from "../utils/arcgisOnline";
import esriConfig from "@arcgis/core/config";

// ── Extraction tool ────────────────────────────────────────────────────────────

const addLayerTool = tool(
  async (args) => JSON.stringify(args),
  {
    name: "extract_add_layer_intent",
    description: "Extract all parameters needed to add a feature layer to the map from the user message.",
    schema: z.object({
      title: z.string().nullable().describe(
        "Layer title/name to search for in ArcGIS Online. Extract if user says 'add X layer', 'load X', 'show X on map', 'layer called X', or just mentions a layer name."
      ),
      itemId: z.string().nullable().describe(
        "ArcGIS Online item ID (32-char hex string). Extract if user provides it directly, e.g. 'item id abc123...' or 'itemid: abc123...'."
      ),
      serviceUrl: z.string().nullable().describe(
        "Full FeatureServer URL (https://...FeatureServer or .../FeatureServer/N). Extract if user pastes a URL directly."
      ),
    }),
  }
);

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractLastUserText(state: any): string {
  const rawMessages = Array.isArray(state?.messages) ? state.messages : [];
  const messages = rawMessages.length > 0 && Array.isArray(rawMessages[0]) ? rawMessages.flat() : rawMessages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (typeof msg.lc_kwargs?.content === "string") return msg.lc_kwargs.content.trim();
    if (typeof msg.kwargs?.content === "string") return msg.kwargs.content.trim();
    if (typeof msg.content === "string") return msg.content.trim();
  }
  return "";
}

function normalizeServiceUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /\/\d+$/.test(trimmed) ? trimmed : `${trimmed}/0`;
}

async function resolveLayerUrl(
  title: string | null,
  itemId: string | null,
  serviceUrl: string | null,
): Promise<{ url: string; resolvedTitle: string | null } | { error: string }> {

  // 1. Direct service URL
  if (serviceUrl) {
    return { url: normalizeServiceUrl(serviceUrl), resolvedTitle: title };
  }

  // 2. Item ID → look up item metadata then derive service URL
  if (itemId) {
    try {
      const cred = await getCredential();
      const portalUrl = cred.portalUrl || esriConfig?.portalUrl || "https://www.arcgis.com";
      const resp = await fetch(
        `${portalUrl}/sharing/rest/content/items/${encodeURIComponent(itemId)}?f=json&token=${encodeURIComponent(cred.token)}`
      );
      if (!resp.ok) return { error: `HTTP ${resp.status} fetching item ${itemId}.` };
      const json: any = await resp.json();
      if (json?.error) return { error: `Portal error: ${json.error.message ?? JSON.stringify(json.error)}` };
      const itemUrl: string | null = json?.url ?? null;
      const itemTitle: string | null = json?.title ?? title;
      if (!itemUrl) return { error: `Item ${itemId} was found but has no service URL. Is it a Feature Service?` };
      return { url: normalizeServiceUrl(itemUrl), resolvedTitle: itemTitle };
    } catch (err: any) {
      return { error: `Failed to look up item ${itemId}: ${err?.message ?? String(err)}` };
    }
  }

  // 3. Title search in ArcGIS Online
  if (title) {
    const found = await searchPortalLayerByName(title);
    if (found) return { url: found, resolvedTitle: title };
    return { error: `No Feature Service named "${title}" was found in your ArcGIS Online content. Try a different title or provide the item ID or service URL directly.` };
  }

  return { error: "Please provide a layer title, item ID, or service URL." };
}

// ── Agent registration ─────────────────────────────────────────────────────────

export function registerAddLayerToMapAgent(assistant: HTMLElement) {
  const agentId = "add-layer-to-map-agent";

  const createGraph = () => {
    const state = ANNOTATION.Root({
      messages: ANNOTATION({
        reducer: (cur: any[] = [], update: any) => [...cur, update],
        default: () => [],
      }),
      outputMessage: ANNOTATION({
        reducer: (current: string = "", update: any) =>
          typeof update === "string" && update.trim()
            ? current ? `${current}\n\n${update}` : update
            : current,
        default: () => "",
      }),
    });

    async function addLayerNode(s: any) {
      const text = extractLastUserText(s);

      // ── Extract intent ──────────────────────────────────────────────────
      let intent: { title: string | null; itemId: string | null; serviceUrl: string | null } =
        { title: null, itemId: null, serviceUrl: null };

      try {
        const response = await invokeToolPrompt({
          promptText:
            "You extract parameters needed to add a feature layer to a map. " +
            "Always call extract_add_layer_intent with everything you find. " +
            "The user may provide a title/name, an item ID, or a service URL — extract whichever is present.",
          messages: [new HumanMessage(text || "add layer to map")],
          tools: [addLayerTool],
          temperature: 0,
        });
        const call = (Array.isArray((response as any)?.tool_calls) ? (response as any).tool_calls : [])
          .find((tc: any) => tc?.name === "extract_add_layer_intent");
        if (call?.args) intent = { ...intent, ...call.args };
      } catch {
        // continue with empty intent
      }

      // ── Resolve URL ─────────────────────────────────────────────────────
      const resolved = await resolveLayerUrl(intent.title, intent.itemId, intent.serviceUrl);

      if ("error" in resolved) {
        return { outputMessage: resolved.error };
      }

      // ── Add to map ──────────────────────────────────────────────────────
      try {
        await addFeatureLayerToCurrentMap(resolved.url, resolved.resolvedTitle ?? undefined);
        const displayName = resolved.resolvedTitle ?? resolved.url;
        return {
          outputMessage:
            `Added "${displayName}" to the map.\nLayer URL: ${resolved.url}`,
        };
      } catch (err: any) {
        return { outputMessage: `Failed to add the layer: ${err?.message ?? String(err)}` };
      }
    }

    return new StateGraph(state)
      .addNode("addLayerNode", addLayerNode)
      .addEdge(START, "addLayerNode")
      .addEdge("addLayerNode", END);
  };

  const agent = {
    id: agentId,
    name: "Add Layer to Map",
    description:
      "Adds a hosted feature layer to the current map. Accepts a layer title/name (searches ArcGIS Online), an ArcGIS Online item ID, or a direct FeatureServer URL. Use when the user wants to load, show, display, or add a layer to the map.",
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
