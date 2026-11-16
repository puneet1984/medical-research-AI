import { executeInference } from '../services/openRouterService.js';
import { MedicalDocument } from '../services/searchService.js';
import { config } from '../config.js';
import { humanizeMedicalProse } from '../services/paperDraftService.js';
import {
  pluralizeStudyDesign,
  sanitizeDocumentMetadata,
  rankAndFilterStudiesForQuestion,
  formatPublicationYear
} from '../services/corpusContextBuilder.js';

export interface SynthesisResult {
  markdown: string;
  citedSources: string[];
  provider: string;
  modelUsed: string;
}

/**
 * Builds deterministic clinical synthesis when AI model is offline
 */
function buildDeterministicSynthesis(query: string, docs: MedicalDocument[]): string {
  const topDocs = docs.slice(0, 6).map(sanitizeDocumentMetadata);
  const citations = topDocs.map(d => `[${d.firstAuthor}, ${formatPublicationYear(d.year)} (${d.pmid ? `PMID:${d.pmid}` : (d.doi || d.id)})]`);

  const validSampleSizes = topDocs
    .map(d => d.pico.sampleSize)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  const sampleBoundaryText = validSampleSizes.length > 0
    ? `N = ${Math.min(...validSampleSizes).toLocaleString()} to N = ${Math.max(...validSampleSizes).toLocaleString()} patients`
    : 'Not reported in the retrieved studies';

  const designCounts: Record<string, number> = {};
  for (const d of topDocs) {
    const design = d.pico.design || 'Clinical Trial';
    designCounts[design] = (designCounts[design] || 0) + 1;
  }
  const designDistributionText = Object.entries(designCounts)
    .map(([design, count]) => `${count} ${pluralizeStudyDesign(design, count)}`)
    .join(', ') || '0 studies';

  return `### Executive Clinical Summary
Based on multi-database retrieval of ${docs.length} peer-reviewed clinical studies, evidence regarding **"${query}"** was evaluated across retrieved primary cohorts and clinical endpoints.

---

### PICO Evidence Breakdown

#### 👥 1. Population (P)
- **Cohort Profile:** Studied populations strictly reflect retrieved clinical cohorts matching the search query.
- **Sample Enrolled:** Reported participant boundaries span ${sampleBoundaryText}.
- **Key Evidence:** ${topDocs[0]?.pico.population && topDocs[0].pico.population !== 'Not reported' ? topDocs[0].pico.population : 'Not reported in the retrieved studies'} ${citations[0] || ''}.

#### 💊 2. Intervention & Regimens (I)
- **Active Regimen:** Evaluated therapeutic regimens focus on ${topDocs[0]?.pico.intervention && topDocs[0].pico.intervention !== 'Not reported' ? topDocs[0].pico.intervention : 'Not reported in the retrieved studies'} ${citations[0] || ''}.

#### ⚖️ 3. Comparator (C)
- **Control Arm:** ${topDocs[0]?.pico.comparator && topDocs[0].pico.comparator !== 'Not reported' ? topDocs[0].pico.comparator : 'Not reported in the retrieved studies'} ${citations[0] || ''}.

#### 🎯 4. Outcomes & Effect Sizes (O)
- **Statistical Significance:**
${topDocs.map((d, i) => `  - **${d.firstAuthor} et al. (${formatPublicationYear(d.year)}):** ${d.pico.primaryOutcome && d.pico.primaryOutcome !== 'Not reported' ? d.pico.primaryOutcome : 'Primary outcome not reported'} — ${d.pico.primaryStatistic ? `Primary Stat: \`${d.pico.primaryStatistic}\`, ` : ''}${d.pico.hazardRatio ? `Hazard Ratio: \`${d.pico.hazardRatio}\`, ` : ''}${d.pico.riskRatio ? `Risk Ratio: \`${d.pico.riskRatio}\`, ` : ''}\`${d.pico.pValues.length > 0 ? d.pico.pValues.join(', ') : 'p-value: Not reported'}\` ${citations[i] || ''}.`).join('\n')}

---

### Study Design Hierarchy & Risk of Bias
- **Design Distribution:** Comprises ${designDistributionText}.
- **Quality Tiering:** Methodological quality reflects the retrieved study designs listed above.

---

### Cited Clinical Trials & Literature
${topDocs.map((d, i) => `${i + 1}. **${d.firstAuthor} et al. (${formatPublicationYear(d.year)})** — *${d.title}*. **${d.journal}**. ${d.doi ? `DOI: [${d.doi}](https://doi.org/${d.doi}) | ` : ''}PMID: \`${d.pmid || 'N/A'}\``).join('\n')}
`;
}

/**
 * Synthesis Agent: Compiles payload context and synthesizes structured clinical answer
 */
export async function synthesizeLiterature(
  query: string,
  documents: MedicalDocument[]
): Promise<SynthesisResult> {
  if (documents.length === 0) {
    return {
      markdown: `No verified clinical literature was retrieved for "${query}". Try expanding search keywords or selecting a landmark trial.`,
      citedSources: [],
      provider: 'rule_engine',
      modelUsed: 'fallback'
    };
  }

  const rankedDocs = rankAndFilterStudiesForQuestion(documents, query).relevantStudies;
  const activeDocs = rankedDocs.length > 0 ? rankedDocs : documents.map(sanitizeDocumentMetadata);

  // Format context for prompt with explicit citation keys
  const contextFormatted = activeDocs.slice(0, 8).map((doc, idx) => {
    const yearLabel = formatPublicationYear(doc.year);
    const citationKey = `[${doc.firstAuthor}, ${yearLabel} (${doc.pmid ? `PMID:${doc.pmid}` : (doc.doi || doc.id)})]`;
    const fullTextExcerpt = doc.hasFullText && doc.fullText
      ? `\n- PMC Open-Access Full-Text Excerpt (${doc.pmcid || 'PMC'}):\n${doc.fullText.slice(0, 3500)}`
      : '';
    return `### Source ${idx + 1}: ${citationKey}
- Title: ${doc.title}
- Authors: ${doc.authors.slice(0, 5).join(', ')} et al.
- Journal: ${doc.journal} (${yearLabel})
- DOI: ${doc.doi || 'N/A'}${doc.pmid ? ` | PMID: ${doc.pmid}` : ''}${doc.pmcid ? ` | PMCID: ${doc.pmcid}` : ''}
- Study Design: ${doc.pico.design}
- Population (N): ${doc.pico.population} (N = ${doc.pico.sampleSize > 0 ? doc.pico.sampleSize : 'Not reported'})
- Intervention: ${doc.pico.intervention}
- Comparator: ${doc.pico.comparator}
- Outcome: ${doc.pico.primaryOutcome}
- Quantitative Metrics: ${doc.pico.primaryStatistic ? `Primary Stat: ${doc.pico.primaryStatistic}, ` : ''}${doc.pico.hazardRatio ? `HR: ${doc.pico.hazardRatio}, ` : ''}${doc.pico.riskRatio ? `RR: ${doc.pico.riskRatio}, ` : ''}${doc.pico.pValues.length > 0 ? doc.pico.pValues.join(', ') : 'p-value: Not reported'}
- Abstract: ${doc.abstract || 'Not reported in source metadata.'}${fullTextExcerpt}
`;
  }).join('\n---\n');

  const systemPrompt = `You are a Senior Evidence-Based Medicine (EBM) Clinical Research Scientist. 
Your goal is to synthesize medical literature into an authoritative clinical research report matching rigorous PICO evidence standards.

CRITICAL CITATION RULES:
1. Every major clinical claim, metric, outcome, or statistic MUST include an explicit bracket citation matching the EXACT format: [Author, Year (DOI)].
2. Use ONLY the provided sources. Do NOT invent citations or references.
3. Structure your response with the strict PICO clinical framework:
   - Executive Clinical Summary (Bottom line)
   - Population & Eligibility Criteria (P)
   - Interventions & Dosing Protocols (I)
   - Comparators & Control Arms (C)
   - Outcomes, Effect Sizes & Quantitative Statistics (O) (include Hazard Ratios, Risk Ratios, p-values, Sample size N)
   - Study Design Hierarchy & Methodological Quality (RCTs vs Cohorts, PRISMA/CONSORT tiering)
   - Clinical Recommendations & Research Gaps
    - References Section with active links.
4. MEDICAL JOURNAL TYPOGRAPHY & HUMANIZED VOICE:
   - Use standard medical journal statistical formatting without LaTeX dollar signs (e.g. write 'p < 0.05' or '(p = 0.012)', NEVER '$p < 0.05$' or '$p$').
   - For sample sizes write 'N = 2,500' without dollar signs.
   - Write in an authentic, natural clinician-scientist voice. Avoid robotic, repetitive, or overly agentic jargon like 'were synthesized', 'agentic pipeline', 'isolated PICO parameters', or 'executed literature query'.
5. Output clean, pristine Markdown.`;

  const userPrompt = `CLINICAL QUERY: "${query}"

RETRIEVED EVIDENCE SOURCES (${documents.length} studies):
${contextFormatted}

Please produce a comprehensive, structured PICO clinical synthesis report for this medical literature query. Ensure every quantitative finding is cited with [Author, Year (DOI)].`;

  try {
    const { text, provider, modelUsed } = await executeInference(userPrompt, {
      model: config.llmSynthesisModel,
      temperature: 0.2,
      maxTokens: 3500,
      systemPrompt
    });

    if (text && text.trim().length > 100) {
      const sanitizedText = humanizeMedicalProse(text);
      // Extract all citations used in brackets
      const citationMatches = sanitizedText.match(/\[[A-Za-z\s–-]+,\s*\d{4}\s*\([^)]+\)\]/g) || [];
      return {
        markdown: sanitizedText,
        citedSources: Array.from(new Set(citationMatches)),
        provider,
        modelUsed
      };
    }
  } catch (err) {
    console.warn('[synthesisAgent] Inference synthesis note, using structured clinical builder:', err instanceof Error ? err.message : err);
  }

  const fallbackMarkdown = humanizeMedicalProse(buildDeterministicSynthesis(query, activeDocs));
  const citationMatches = fallbackMarkdown.match(/\[[A-Za-z\s–-]+,\s*\d{4}\s*\([^)]+\)\]/g) || [];

  return {
    markdown: fallbackMarkdown,
    citedSources: Array.from(new Set(citationMatches)),
    provider: 'clinical_rule_engine',
    modelUsed: 'deterministic-pico'
  };
}

export const synthesisAgent = {
  synthesizeLiterature
};
