import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";
import { z } from "zod";
import {
  getArcgisMcpFeatureTable,
  searchArcgisMcpContent,
  searchArcgisMcpLayers,
  summarizeArcgisMcpField,
} from "../utils/arcgisMcp";

export interface ArcgisMcpPassthroughAgentContext {
  baseUrl?: string;
  serverName?: string;
}

function normalizeMessages(messages: any): any[] {
  const rawMessages = Array.isArray(messages) ? messages : [];
  if (rawMessages.length === 1 && Array.isArray(rawMessages[0])) {
    return rawMessages[0];
  }
  return rawMessages.flatMap((message) => (Array.isArray(message) ? message : [message]));
}

function getLastAiMessage(messages: any[]): AIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (AIMessage.isInstance(message)) {
      return message;
    }
  }
  return null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function formatLayerMatches(matches: Awaited<ReturnType<typeof searchArcgisMcpLayers>>): string {
  if (!matches.length) {
    return "No matching layers found.";
  }

  return matches.map((match) => `${match.name}: ${match.url}`).join("\n");
}

function formatContentMatches(matches: Awaited<ReturnType<typeof searchArcgisMcpContent>>): string {
  if (!matches.length) {
    return "No matching content found.";
  }

  return matches.map((match) => `${match.title}: ${match.item_id} | Type: ${match.type}`).join("\n");
}

function formatFieldSummary(summary: Awaited<ReturnType<typeof summarizeArcgisMcpField>>): string {
  const lines = [
    `Field: ${summary.field}`,
    `Type: ${summary.type}`,
    `Total features: ${summary.total_features}`,
    `Null values: ${summary.null_count} (${summary.null_percentage.toFixed(1)}%)`,
  ];

  if (summary.message) {
    lines.push(summary.message);
    return lines.join("\n");
  }

  for (const [key, value] of Object.entries(summary.statistics)) {
    lines.push(`${key.replace(/_/g, " ")}: ${String(value)}`);
  }

  lines.push(`Unique values: ${summary.unique_values}`);

  if (summary.top_values.length) {
    lines.push("");
    lines.push("Top values:");
    for (const item of summary.top_values) {
      lines.push(`- ${String(item.value)}: ${item.count} (${item.percentage.toFixed(1)}%)`);
    }
  }

  return lines.join("\n");
}

function createArcgisMcpTools(baseUrl?: string, serverName?: string) {
  const serverLabel = serverName || "MCP";
  return [
    tool(
      async ({ keyword }) => formatLayerMatches(await searchArcgisMcpLayers(keyword, baseUrl)),
      {
        name: "search_layers",
        description:
          `Search the ${serverLabel} server for feature layers matching a keyword. Returns REST service URLs for matching layers.`,
        schema: z.object({
          keyword: z.string().min(1).describe("Keyword to search for, such as Hydrants or Roads."),
        }),
      }
    ),
    tool(
      async ({ keyword, item_type }) =>
        formatContentMatches(await searchArcgisMcpContent(keyword, item_type, baseUrl)),
      {
        name: "search_content",
        description:
          `Search the ${serverLabel} server for content items by keyword and optional item type.`,
        schema: z.object({
          keyword: z.string().min(1).describe("Keyword to search for, such as Traffic or Population."),
          item_type: z.string().optional().describe("Optional ArcGIS content type, such as Web Map or Dashboard."),
        }),
      }
    ),
    tool(
      async ({ service_url }) => {
        const table = await getArcgisMcpFeatureTable(service_url, baseUrl);
        return table.csv || "No features found.";
      },
      {
        name: "get_feature_table",
        description:
          `Fetch the first rows of a feature layer attribute table from the ${serverLabel} server and return them as CSV.`,
        schema: z.object({
          service_url: z.string().url().describe("Feature layer REST service URL returned by search_layers."),
        }),
      }
    ),
    tool(
      async ({ service_url, field_name }) =>
        formatFieldSummary(await summarizeArcgisMcpField(service_url, field_name, baseUrl)),
      {
        name: "summarize_field",
        description:
          `Summarize a field from a feature layer using the ${serverLabel} server.`,
        schema: z.object({
          service_url: z.string().url().describe("Feature layer REST service URL returned by search_layers."),
          field_name: z.string().min(1).describe("Field name from the feature table to summarize."),
        }),
      }
    ),
  ];
}

async function runArcgisMcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  baseUrl?: string
): Promise<string> {
  switch (toolName) {
    case "search_layers":
      return formatLayerMatches(await searchArcgisMcpLayers(String(args.keyword || ""), baseUrl));
    case "search_content":
      return formatContentMatches(
        await searchArcgisMcpContent(
          String(args.keyword || ""),
          typeof args.item_type === "string" ? args.item_type : undefined,
          baseUrl
        )
      );
    case "get_feature_table": {
      const table = await getArcgisMcpFeatureTable(String(args.service_url || ""), baseUrl);
      return table.csv || "No features found.";
    }
    case "summarize_field":
      return formatFieldSummary(
        await summarizeArcgisMcpField(
          String(args.service_url || ""),
          String(args.field_name || ""),
          baseUrl
        )
      );
    default:
      throw new Error(`Unsupported MCP tool: ${toolName}`);
  }
}

export function registerArcgisMcpPassthroughAgent(
  assistant: HTMLElement,
  ctx: ArcgisMcpPassthroughAgentContext = {}
) {
  const agentId = "arcgis-mcp-passthrough-agent";

  const createGraph = () => {
    const tools = createArcgisMcpTools(ctx.baseUrl, ctx.serverName);
    const state = ANNOTATION.Root({
      messages: ANNOTATION({
        reducer: (current: any[] = [], update: any) => {
          const next = Array.isArray(update) ? update : [update];
          return [...current, ...next.filter(Boolean)];
        },
        default: () => [],
      }),
      outputMessage: ANNOTATION({
        reducer: (current: string = "", update: any) => {
          if (typeof update !== "string" || !update.trim()) {
            return current;
          }
          return current ? `${current}\n\n${update}` : update;
        },
        default: () => "",
      }),
    });

    async function agentNode(agentState: any) {
      const messages = normalizeMessages(agentState?.messages);
      const serverLabel = ctx.serverName || "MCP";
      const response = await invokeToolPrompt({
        promptText:
          `You are a thin connector to the ${serverLabel} server for external data searches. Use the available tools instead of inventing results. Use this agent only when the user wants layers, services, or items from the MCP server. Do not treat questions about the active map, this map, this webmap, the currently loaded web map, or layers already visible in the app as MCP tasks; those belong to the built-in map exploration capabilities. Prefer search_layers when the user needs feature layer URLs from the MCP server, search_content for items like dashboards and web maps on the MCP server, get_feature_table to inspect fields and sample rows, and summarize_field for statistics about a specific field. After tools run, provide a concise answer grounded only in the returned tool output.`,
        messages,
        tools,
        temperature: 0,
      });

      return { messages: [response] };
    }

    async function toolsNode(agentState: any) {
      const messages = normalizeMessages(agentState?.messages);
      const lastAiMessage = getLastAiMessage(messages);

      if (!lastAiMessage?.tool_calls?.length) {
        return {};
      }

      const toolMessages = await Promise.all(
        lastAiMessage.tool_calls.map(async (toolCall) => {
          const selectedTool = tools.find((registeredTool) => registeredTool.name === toolCall.name);
          if (!selectedTool) {
            return new ToolMessage({
              content: `Unsupported MCP tool: ${toolCall.name}`,
              tool_call_id: toolCall.id ?? toolCall.name,
              status: "error",
            });
          }

          try {
            const result = await runArcgisMcpToolCall(
              selectedTool.name,
              (toolCall.args as Record<string, unknown>) || {},
              ctx.baseUrl
            );
            return new ToolMessage({
              content: result,
              tool_call_id: toolCall.id ?? toolCall.name,
            });
          } catch (error: any) {
            return new ToolMessage({
              content: error?.message || `Failed to reach the ${ctx.serverName || "MCP"} server.`,
              tool_call_id: toolCall.id ?? toolCall.name,
              status: "error",
            });
          }
        })
      );

      return { messages: toolMessages };
    }

    function routeAfterAgent(agentState: any) {
      const messages = normalizeMessages(agentState?.messages);
      const lastAiMessage = getLastAiMessage(messages);
      return lastAiMessage?.tool_calls?.length ? "tools" : "respond";
    }

    function respondNode(agentState: any) {
      const messages = normalizeMessages(agentState?.messages);
      const lastAiMessage = getLastAiMessage(messages);
      return {
        outputMessage:
          contentToText(lastAiMessage?.content) ||
          `The ${ctx.serverName || "MCP"} server did not return a final response.`,
      };
    }

    return new StateGraph(state)
      .addNode("agent", agentNode)
      .addNode("tools", toolsNode)
      .addNode("respond", respondNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeAfterAgent, ["tools", "respond"])
      .addEdge("tools", "agent")
      .addEdge("respond", END);
  };

  const serverLabel = ctx.serverName || "MCP Server";
  const agent = {
    id: agentId,
    name: serverLabel,
    description:
      `Searches external data through the ${serverLabel}. Use this for MCP-server searches, feature service URLs, feature table inspection, and field summaries from the configured server. Do not use this for questions about the active map, this webmap, current map layers, or content already loaded in the app.`,
    createGraph,
    workspace: {},
  } as any;

  const existing = assistant.querySelector(`[data-agent-id="${agentId}"]`);
  if (existing) {
    existing.remove();
  }

  const agentEl = document.createElement("arcgis-assistant-agent") as any;
  agentEl.setAttribute("data-agent-id", agentId);
  agentEl.agent = agent;
  assistant.appendChild(agentEl);
}