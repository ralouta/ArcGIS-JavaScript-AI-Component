import { StateGraph, Annotation as ANNOTATION, START, END } from "@langchain/langgraph/web";

function buildCapabilitiesSummary(): string {
  return [
    "Here is what I can do in this assistant:",
    "",
    "Built-in capabilities:",
    "- Navigation agent: pan/zoom and navigate to places on the map.",
    "- Data exploration agent: query layers, filter data, summarize map content, and answer data questions (embeddings-backed).",
    "",
    "Custom capability:",
    "- Create hosted feature layers/services in your ArcGIS portal.",
    "",
    "Create-layer inputs I can parse:",
    "- Layer/service name (for example: named Facilities)",
    "- Geometry type: point, polyline, or polygon",
    "- Optional fields (for example: Name:string, Capacity:int, OpenDate:date)",
    "",
    "Example prompts:",
    "- Create a point feature layer named Facilities with fields: Name:string, Capacity:int.",
    "- Create a polygon layer called Zoning with fields: Zone:string, MaxHeight:int.",
    "- Create a polyline feature layer named Trails with fields: Name:string, Length:double.",
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
      return { outputMessage: buildCapabilitiesSummary() };
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
