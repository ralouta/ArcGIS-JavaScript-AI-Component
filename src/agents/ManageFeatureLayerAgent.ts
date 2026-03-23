import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
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
import { searchPortalLayerByName } from "../utils/arcgisOnline";
import { GEOCODER_URL, MAP_ELEMENT_SELECTOR } from "../utils/arcgisConfig";

const editIntentTool = tool(
  async (args) => JSON.stringify(args),
  {
    name: "extract_edit_intent",
    description: "Extract all feature layer edit parameters from the user message.",
    schema: z.object({
      action: z.enum(["add", "update", "delete", "sync"]).nullable().describe(
        "'add' when inserting a new feature/record/point. 'update' when modifying an existing one. 'delete'/'remove' when removing. 'sync' for syncing or upserting memory data. Return null only if completely unclear."
      ),
      layerName: z.string().nullable().describe(
        "Name of the existing hosted feature layer. Look for: 'add to X layer', 'to the X layer', 'in X layer', 'X feature layer'. Example: 'add to Utrecht Parks feature layer' → 'Utrecht Parks'."
      ),
      layerUrl: z.string().nullable().describe(
        "Explicit FeatureServer URL if present (https://...FeatureServer or .../FeatureServer/0). Return null otherwise."
      ),
      featureLocation: z.string().nullable().describe(
        "The real-world place to geocode for the feature's geometry. " +
        "Signals: 'get its location', 'find its location', 'geocode', or any named place/address that appears as the subject to be located. " +
        "Examples: 'Utrecht Science park. Get its location' → 'Utrecht Science park'; " +
        "'add Amsterdam Centraal and get its location' → 'Amsterdam Centraal'; " +
        "'lat 52.09 lon 5.12' → 'lat 52.09 lon 5.12'. " +
        "IMPORTANT: distinguish from the LAYER name — the layer name follows 'to the X layer' / 'in X layer', the location is a separate place name. Return null only if truly no place is mentioned."
      ),
      featureName: z.string().nullable().describe(
        "Display name/label for the feature. Look for: 'park name is X', 'name is X', 'called X', 'named X'."
      ),
      attributes: z.array(
        z.object({
          field: z.string().describe("Field/column name exactly as mentioned"),
          value: z.union([z.string(), z.number()]).describe("The value to assign"),
        })
      ).nullable().describe(
        "All field-value pairs. Handle varied formats: 'tree_count to be 400' → {field:'tree_count',value:400}, 'park_area 1000 square meters' → {field:'park_area',value:1000}, 'park_name is X' → {field:'park_name',value:'X'}. Strip units like 'square meters' from numeric values."
      ),
      targetFeatureName: z.string().nullable().describe(
        "For update/delete: name of the existing feature to target. Null for adds."
      ),
      useMemory: z.boolean().describe(
        "True if the user refers to latest/current assistant results, memory snapshot, or data already on the map."
      ),
    }),
  }
);

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

function findLayerUrlByName(name: string): string | null {
  const mapEl = document.querySelector(MAP_ELEMENT_SELECTOR) as any;
  const layers = mapEl?.view?.map?.allLayers;
  if (!layers) return null;
  const search = name.trim().toLowerCase();
  let found: any = null;
  layers.forEach((layer: any) => {
    if (!found && layer?.url && layer.title?.toLowerCase() === search) found = layer;
  });
  if (!found) {
    layers.forEach((layer: any) => {
      if (!found && layer?.url && layer.title?.toLowerCase().includes(search)) found = layer;
    });
  }
  return found?.url ?? null;
}

async function geocodeLocation(location: string): Promise<{
  latitude: number;
  longitude: number;
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number };
} | null> {
  const params = new URLSearchParams({
    f: "json",
    SingleLine: location,
    maxLocations: "1",
    outFields: "*",
    forStorage: "false",
  });
  try {
    const resp = await fetch(`${GEOCODER_URL}?${params}`);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const candidate = json?.candidates?.[0];
    const latitude = Number(candidate?.location?.y);
    const longitude = Number(candidate?.location?.x);
    if (isNaN(latitude) || isNaN(longitude)) return null;
    const ext = candidate?.extent;
    const extent = ext
      ? { xmin: Number(ext.xmin), ymin: Number(ext.ymin), xmax: Number(ext.xmax), ymax: Number(ext.ymax) }
      : undefined;
    return { latitude, longitude, extent };
  } catch {
    return null;
  }
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

      // ── Extract intent via LLM ──────────────────────────────────────────
      let intent = {
        action: null as "add" | "update" | "delete" | "sync" | null,
        layerName: null as string | null,
        layerUrl: null as string | null,
        featureLocation: null as string | null,
        featureName: null as string | null,
        attributes: null as Array<{ field: string; value: string | number }> | null,
        targetFeatureName: null as string | null,
        useMemory: false,
      };

      try {
        const response = await invokeToolPrompt({
          promptText:
            "You extract feature layer edit parameters from user messages. " +
            "Always call extract_edit_intent with everything you can find. " +
            "For attributes, extract ALL field-value pairs, handling any natural language format.",
          messages: [new HumanMessage(text || "edit feature layer")],
          tools: [editIntentTool],
          temperature: 0,
        });
        const call = (Array.isArray((response as any)?.tool_calls) ? (response as any).tool_calls : [])
          .find((tc: any) => tc?.name === "extract_edit_intent");
        if (call?.args) intent = { ...intent, ...call.args };
      } catch {
        // continue with empty intent
      }

      // ── Resolve layer URL ───────────────────────────────────────────────
      const lastCreated = getLastCreatedFeatureLayer();
      const mapLayerUrl = intent.layerName ? findLayerUrlByName(intent.layerName) : null;
      const portalLayerUrl = (!mapLayerUrl && intent.layerName)
        ? await searchPortalLayerByName(intent.layerName)
        : null;
      const layerUrl =
        intent.layerUrl ||
        mapLayerUrl ||
        portalLayerUrl ||
        lastCreated?.layerUrl ||
        null;

      if (!intent.action) {
        // No recognisable edit operation — return nothing so this agent's output
        // doesn't contaminate another agent's valid response in the same turn.
        return { outputMessage: "" };
      }
      if (!layerUrl) {
        const hint = intent.layerName
          ? `Could not find a layer named "${intent.layerName}" in the current map or in your ArcGIS Online content.`
          : "No target layer found.";
        return { outputMessage: `${hint} Provide a FeatureServer URL or load the layer onto the map.` };
      }

      // ── ADD ─────────────────────────────────────────────────────────────
      if (intent.action === "add") {
        if (intent.useMemory) {
          const drafts = await buildPointFeatureDraftsFromMemory(getLastAssistantGeoSnapshot());
          try {
            const result = await addPointFeaturesToLayer(layerUrl, drafts);
            return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
          } catch (err: any) {
            return { outputMessage: `Failed to add features: ${err?.message ?? String(err)}` };
          }
        }

        // Resolve geometry via geocoding
        const geo = intent.featureLocation ? await geocodeLocation(intent.featureLocation) : null;

        if (!geo) {
          const hint = intent.featureLocation
            ? `Could not geocode "${intent.featureLocation}".`
            : "No location was specified.";
          return { outputMessage: `${hint} Please provide a place name, address, or coordinates.` };
        }

        const featureName = intent.featureName || intent.featureLocation || "New Feature";
        const attrMap: Record<string, unknown> = { Name: featureName, Category: "point", Origin: "manual" };
        for (const { field, value } of intent.attributes ?? []) {
          attrMap[field] = value;
        }

        // Determine geometry type from the layer and build the right geometry
        try {
          const FeatureLayer = (await import("@arcgis/core/layers/FeatureLayer")).default;
          const Graphic = (await import("@arcgis/core/Graphic")).default;
          const Polygon = (await import("@arcgis/core/geometry/Polygon")).default;
          const Point = (await import("@arcgis/core/geometry/Point")).default;

          const normalizedUrl = layerUrl.trim().replace(/\/+$/, "").replace(/\/\d+$/, "") + "/0";
          const layer = new FeatureLayer({ url: normalizedUrl });
          await layer.load();

          const sanitizedAttrs: Record<string, unknown> = {};
          const fieldMap = new Map((layer.fields ?? []).map((f: any) => [f.name.toLowerCase(), f.name]));
          for (const [k, v] of Object.entries(attrMap)) {
            const matched = fieldMap.get(k.toLowerCase());
            if (matched) sanitizedAttrs[matched] = v;
          }

          let geometry: any;
          const geoType = layer.geometryType;

          if (geoType === "polygon") {
            if (geo.extent && !isNaN(geo.extent.xmin)) {
              geometry = new Polygon({
                rings: [[
                  [geo.extent.xmin, geo.extent.ymin],
                  [geo.extent.xmax, geo.extent.ymin],
                  [geo.extent.xmax, geo.extent.ymax],
                  [geo.extent.xmin, geo.extent.ymax],
                  [geo.extent.xmin, geo.extent.ymin],
                ]],
                spatialReference: { wkid: 4326 },
              });
            } else {
              // Fallback: small bounding box around the geocoded point
              const delta = 0.002;
              geometry = new Polygon({
                rings: [[
                  [geo.longitude - delta, geo.latitude - delta],
                  [geo.longitude + delta, geo.latitude - delta],
                  [geo.longitude + delta, geo.latitude + delta],
                  [geo.longitude - delta, geo.latitude + delta],
                  [geo.longitude - delta, geo.latitude - delta],
                ]],
                spatialReference: { wkid: 4326 },
              });
            }
          } else {
            geometry = new Point({ latitude: geo.latitude, longitude: geo.longitude });
          }

          const graphic = new Graphic({ geometry, attributes: sanitizedAttrs });
          const editResult = await layer.applyEdits({ addFeatures: [graphic] });
          const added = Array.isArray(editResult.addFeatureResults)
            ? editResult.addFeatureResults.filter((r: any) => r?.objectId != null && !r?.error).length
            : 0;
          const failed = Array.isArray(editResult.addFeatureResults)
            ? editResult.addFeatureResults.filter((r: any) => r?.error)
            : [];

          if (added > 0) {
            return {
              outputMessage:
                `Successfully added "${featureName}" to the layer.\n` +
                `Location: ${geo.latitude.toFixed(5)}, ${geo.longitude.toFixed(5)}\n` +
                `Fields added: ${Object.keys(sanitizedAttrs).join(", ")}\n` +
                `Target layer: ${layerUrl}`,
            };
          }
          const errDetail = failed[0]?.error?.message ?? "Unknown error from applyEdits";
          return { outputMessage: `Feature was not added. Server error: ${errDetail}` };
        } catch (err: any) {
          return { outputMessage: `Failed to add feature: ${err?.message ?? String(err)}` };
        }
      }

      // ── SYNC ────────────────────────────────────────────────────────────
      if (intent.action === "sync") {
        try {
          const drafts = await buildPointFeatureDraftsFromMemory(getLastAssistantGeoSnapshot());
          const result = await upsertPointFeaturesByName(layerUrl, drafts);
          return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
        } catch (err: any) {
          return { outputMessage: `Sync failed: ${err?.message ?? String(err)}` };
        }
      }

      // ── DELETE ──────────────────────────────────────────────────────────
      if (intent.action === "delete") {
        if (intent.useMemory) {
          try {
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
          } catch (err: any) {
            return { outputMessage: `Delete failed: ${err?.message ?? String(err)}` };
          }
        }
        const targetName = intent.targetFeatureName;
        if (!targetName) {
          return { outputMessage: "Specify the name of the feature to delete." };
        }
        try {
          const result = await deleteFeaturesByName(layerUrl, targetName);
          return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
        } catch (err: any) {
          return { outputMessage: `Delete failed: ${err?.message ?? String(err)}` };
        }
      }

      // ── UPDATE ──────────────────────────────────────────────────────────
      if (intent.useMemory) {
        try {
          const drafts = await buildPointFeatureDraftsFromMemory(getLastAssistantGeoSnapshot());
          const result = await upsertPointFeaturesByName(layerUrl, drafts);
          return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
        } catch (err: any) {
          return { outputMessage: `Update failed: ${err?.message ?? String(err)}` };
        }
      }

      const targetName = intent.targetFeatureName;
      const attrMap: Record<string, unknown> = {};
      for (const { field, value } of intent.attributes ?? []) {
        attrMap[field] = value;
      }
      if (!targetName || !Object.keys(attrMap).length) {
        return { outputMessage: "For updates, specify the feature name and at least one field to change." };
      }
      try {
        const result = await updateFeaturesByName(layerUrl, targetName, attrMap);
        return { outputMessage: `${result.message}\nTarget layer: ${layerUrl}` };
      } catch (err: any) {
        return { outputMessage: `Update failed: ${err?.message ?? String(err)}` };
      }
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
      "ONLY use this agent when the user explicitly wants to ADD, CREATE, INSERT, UPDATE, EDIT, MODIFY, DELETE, or REMOVE a specific record or feature in an existing hosted feature layer. " +
      "DO NOT use for: show, find, search, display, list, view, browse, analyze, or any read/query operation that is not directly related to a feautre in the. " +
      "DO NOT use for MCP server queries, STAC catalog operations, or satellite/imagery data requests. " +
      "The target layer must be an editable ArcGIS FeatureServer layer — not a STAC collection, imagery service, or read-only layer.",
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