import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";

type AgentSummary = {
  name: string;
  description: string;
};

const BUILT_IN_AGENT_SUMMARIES: Record<string, AgentSummary> = {
  "arcgis-assistant-help-agent": {
    name: "Help",
    description: "Answer questions about the current web map, available data, and what kinds of questions the assistant can handle.",
  },
  "arcgis-assistant-navigation-agent": {
    name: "Navigation",
    description: "Pan, zoom, and navigate to places on the active map.",
  },
  "arcgis-assistant-data-exploration-agent": {
    name: "Data Exploration",
    description: "Query map layers, inspect features, summarize map content, and answer data questions against the active web map.",
  },
};

function prettifyTagName(tagName: string): string {
  return tagName
    .toLowerCase()
    .replace(/^arcgis-assistant-/, "")
    .replace(/-agent$/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function readCustomAgentSummary(agentElement: Element): AgentSummary | null {
  const customAgent = agentElement as any;
  const agent = customAgent.agent as { id?: string; name?: string; description?: string } | undefined;

  if (!agent || agent.id === "all-capabilities-agent") {
    return null;
  }

  return {
    name: agent.name?.trim() || "Custom Agent",
    description: agent.description?.trim() || "Custom assistant capability.",
  };
}

function collectAssistantCapabilities(assistant: HTMLElement): AgentSummary[] {
  const summaries: AgentSummary[] = [];
  const seen = new Set<string>();

  for (const child of Array.from(assistant.children)) {
    const tagName = child.tagName.toLowerCase();

    if (tagName === "arcgis-assistant-agent") {
      const customSummary = readCustomAgentSummary(child);
      if (!customSummary) continue;

      const key = `${customSummary.name}|${customSummary.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      summaries.push(customSummary);
      continue;
    }

    if (!tagName.startsWith("arcgis-assistant-") || tagName === "arcgis-assistant") {
      continue;
    }

    const builtInSummary = BUILT_IN_AGENT_SUMMARIES[tagName] || {
      name: prettifyTagName(tagName),
      description: "Built-in assistant capability available in the current ArcGIS assistant instance.",
    };

    const key = `${builtInSummary.name}|${builtInSummary.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(builtInSummary);
  }

  return summaries;
}

function buildCapabilitiesSummary(assistant: HTMLElement): string {
  const capabilities = collectAssistantCapabilities(assistant);

  if (!capabilities.length) {
    return "No assistant agents are currently registered.";
  }

  return [
    "Here are the assistant capabilities currently registered:",
    "",
    ...capabilities.map((capability) => `- ${capability.name}: ${capability.description}`),
  ].join("\n");
}

export function registerFeatureLayerCapabilitiesAgent(assistant: HTMLElement) {
  const agentId = "all-capabilities-agent";

  const createGraph = () => {
    const state = ANNOTATION.Root({
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

    function summarizeNode() {
      return { outputMessage: buildCapabilitiesSummary(assistant) };
    }

    const graph = new StateGraph(state)
      .addNode("summarizeNode", summarizeNode)
      .addEdge(START, "summarizeNode")
      .addEdge("summarizeNode", END);

    return graph;
  };

  const agent = {
    id: agentId,
    name: "All Capabilities",
    description:
      "Summarizes built-in and custom assistant capabilities. Use this when users ask for help, skills, or capabilities.",
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
