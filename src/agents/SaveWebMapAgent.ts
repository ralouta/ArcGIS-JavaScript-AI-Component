import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";

export interface SaveWebMapAgentContext {
  saveCurrentWebMap: (options?: { title?: string | null }) => Promise<{
    success: boolean;
    message: string;
    itemId?: string;
    title?: string;
  }>;
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

function extractRequestedTitle(text: string): string | null {
  const quoted = text.match(/\b(?:save|save as|save map as|name|title|call(?:ed)?)\b[^"']*["']([^"']+)["']/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const named = text.match(/\b(?:save(?: the)?(?: web)?map(?: as)?|name|title|call(?:ed)?)\s+([A-Za-z0-9 _-]{3,80})/i);
  return named?.[1]?.trim() || null;
}

export function registerSaveWebMapAgent(assistant: HTMLElement, ctx: SaveWebMapAgentContext) {
  const agentId = "save-webmap-agent";

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

    async function saveNode(s: any) {
      const text = extractLastUserText(s);
      const title = extractRequestedTitle(text);
      const result = await ctx.saveCurrentWebMap({ title });
      return { outputMessage: result.message };
    }

    return new StateGraph(state)
      .addNode("saveNode", saveNode)
      .addEdge(START, "saveNode")
      .addEdge("saveNode", END);
  };

  const agent = {
    id: agentId,
    name: "Save WebMap",
    description:
      "Saves the current WebMap. Temporary maps are promoted to saved WebMaps, and you can optionally provide a title in your prompt.",
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
