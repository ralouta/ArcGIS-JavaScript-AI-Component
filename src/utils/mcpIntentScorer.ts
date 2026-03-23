/**
 * mcpIntentScorer
 *
 * Intent-Aware Feature Importance Agent.
 *
 * Given the user's original question and the list of synthesized geographic
 * features, this agent scores every feature 1–10 for how directly it answers
 * the query.  The scores drive:
 *   • Layer draw order  (highest-priority group rendered on top)
 *   • Symbol prominence (opacity / marker size) via SymbolTier
 *   • Map navigation focus (zoom to the primary feature first)
 *
 * Gracefully falls back to uniform medium scores if the LLM call fails or the
 * user query is empty.
 */

import { invokeToolPrompt } from "@arcgis/ai-orchestrator";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { SynthesizedGeoResult } from "./mcpGeoJsonSynthesizer";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SymbolTier = "high" | "medium" | "low";

export interface FeatureScore {
  /** Zero-based index into SynthesizedGeoResult.features */
  index: number;
  layerGroup: string;
  /** Relevance score 1–10 */
  score: number;
  /** True for exactly ONE feature — the best single answer to navigate to */
  isPrimary: boolean;
  /** Symbology tier derived from score */
  symbolTier: SymbolTier;
}

export interface IntentScoreResult {
  scoredFeatures: FeatureScore[];
  /** Index of the isPrimary feature (fast lookup) */
  primaryIndex: number;
  /** Layer group names ordered highest priority → lowest (drives layer draw order) */
  layerOrder: string[];
}

// ── Tier thresholds ───────────────────────────────────────────────────────────
// Changing these numbers automatically updates both the runtime logic and
// the LLM system prompt — no other files need touching.

/** Minimum score (inclusive) for the "high" symbol tier. */
export const TIER_HIGH_MIN = 8;
/** Minimum score (inclusive) for the "medium" symbol tier. */
export const TIER_MEDIUM_MIN = 5;

function buildTierPromptSection(): string {
  return [
    `${TIER_HIGH_MIN}–10 → "high"   — full opacity, largest markers`,
    `${TIER_MEDIUM_MIN}–${TIER_HIGH_MIN - 1}  → "medium" — 80 % opacity, normal markers`,
    `1–${TIER_MEDIUM_MIN - 1}  → "low"    — 40 % opacity, small markers`,
  ].join("\n");
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `\
You are the Intent Scoring Agent for an ArcGIS mapping platform.

Your job: given a user's question and a list of geographic features returned by
an MCP server, assign each feature an importance score (1–10) based on how
directly it answers the question.

════════════════════════
SCORING SCALE
════════════════════════

10  — This feature IS the direct answer.
      (e.g. query "show wildfire perimeters in CA" → the fire polygon = 10)
${TIER_HIGH_MIN}–9 — Primary result, directly addresses the query.
${TIER_MEDIUM_MIN}–${TIER_HIGH_MIN - 1} — Strong supporting / contextual data.
2–${TIER_MEDIUM_MIN - 1} — Background, metadata, loosely related.
1   — Not relevant.

════════════════════════
ADDITIONAL RULES
════════════════════════

• Assign isPrimary = true to EXACTLY ONE feature — the single most important
  feature to focus map navigation on.
• When the query names a specific place or event, that feature is primary.
• For imagery queries (STAC, satellite photos), the footprint polygon is primary.
• When features are equally relevant, the first one is primary.
• layerOrder must list layer group names descending by priority so the renderer
  draws the most important group on top.

════════════════════════
SYMBOL TIER (from score)
════════════════════════

${buildTierPromptSection()}

Call submit_intent_scores exactly once.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function tierFromScore(score: number): SymbolTier {
  if (score >= TIER_HIGH_MIN) return "high";
  if (score >= TIER_MEDIUM_MIN) return "medium";
  return "low";
}

function buildDefaultScores(
  features: SynthesizedGeoResult["features"],
): IntentScoreResult {
  const allGroups = [...new Set(features.map((f) => f.layerGroup ?? "General"))];
  const scoredFeatures: FeatureScore[] = features.map((f, i) => ({
    index: i,
    layerGroup: f.layerGroup ?? "General",
    score: 7,
    isPrimary: i === 0,
    symbolTier: "medium",
  }));
  return { scoredFeatures, primaryIndex: 0, layerOrder: allGroups };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Score synthesized features by relevance to the user's original question.
 * Falls back to uniform medium scores if the LLM call fails.
 */
export async function scoreFeaturesByIntent(
  userQuery: string,
  result: SynthesizedGeoResult,
): Promise<IntentScoreResult> {
  const { features } = result;
  if (!features.length || !userQuery.trim()) {
    return buildDefaultScores(features);
  }

  const scoreTool = tool(
    async (args: any) => JSON.stringify(args),
    {
      name: "submit_intent_scores",
      description:
        "Submit the importance score for every feature. Call exactly once.",
      schema: z.object({
        scores: z.array(
          z.object({
            index: z.number().int().min(0),
            layerGroup: z.string(),
            score: z.number().int().min(1).max(10),
            isPrimary: z.boolean(),
          }),
        ),
        layerOrder: z.array(z.string()),
      }),
    },
  );

  // Compact feature summary to minimise token cost
  const featureSummary = features
    .map((f, i) => {
      const propSample = Object.entries(f.properties)
        .slice(0, 5)
        .map(([k, v]) => `${k}=${String(v ?? "").slice(0, 40)}`)
        .join(", ");
      return [
        `[${i}] "${f.title}"`,
        `  layerGroup: ${f.layerGroup ?? "General"}`,
        `  geometryType: ${f.geometryType}`,
        `  renderHint: ${f.renderHint}`,
        f.description ? `  description: ${f.description.slice(0, 100)}` : "",
        propSample ? `  props: ${propSample}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const prompt = [
    `User question: "${userQuery}"`,
    "",
    "Geographic features to score:",
    featureSummary,
  ].join("\n");

  try {
    const response = await invokeToolPrompt({
      promptText: SCORING_SYSTEM_PROMPT,
      messages: [new HumanMessage(prompt)],
      tools: [scoreTool],
      temperature: 0,
    });

    const toolCalls = Array.isArray((response as any)?.tool_calls)
      ? (response as any).tool_calls
      : [];
    const call = toolCalls.find(
      (tc: any) => tc?.name === "submit_intent_scores",
    );
    if (!call?.args) return buildDefaultScores(features);

    const rawScores: Array<{
      index: number;
      layerGroup: string;
      score: number;
      isPrimary: boolean;
    }> = Array.isArray(call.args.scores) ? call.args.scores : [];
    const layerOrder: string[] = Array.isArray(call.args.layerOrder)
      ? call.args.layerOrder
      : [];

    // Map raw scores, fill missing features with medium score
    const scoreMap = new Map(rawScores.map((s) => [s.index, s]));
    let primaryIndex = -1;
    const scoredFeatures: FeatureScore[] = features.map((f, i) => {
      const raw = scoreMap.get(i);
      const score = raw ? Math.max(1, Math.min(10, raw.score)) : 5;
      const isPrimary = raw?.isPrimary === true;
      if (isPrimary) primaryIndex = i;
      return {
        index: i,
        layerGroup: f.layerGroup ?? "General",
        score,
        isPrimary,
        symbolTier: tierFromScore(score),
      };
    });

    // Guarantee exactly one primary
    if (primaryIndex === -1) {
      const best = scoredFeatures.reduce((a, b) => (b.score > a.score ? b : a));
      best.isPrimary = true;
      primaryIndex = best.index;
    }

    // Build ordered layer list: explicit order first, then any missing groups
    const allGroups = [
      ...new Set(features.map((f) => f.layerGroup ?? "General")),
    ];
    const orderedGroups = [
      ...layerOrder.filter((g) => allGroups.includes(g)),
      ...allGroups.filter((g) => !layerOrder.includes(g)),
    ];

    return { scoredFeatures, primaryIndex, layerOrder: orderedGroups };
  } catch {
    return buildDefaultScores(features);
  }
}
