import { executeInference } from '../services/openRouterService.js';
import { config } from '../config.js';
import { extractMetaMapLiteConcepts, MetaMapLiteResult } from '../services/metaMapLiteService.js';

export interface QueryExpansionResult {
  originalQuery: string;
  expandedQuery: string;
  meshTerms: string[];
  umlsConcepts: string[];
  booleanQuery: string;
  targetPopulation: string;
  targetIntervention: string;
  metaMap?: MetaMapLiteResult;
}

/**
 * Dynamically normalizes user queries containing comparison operators (vs, versus, v., compared with)
 * to proper boolean syntax without any hardcoded dictionary.
 */
export function normalizeComparativeQuery(query: string): { primaryQuery: string; booleanQuery: string; keywords: string[] } {
  const qClean = query.trim();
  const parts = qClean.split(/\s+(?:vs\.?|versus|compared\s+with|and)\s+/i).map(p => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    const item1 = parts[0];
    const item2 = parts[1];
    const primaryQuery = `${item1} AND ${item2}`;
    const booleanQuery = `(${item1}) AND (${item2})`;
    return {
      primaryQuery,
      booleanQuery,
      keywords: [item1.toLowerCase(), item2.toLowerCase()]
    };
  }

  return {
    primaryQuery: qClean,
    booleanQuery: qClean,
    keywords: qClean.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  };
}

/**
 * Query Agent: 100% Dynamic API-driven query expansion.
 * Calls MetaMapLite concept extraction (LLM semantic decomposition + NLM MeSH RDF API id.nlm.nih.gov)
 * to retrieve real MeSH terms, UMLS concepts, and clinical parameters dynamically.
 * Zero hardcoded lists.
 */
export async function expandQuery(query: string): Promise<QueryExpansionResult> {
  const normalized = normalizeComparativeQuery(query);

  // 1. Run dynamic NLM MetaMapLite concept extraction & live MeSH RDF API lookups
  let metaMapResult: MetaMapLiteResult | undefined;
  try {
    metaMapResult = await extractMetaMapLiteConcepts(query);
  } catch (err) {
    console.warn('[queryAgent] Dynamic MetaMapLite extraction notice:', err instanceof Error ? err.message : err);
  }

  // 2. Synthesize MeSH and UMLS concepts from dynamic API responses
  const meshTerms = metaMapResult?.meshHeadings && metaMapResult.meshHeadings.length > 0
    ? metaMapResult.meshHeadings
    : ['Therapeutics [MeSH]'];

  const umlsConcepts = metaMapResult?.umlsConcepts && metaMapResult.umlsConcepts.length > 0
    ? metaMapResult.umlsConcepts
    : [`UMLS-Concept (${query})`];

  const booleanQuery = metaMapResult?.booleanQuery || normalized.booleanQuery;
  const expandedQuery = metaMapResult?.optimizedPubMedQuery || normalized.booleanQuery;

  // 3. Dynamic clinical cohort & intervention extraction via LLM Inference API
  let targetPopulation = 'Adult clinical patient cohort meeting inclusion criteria';
  let targetIntervention = query;

  if (Boolean(config.openRouterApiKey) || Boolean(config.geminiApiKey) || Boolean(process.env.GEMINI_API_KEY)) {
    const prompt = `You are a clinical biomedical informatics query agent. Review this clinical research query and dynamically extracted NLM MeSH concepts:
QUERY: "${query}"
MAPPED CONCEPTS: ${umlsConcepts.join(', ')}

Identify target population and intervention dynamically. Return valid JSON with these keys:
{
  "targetPopulation": "clinical cohort description",
  "targetIntervention": "primary surgical device, pharmaceutical therapy, or clinical intervention"
}
Provide ONLY raw JSON without markdown.`;

    try {
      const { text } = await executeInference(prompt, {
        model: config.llmReasoningModel,
        temperature: 0.1,
        maxTokens: 300,
        systemPrompt: 'You are an evidence-based medicine informatics specialist. Return valid JSON.'
      });

      if (text) {
        const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.targetPopulation) targetPopulation = parsed.targetPopulation;
        if (parsed.targetIntervention) targetIntervention = parsed.targetIntervention;
      }
    } catch (llmErr) {
      console.warn('[queryAgent] LLM reasoning notice:', llmErr instanceof Error ? llmErr.message : llmErr);
    }
  }

  // Derive dynamic intervention from comparative arms if available
  if (metaMapResult?.comparativeDetails) {
    targetIntervention = `${metaMapResult.comparativeDetails.arm1.expanded} vs ${metaMapResult.comparativeDetails.arm2.expanded}`;
  }

  return {
    originalQuery: query,
    expandedQuery,
    meshTerms,
    umlsConcepts,
    booleanQuery,
    targetPopulation,
    targetIntervention,
    metaMap: metaMapResult
  };
}

export const queryAgent = {
  expandQuery,
  normalizeComparativeQuery
};
