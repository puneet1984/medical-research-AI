import { executeInference } from '../services/openRouterService.js';
import { config } from '../config.js';

export interface QueryExpansionResult {
  originalQuery: string;
  expandedQuery: string;
  meshTerms: string[];
  umlsConcepts: string[];
  booleanQuery: string;
  targetPopulation: string;
  targetIntervention: string;
}

/**
 * Fallback heuristic expansion when inference is offline
 */
function heuristicExpand(query: string): QueryExpansionResult {
  const qLower = query.toLowerCase();
  const mesh: string[] = [];
  const umls: string[] = [];

  if (qLower.includes('heart failure') || qLower.includes('hfpef') || qLower.includes('hfref')) {
    mesh.push('Heart Failure [MeSH]', 'Heart Failure, Diastolic [MeSH]', 'Ventricular Function, Left [MeSH]');
    umls.push('C0018801 (Heart Failure)', 'C0264906 (Diastolic Heart Failure)');
  }
  if (qLower.includes('sglt2') || qLower.includes('dapagliflozin') || qLower.includes('empagliflozin')) {
    mesh.push('Sodium-Glucose Transporter 2 Inhibitors [MeSH]', 'Dapagliflozin [Supplementary Concept]');
    umls.push('C3886847 (SGLT-2 Inhibitor)');
  }
  if (qLower.includes('obesity') || qLower.includes('weight') || qLower.includes('glp-1') || qLower.includes('semaglutide') || qLower.includes('tirzepatide')) {
    mesh.push('Obesity [MeSH]', 'Glucagon-Like Peptide-1 Receptor Agonists [MeSH]', 'Weight Loss [MeSH]');
    umls.push('C0028754 (Obesity)', 'C2982845 (GLP-1 Agonist)');
  }
  if (qLower.includes('cancer') || qLower.includes('pembrolizumab') || qLower.includes('oncology') || qLower.includes('chemo')) {
    mesh.push('Neoplasms [MeSH]', 'Antineoplastic Agents, Immunological [MeSH]', 'Programmed Cell Death 1 Receptor [MeSH]');
    umls.push('C0006826 (Malignant Neoplasms)', 'C3886518 (Pembrolizumab)');
  }

  if (mesh.length === 0) {
    mesh.push(`${query} [MeSH]`, 'Therapeutics [MeSH]', 'Randomized Controlled Trial [Publication Type]');
    umls.push(`UMLS-Concept (${query})`);
  }

  const booleanQuery = `("${query}" OR "${mesh[0]?.split(' [')[0] || query}") AND (randomized controlled trial[Filter] OR clinical trial[Filter])`;

  return {
    originalQuery: query,
    expandedQuery: `${query} randomized controlled trial clinical outcomes`,
    meshTerms: mesh,
    umlsConcepts: umls,
    booleanQuery,
    targetPopulation: 'Adult clinical population matching study criteria',
    targetIntervention: query
  };
}

/**
 * Query Agent: Expands user query into technical MeSH/UMLS semantic terms
 */
export async function expandQuery(query: string): Promise<QueryExpansionResult> {
  const prompt = `You are a clinical biomedical informatics query agent. Expand this user clinical query into formal MeSH/UMLS ontology terms and a search string:

QUERY: "${query}"

Return valid JSON with these exact keys:
{
  "originalQuery": "${query}",
  "expandedQuery": "concise query enriched with clinical synonyms",
  "meshTerms": ["Term 1 [MeSH]", "Term 2 [MeSH]"],
  "umlsConcepts": ["CUI (Concept name)", "CUI (Concept name)"],
  "booleanQuery": "formal boolean search query with AND/OR and parentheses",
  "targetPopulation": "clinical patient cohort",
  "targetIntervention": "primary drug or therapy"
}

Provide ONLY raw JSON without markdown or code blocks.`;

  try {
    const { text } = await executeInference(prompt, {
      model: config.llmReasoningModel,
      temperature: 0.1,
      maxTokens: 800,
      systemPrompt: 'You are a biomedical terminology expert specializing in MeSH, UMLS, and clinical query expansion. Return only valid JSON.'
    });

    if (text) {
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.expandedQuery && Array.isArray(parsed.meshTerms)) {
        return {
          originalQuery: query,
          expandedQuery: parsed.expandedQuery,
          meshTerms: parsed.meshTerms,
          umlsConcepts: parsed.umlsConcepts || [],
          booleanQuery: parsed.booleanQuery || `${query} AND clinical trial`,
          targetPopulation: parsed.targetPopulation || 'Clinical cohort',
          targetIntervention: parsed.targetIntervention || query
        };
      }
    }
  } catch (err) {
    console.warn('[queryAgent] Inference expansion encountered note, using deterministic biomedical expansion:', err instanceof Error ? err.message : err);
  }

  return heuristicExpand(query);
}

export const queryAgent = {
  expandQuery
};
