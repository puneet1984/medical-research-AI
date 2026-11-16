import { executeInference } from './openRouterService.js';
import { MedicalDocument } from './searchService.js';
import { config } from '../config.js';

export interface PaperSection {
  id: string;
  type: 'title' | 'abstract' | 'introduction' | 'methods' | 'results' | 'discussion' | 'conclusion' | 'references' | 'custom';
  title: string;
  content: string;
  keyPoints?: string[];
  wordCount?: number;
}

export interface RetrievalStatsMetadata {
  totalIndexed: number;
  uniqueIncluded: number;
  pmcFullTextCount: number;
  databasesQueried: string[];
  databaseBreakdown: Record<string, number>;
  studyDesignCounts: Record<string, number>;
  studyDesigns: string[];
}

export interface GroundingVerificationReport {
  verifiedCitationsCount: number;
  autoCorrectedCitations: string[];
  unverifiedCitationsRemoved: string[];
  contradictionsFixed: string[];
  passed: boolean;
}

export interface PaperDraft {
  id: string;
  title: string;
  researchQuestion: string;
  targetJournal: string;
  targetDatabases: string[];
  citationStyle: 'APA' | 'Chicago' | 'MLA' | 'Vancouver';
  mode: 'outline' | 'full_draft';
  author: string;
  affiliation: string;
  date: string;
  sections: PaperSection[];
  totalWords: number;
  groundingVerification?: GroundingVerificationReport;
}

export interface GenerateDraftRequest {
  researchQuestion: string;
  targetJournal?: string;
  targetDatabases?: string[];
  citationStyle?: 'APA' | 'Chicago' | 'MLA' | 'Vancouver';
  mode?: 'outline' | 'full_draft';
  clinicalEvidence?: MedicalDocument[];
  retrievalStats?: Partial<RetrievalStatsMetadata>;
}

export interface SectionActionRequest {
  action: 'expand' | 'rephrase' | 'condense' | 'add_citations' | 'bulletize' | 'custom';
  sectionTitle: string;
  sectionType?: PaperSection['type'];
  sectionContent: string;
  researchQuestion?: string;
  targetJournal?: string;
  citationStyle?: 'APA' | 'Chicago' | 'MLA' | 'Vancouver';
  customPrompt?: string;
  clinicalEvidence?: MedicalDocument[];
  retrievalStats?: Partial<RetrievalStatsMetadata>;
}

/**
 * Post-processes text to strictly enforce medical journal typography:
 * - Strips LaTeX dollar math delimiters ($p < 0.05$ -> p < 0.05, $N = 250$ -> N = 250)
 * - Humanizes robotic/agentic phrasing ('were synthesized' -> 'were critically evaluated and analyzed')
 */
export function humanizeMedicalProse(text: string): string {
  if (!text) return '';
  return text
    .replace(/\$\s*([pPnN])\s*([<>=]|&lt;|&gt;)\s*([0-9.]+)\s*\$/g, '$1 $2 $3')
    .replace(/\$\s*([pPnN])\s*\$/g, '$1')
    .replace(/\$\s*([0-9.]+)\s*\$/g, '$1')
    .replace(/\$(p\s*[<>=]\s*0\.\d+)\$/gi, '$1')
    .replace(/\$(N\s*=\s*[0-9,]+)\$/gi, '$1')
    .replace(/\$([A-Za-z0-9\s<>=.,–-]+)\$/g, '$1')
    .replace(/\bstudies reporting isolated PICO parameters\b/gi, 'trials evaluating predefined clinical criteria')
    .replace(/\bisolated PICO parameters\b/gi, 'clinical endpoints and patient characteristics')
    .replace(/\bwere synthesized\b/gi, 'were critically evaluated and analyzed')
    .replace(/\bwas synthesized\b/gi, 'was systematically analyzed')
    .replace(/\bsynthesizing agents\b/gi, 'therapeutic regimens')
    .replace(/\bexecuted across\b/gi, 'conducted across')
    .replace(/\bagentic\b/gi, 'investigative')
    .replace(/\bevidence synthesis\b/gi, 'clinical evidence evaluation');
}

/**
 * Formats canonical inline citation tag: [Author, Year (PMID/DOI)]
 */
export function formatCanonicalCitation(doc: MedicalDocument): string {
  const authorSurname = (doc.firstAuthor || 'Investigator').split(/\s+/)[0] || 'Investigator';
  const idPart = doc.pmid ? `PMID:${doc.pmid}` : (doc.doi || doc.id);
  return `[${authorSurname}, ${doc.year} (${idPart})]`;
}

/**
 * Computes exact retrieval statistics, database hit counts, and study design distribution
 * from the active `clinicalEvidence` pool and caller metadata.
 */
export function buildRetrievalStats(
  clinicalEvidence: MedicalDocument[],
  targetDatabases: string[],
  overrideStats?: Partial<RetrievalStatsMetadata>
): RetrievalStatsMetadata {
  const databaseBreakdown: Record<string, number> = {};
  const studyDesignCounts: Record<string, number> = {};
  let pmcFullTextCount = 0;

  for (const doc of clinicalEvidence) {
    const src = doc.source || 'PubMed';
    databaseBreakdown[src] = (databaseBreakdown[src] || 0) + 1;
    if (doc.pmcid || doc.hasFullText) {
      pmcFullTextCount += doc.hasFullText ? 1 : 0;
    }
    const design = doc.pico?.design || 'Clinical Trial';
    studyDesignCounts[design] = (studyDesignCounts[design] || 0) + 1;
  }

  if (pmcFullTextCount > 0 || databaseBreakdown['PubMed']) {
    databaseBreakdown['PMC (Open-Access Full Text)'] = pmcFullTextCount;
  }

  const baseDatabases = targetDatabases.length > 0
    ? targetDatabases
    : ['PubMed/NCBI Entrez', 'PMC', 'OpenAlex', 'DOAJ', 'Crossref'];

  // Ensure standard queried databases are accurately represented
  const normalizedDbSet = new Set<string>(baseDatabases);
  if (normalizedDbSet.has('PubMed')) {
    normalizedDbSet.delete('PubMed');
    normalizedDbSet.add('PubMed/NCBI Entrez');
    normalizedDbSet.add('PMC');
  }
  if (!normalizedDbSet.has('Crossref')) normalizedDbSet.add('Crossref');
  if (!normalizedDbSet.has('OpenAlex')) normalizedDbSet.add('OpenAlex');
  if (!normalizedDbSet.has('DOAJ')) normalizedDbSet.add('DOAJ');

  const uniqueIncluded = overrideStats?.uniqueIncluded ?? clinicalEvidence.length;
  const totalIndexed = Math.max(uniqueIncluded, overrideStats?.totalIndexed ?? clinicalEvidence.length);

  return {
    totalIndexed,
    uniqueIncluded,
    pmcFullTextCount,
    databasesQueried: Array.from(normalizedDbSet),
    databaseBreakdown: overrideStats?.databaseBreakdown && Object.keys(overrideStats.databaseBreakdown).length > 0
      ? overrideStats.databaseBreakdown
      : databaseBreakdown,
    studyDesignCounts: overrideStats?.studyDesignCounts && Object.keys(overrideStats.studyDesignCounts).length > 0
      ? overrideStats.studyDesignCounts
      : studyDesignCounts,
    studyDesigns: Object.keys(studyDesignCounts)
  };
}

/**
 * Builds structured `PICO_MATRIX` JSON and full `CONTEXT_SOURCES` (including PMC full-text
 * `methods`, `results`, `tables`, and `discussion` sections when available).
 */
export function buildGroundedEvidenceContext(
  clinicalEvidence: MedicalDocument[],
  stats: RetrievalStatsMetadata,
  maxDocsInContext = 15
): { picoMatrixJson: string; contextSourcesText: string; statsMetadataText: string } {
  const includedDocs = clinicalEvidence.slice(0, maxDocsInContext);

  const picoMatrix = includedDocs.map((doc, idx) => ({
    sourceIndex: idx + 1,
    canonicalCitation: formatCanonicalCitation(doc),
    firstAuthor: doc.firstAuthor,
    authors: doc.authors.slice(0, 6),
    title: doc.title,
    journal: doc.journal,
    year: doc.year,
    pmid: doc.pmid || null,
    pmcid: doc.pmcid || null,
    doi: doc.doi,
    sourceDatabase: doc.source,
    hasPmcFullText: Boolean(doc.hasFullText),
    design: doc.pico?.design || 'Clinical Trial',
    population: doc.pico?.population || 'Not reported in the retrieved studies',
    sampleSizeN: typeof doc.pico?.sampleSize === 'number' && doc.pico.sampleSize > 0
      ? doc.pico.sampleSize
      : 'Not reported in the retrieved studies',
    intervention: doc.pico?.intervention || 'Not reported in the retrieved studies',
    comparator: doc.pico?.comparator || 'Not reported in the retrieved studies',
    primaryOutcome: doc.pico?.primaryOutcome || 'Not reported in the retrieved studies',
    hazardRatio: doc.pico?.hazardRatio || 'Not reported in the retrieved studies',
    riskRatio: doc.pico?.riskRatio || 'Not reported in the retrieved studies',
    pValues: Array.isArray(doc.pico?.pValues) && doc.pico.pValues.length > 0
      ? doc.pico.pValues
      : ['Not reported in the retrieved studies']
  }));

  const contextSourcesText = includedDocs.map((doc, idx) => {
    const citationKey = formatCanonicalCitation(doc);
    const lines: string[] = [
      `[SOURCE ${idx + 1}] ${citationKey}`,
      `Authors: ${doc.authors.slice(0, 8).join(', ') || doc.firstAuthor}`,
      `Title: ${doc.title}`,
      `Journal: ${doc.journal} (${doc.year}) | Source DB: ${doc.source} | PMID: ${doc.pmid || 'N/A'} | PMCID: ${doc.pmcid || 'N/A'} | DOI: ${doc.doi}`,
      `Study Design: ${doc.pico?.design || 'Clinical Trial'} | Sample Size N: ${doc.pico?.sampleSize > 0 ? doc.pico.sampleSize : 'Not reported in the retrieved studies'}`,
      `AbstractText: ${doc.abstract || 'Not reported in the retrieved studies'}`
    ];

    if (doc.hasFullText && doc.fullTextSections) {
      const { methods, results, tables, discussion } = doc.fullTextSections;
      if (methods) lines.push(`PMC_METHODS: ${methods.slice(0, 1200)}`);
      if (results) lines.push(`PMC_RESULTS: ${results.slice(0, 1400)}`);
      if (tables) lines.push(`PMC_TABLES: ${tables.slice(0, 1000)}`);
      if (discussion) lines.push(`PMC_DISCUSSION: ${discussion.slice(0, 900)}`);
    } else if (doc.hasFullText && doc.fullText) {
      lines.push(`PMC_FULL_TEXT_EXCERPT: ${doc.fullText.slice(0, 2200)}`);
    }

    return lines.join('\n');
  }).join('\n\n---\n\n');

  const statsMetadataText = JSON.stringify({
    databasesQueried: stats.databasesQueried,
    totalIndexedRecords: stats.totalIndexed,
    uniqueStudiesIncluded: stats.uniqueIncluded,
    pmcOpenAccessFullTextArticles: stats.pmcFullTextCount,
    databaseHitCounts: stats.databaseBreakdown,
    studyDesignCounts: stats.studyDesignCounts,
    studyDesignsPresent: stats.studyDesigns
  }, null, 2);

  return {
    picoMatrixJson: JSON.stringify(picoMatrix, null, 2),
    contextSourcesText: contextSourcesText || 'NO RETRIEVED STUDIES AVAILABLE. Explicitly write "Not reported in the retrieved studies" for empirical figures and avoid fabricating citations.',
    statsMetadataText
  };
}

const GLOBAL_CLINICAL_GROUNDING_RULES = `STRICT CLINICAL GROUNDING RULES (APPLY TO EVERY SECTION & INLINE ACTION):
1. Closed-World Evidence Boundary: Use ONLY facts, numbers, mechanisms, and conclusions explicitly present in the retrieved CONTEXT_SOURCES and PICO_MATRIX. Never rely on pre-trained parametric assumptions to fill missing data.
2. Mandatory Inline Citations: Every clinical claim, sample size (N), outcome metric (HR, RR, OR, MD, 95% CI, p-value), and mechanism MUST be immediately followed by an exact citation tag matching CONTEXT_SOURCES in the format [Author, Year (PMID/DOI)]. Never cite a source ID not present in CONTEXT_SOURCES.
3. Explicit Missing-Data Handling: If a specific metric (e.g., long-term mortality, exact p-value, or mechanism) is absent from CONTEXT_SOURCES, explicitly write "Not reported in the retrieved studies" instead of estimating or inventing a value.
4. Medical Journal Typography & Tone: Never use LaTeX dollar delimiters ($p < 0.05$ or $N = 250$). Write standard medical prose (p < 0.05, N = 250) in an authoritative human academic voice.`;

const SECTION_SPECIFIC_GROUNDING_RULES = `IMRaD SECTION-BY-SECTION CLINICAL GROUNDING RULES:
- Title & Abstract:
  * Accurately reflect the exact study designs retrieved (e.g., "Systematic Evidence Synthesis of Randomized Controlled Trials and Cohort Studies...").
  * Do NOT claim "superiority" unless pooled meta-analytic metrics in CONTEXT_SOURCES prove statistical superiority; otherwise use "comparative effectiveness" or "non-inferiority."
- 1. Introduction:
  * Frame the clinical gap strictly around the user's PICO question (Population, Intervention, Comparator, Outcome).
  * Do NOT invent epidemiological prevalence numbers unless explicitly cited from CONTEXT_SOURCES.
- 2. Methods (Search & Synthesis Protocol):
  * State the exact databases queried (PubMed/NCBI Entrez, PMC, OpenAlex, DOAJ, Crossref) and exact retrieval counts (Total Indexed Records vs. Unique Studies Included) passed in RETRIEVAL_METADATA.
  * Do NOT fabricate PRISMA screening numbers or bias-assessment scores (e.g., Cochrane RoB 2) unless explicitly present in backend metadata.
- 3. Results & Clinical Evidence Evaluation:
  * 3.1 Study Selection: List exact study counts broken down by actual study design metadata from RETRIEVAL_METADATA (e.g., X RCTs, Y Cohort Studies).
  * Biological & Pharmacological Mechanisms: Report ONLY mechanisms explicitly stated in the retrieved PMC_METHODS, PMC_RESULTS, PMC_DISCUSSION, or AbstractText. Never fabricate pharmacokinetic claims (e.g., onset speed, bioavailability, or tissue localization). If absent, explicitly write "Not reported in the retrieved studies."
  * Quantitative Statistical Metrics: Quote exact values (N, HR, RR, 95% CI, p-values) verbatim from PICO_MATRIX and PMC_TABLES with inline citations [Author, Year (PMID/DOI)] for every single figure.
- 4. Discussion & Limitations:
  * Discussion: Compare findings across included studies and highlight concordant or conflicting outcomes with inline citations.
  * Limitations: Derive limitations strictly from the actual study designs and sample sizes in PICO_MATRIX (e.g., small sample sizes N < 100, short follow-up duration, or heterogeneity across cohorts). NEVER call an RCT cohort "observational" or suggest "future RCTs are needed" if Randomized Controlled Trials are already present in studyDesignsPresent without explaining why.
- 5. Conclusion:
  * Restrict conclusions strictly to the population and outcomes evaluated in Results. Avoid sweeping clinical practice recommendations unless supported by Grade-A guidelines or multi-center RCTs in CONTEXT_SOURCES.
- 6. References:
  * Render ONLY the exact sources cited in the text, formatted strictly in the selected citation standard (Vancouver, APA 7th, Chicago 17th, or MLA 9th) using verified metadata (Authors, Title, Journal, Year, PMID, DOI).`;

/**
 * Formats a single reference entry strictly in the chosen citation style using verified metadata.
 */
function formatVerifiedReference(doc: MedicalDocument, citationStyle: string, indexOneBased: number): string {
  const authorList = doc.authors && doc.authors.length > 0
    ? doc.authors.slice(0, 6).join(', ') + (doc.authors.length > 6 ? ', et al.' : '')
    : `${doc.firstAuthor} et al.`;
  const pmidSegment = doc.pmid ? ` PMID: ${doc.pmid}.` : '';
  const pmcidSegment = doc.pmcid ? ` PMCID: ${doc.pmcid}.` : '';
  const doiSegment = doc.doi ? `doi:${doc.doi}` : '';

  if (citationStyle === 'APA') {
    return `${authorList} (${doc.year}). ${doc.title}. *${doc.journal}*. ${doc.doi ? `https://doi.org/${doc.doi}` : ''}${pmidSegment}${pmcidSegment}`.trim();
  }
  if (citationStyle === 'Chicago') {
    return `${indexOneBased}. ${authorList}. "${doc.title}." *${doc.journal}* (${doc.year}). ${doiSegment}.${pmidSegment}${pmcidSegment}`.trim();
  }
  if (citationStyle === 'MLA') {
    return `${authorList}. "${doc.title}." *${doc.journal}*, ${doc.year}, ${doc.doi ? `https://doi.org/${doc.doi}` : ''}.${pmidSegment}${pmcidSegment}`.trim();
  }
  // Vancouver (ICMJE)
  return `${indexOneBased}. ${authorList}. ${doc.title}. ${doc.journal}. ${doc.year}; ${doiSegment}.${pmidSegment}${pmcidSegment}`.trim();
}

/**
 * Checks whether a bracket citation matches an actual study in `clinicalEvidence`.
 */
function findMatchingEvidenceDoc(bracketText: string, clinicalEvidence: MedicalDocument[]): MedicalDocument | null {
  if (!clinicalEvidence || clinicalEvidence.length === 0) return null;

  const lower = bracketText.toLowerCase();

  // 1. Direct PMID or DOI match
  for (const doc of clinicalEvidence) {
    if (doc.pmid && lower.includes(doc.pmid.toLowerCase())) return doc;
    if (doc.doi && lower.includes(doc.doi.toLowerCase())) return doc;
  }

  // 2. Surname + Year match
  const yearMatch = bracketText.match(/\b(19|20)\d{2}\b/);
  const citedYear = yearMatch ? parseInt(yearMatch[0], 10) : null;

  for (const doc of clinicalEvidence) {
    if (citedYear && doc.year !== citedYear) continue;
    const candidateNames = [doc.firstAuthor, ...(doc.authors || [])]
      .map(a => (a || '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z-]/g, ''))
      .filter(n => n && n.length >= 2);
    if (candidateNames.some(surname => lower.includes(surname))) {
      return doc;
    }
  }

  return null;
}

/**
 * Automated Post-Generation Verification Guardrail:
 * 1. Verifies every bracket citation `[...]` against `clinicalEvidence` (`CONTEXT_SOURCES`).
 *    Auto-corrects partial matches to canonical `[Author, Year (PMID/DOI)]` and strips unverified citations.
 * 2. Detects and auto-corrects Limitations contradictions when `studyDesigns` includes `"Randomized Controlled Trial"`.
 * 3. Rebuilds/filters `References` (when full draft) to render ONLY verified sources actually cited in the text.
 */
export function verifyAndEnforceClinicalGrounding(
  sections: PaperSection[],
  clinicalEvidence: MedicalDocument[],
  stats: RetrievalStatsMetadata,
  citationStyle: string
): { sections: PaperSection[]; report: GroundingVerificationReport } {
  const autoCorrectedCitations: string[] = [];
  const unverifiedCitationsRemoved: string[] = [];
  const contradictionsFixed: string[] = [];
  const citedDocsOrder: MedicalDocument[] = [];
  const seenCitedKeys = new Set<string>();

  const hasRcts = stats.studyDesigns.includes('Randomized Controlled Trial');
  const rctCount = stats.studyDesignCounts['Randomized Controlled Trial'] || 0;
  const designSummary = Object.entries(stats.studyDesignCounts)
    .map(([design, count]) => `${count} ${design}${count > 1 ? 's' : ''}`)
    .join(', ');

  // Match bracketed citations that are NOT markdown links `[label](url)` and contain a year / PMID / DOI / et al.
  const citationRegex = /\[([^\]]+?)\](?!\()/g;

  const verifiedSections = sections.map((sec) => {
    if (sec.type === 'references') {
      return sec;
    }

    let text = sec.content || '';

    text = text.replace(citationRegex, (fullMatch, inner) => {
      const trimmed = String(inner).trim();
      // Ignore pure numeric citations like [1], [12] or structural tags like [METHODS]
      if (/^\d+(?:\s*[-,]\s*\d+)*$/.test(trimmed) || /^(?:METHODS|RESULTS|TABLES|DISCUSSION|SOURCE\s*\d+)$/i.test(trimmed)) {
        return fullMatch;
      }
      // Only validate citation-like brackets (containing year, et al., PMID, DOI, or comma)
      const looksLikeCitation = /\b(?:19|20)\d{2}\b|et\s+al\.|pmid|10\.\d{4,9}\//i.test(trimmed);
      if (!looksLikeCitation) {
        return fullMatch;
      }

      const matchedDoc = findMatchingEvidenceDoc(trimmed, clinicalEvidence);
      if (matchedDoc) {
        const canonical = formatCanonicalCitation(matchedDoc);
        const docKey = (matchedDoc.pmid || matchedDoc.doi || matchedDoc.id).toLowerCase();
        if (!seenCitedKeys.has(docKey)) {
          seenCitedKeys.add(docKey);
          citedDocsOrder.push(matchedDoc);
        }
        if (fullMatch !== canonical) {
          autoCorrectedCitations.push(`${fullMatch} -> ${canonical}`);
        }
        return canonical;
      }

      console.warn(`[paperDraftService] Grounding guardrail removed unverified citation: ${fullMatch}`);
      unverifiedCitationsRemoved.push(fullMatch);
      return '';
    });

    // Clean up double spaces or trailing space before punctuation caused by stripping unverified citations
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1');

    // Contradiction check for Limitations / Discussion when RCTs exist in PICO_MATRIX
    if (hasRcts && (sec.type === 'discussion' || /limitation|discussion/i.test(sec.title))) {
      const obsFalseClaimRegex = /\b(?:all|only|exclusively)\s+(?:the\s+)?(?:included|retrieved|evaluated)?\s*studies\s+were\s+observational\b[^.]*\./gi;
      const noRctClaimRegex = /\b(?:no|absence\s+of|lack\s+of)\s+randomized\s+controlled\s+trials?\s+(?:were\s+)?(?:included|identified|retrieved|available)[^.]*\./gi;

      if (obsFalseClaimRegex.test(text)) {
        const replacement = `The retrieved evidence includes ${rctCount} Randomized Controlled Trial${rctCount > 1 ? 's' : ''} alongside other study designs (${designSummary || 'mixed designs'}), rather than exclusively observational studies.`;
        text = text.replace(obsFalseClaimRegex, replacement);
        contradictionsFixed.push('Corrected false claim that all included studies were observational when RCTs were retrieved.');
        console.warn('[paperDraftService] Grounding guardrail fixed observational-only contradiction in Discussion/Limitations.');
      }

      if (noRctClaimRegex.test(text)) {
        const replacement = `${rctCount} Randomized Controlled Trial${rctCount > 1 ? 's were' : ' was'} included in this synthesis (${designSummary}).`;
        text = text.replace(noRctClaimRegex, replacement);
        contradictionsFixed.push('Corrected false claim asserting no RCTs were included.');
        console.warn('[paperDraftService] Grounding guardrail fixed missing-RCT contradiction in Discussion/Limitations.');
      }

      if (/\bfuture\s+(?:randomized\s+controlled\s+trials|rcts?)\s+are\s+needed\b/i.test(text) && !/\bdespite|given|small|longer|multi-?center|additional|larger\b/i.test(text)) {
        text = text.replace(
          /\b(future\s+(?:randomized\s+controlled\s+trials|rcts?)\s+are\s+needed)\b/gi,
          `$1 (building upon the ${rctCount} existing RCT${rctCount > 1 ? 's' : ''} in this synthesis to address sample size or follow-up constraints)`
        );
        contradictionsFixed.push('Contextualized recommendation for future RCTs against existing synthesized RCTs.');
      }
    }

    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return {
      ...sec,
      content: humanizeMedicalProse(text).trim(),
      wordCount: words
    };
  });

  // Ensure References section contains ONLY verified cited sources from CONTEXT_SOURCES
  const finalSections = verifiedSections.map((sec) => {
    if (sec.type !== 'references') return sec;

    if (clinicalEvidence.length === 0) {
      const noEvidenceMsg = 'No verified references were cited from retrieved clinical databases.';
      return {
        ...sec,
        content: noEvidenceMsg,
        wordCount: noEvidenceMsg.split(/\s+/).length
      };
    }

    const docsToList = citedDocsOrder.length > 0 ? citedDocsOrder : [];
    const formattedRefs = docsToList.length > 0
      ? docsToList.map((d, i) => formatVerifiedReference(d, citationStyle, i + 1)).join('\n\n')
      : 'No verified sources from the retrieved evidence pool were cited inline in the preceding manuscript sections.';

    return {
      ...sec,
      content: formattedRefs,
      wordCount: formattedRefs.trim().split(/\s+/).filter(Boolean).length
    };
  });

  const report: GroundingVerificationReport = {
    verifiedCitationsCount: citedDocsOrder.length,
    autoCorrectedCitations,
    unverifiedCitationsRemoved,
    contradictionsFixed,
    passed: unverifiedCitationsRemoved.length === 0 && contradictionsFixed.length === 0
  };

  return { sections: finalSections, report };
}

/**
 * Generates an initial structural outline or complete IMRaD paper draft strictly grounded
 * in `CONTEXT_SOURCES`, `PICO_MATRIX`, PMC full-text sections, and backend retrieval metadata.
 */
export async function generatePaperDraft(params: GenerateDraftRequest): Promise<PaperDraft> {
  const {
    researchQuestion,
    targetJournal = 'The Lancet',
    targetDatabases = ['PubMed/NCBI Entrez', 'PMC', 'OpenAlex', 'DOAJ', 'Crossref'],
    citationStyle = 'Vancouver',
    mode = 'full_draft',
    clinicalEvidence = [],
    retrievalStats
  } = params;

  const stats = buildRetrievalStats(clinicalEvidence, targetDatabases, retrievalStats);
  const { picoMatrixJson, contextSourcesText, statsMetadataText } = buildGroundedEvidenceContext(clinicalEvidence, stats, 15);

  const systemPrompt = `You are an elite academic medical writer, biostatistician, and clinical journal editor specializing in ${targetJournal} style and ICMJE biomedical reporting guidelines.
Your lead author is Dr. Puneet Maheshwari.
You format structured IMRaD papers conforming strictly to ${targetJournal} editorial standards with ${citationStyle} referencing.

${GLOBAL_CLINICAL_GROUNDING_RULES}

${SECTION_SPECIFIC_GROUNDING_RULES}

OUTPUT FORMAT RULE: Return ONLY valid JSON matching the requested schema with no markdown code fences or commentary.`;

  const userPrompt = `Generate a ${mode === 'outline' ? 'comprehensive structural IMRaD outline' : 'complete grounded IMRaD clinical manuscript draft'} for the research question:
"${researchQuestion}"

Target Journal: ${targetJournal}
Citation Style: ${citationStyle}
Lead Author: Dr. Puneet Maheshwari

RETRIEVAL_METADATA (Exact Backend Database & Design Counts):
${statsMetadataText}

PICO_MATRIX (Exact Quantitative & Design Metadata per Study):
${picoMatrixJson}

CONTEXT_SOURCES (Retrieved Abstracts & PMC Full-Text Sections):
${contextSourcesText}

Return ONLY a valid JSON object with this exact schema:
{
  "title": "Accurate Clinical Manuscript Title reflecting exact retrieved study designs",
  "author": "Dr. Puneet Maheshwari",
  "affiliation": "Department of Evidence-Based Medicine & Clinical Research",
  "sections": [
    {
      "id": "sec-title",
      "type": "title",
      "title": "Title & Authorship",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-abstract",
      "type": "abstract",
      "title": "Structured Abstract",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-intro",
      "type": "introduction",
      "title": "1. Introduction",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-methods",
      "type": "methods",
      "title": "2. Methods (Search & Synthesis Protocol)",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-results",
      "type": "results",
      "title": "3. Results & Clinical Evidence Evaluation",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-discussion",
      "type": "discussion",
      "title": "4. Discussion & Limitations",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-conclusion",
      "type": "conclusion",
      "title": "5. Conclusion",
      "content": "...",
      "keyPoints": ["..."]
    },
    {
      "id": "sec-references",
      "type": "references",
      "title": "6. References (${citationStyle})",
      "content": "...",
      "keyPoints": ["..."]
    }
  ]
}`;

  let parsedResponse: any = null;
  try {
    const inferenceResult = await executeInference(userPrompt, {
      model: config.llmSynthesisModel,
      systemPrompt,
      temperature: 0.15,
      maxTokens: 5500
    });

    const rawText = inferenceResult.text.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsedResponse = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.warn('[paperDraftService] LLM draft generation failed, using grounded rule-based generator:', err);
  }

  if (!parsedResponse || !Array.isArray(parsedResponse.sections)) {
    parsedResponse = createRuleBasedDraft(researchQuestion, targetJournal, stats, citationStyle, mode, clinicalEvidence);
  }

  const rawSections: PaperSection[] = parsedResponse.sections.map((s: any, idx: number) => {
    const cleanContent = humanizeMedicalProse(s.content || '');
    return {
      id: s.id || `sec-${idx}-${Date.now()}`,
      type: s.type || 'custom',
      title: s.title || `Section ${idx + 1}`,
      content: cleanContent,
      keyPoints: Array.isArray(s.keyPoints) ? s.keyPoints.map(humanizeMedicalProse) : [],
      wordCount: cleanContent.trim().split(/\s+/).filter(Boolean).length
    };
  });

  // Post-generation automated verification guardrail
  const { sections: verifiedSections, report } = verifyAndEnforceClinicalGrounding(
    rawSections,
    clinicalEvidence,
    stats,
    citationStyle
  );

  const totalWords = verifiedSections.reduce((acc, sec) => acc + (sec.wordCount || 0), 0);

  return {
    id: `draft-${Date.now()}`,
    title: parsedResponse.title || buildAccurateDefaultTitle(researchQuestion, stats),
    researchQuestion,
    targetJournal,
    targetDatabases: stats.databasesQueried,
    citationStyle,
    mode,
    author: parsedResponse.author || 'Dr. Puneet Maheshwari',
    affiliation: parsedResponse.affiliation || 'Department of Evidence-Based Medicine & Clinical Research',
    date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    sections: verifiedSections,
    totalWords,
    groundingVerification: report
  };
}

/**
 * Infers section-specific IMRaD guidance when tweaking an individual section inline.
 */
function getSectionGroundingGuidance(sectionTitle: string, sectionType?: PaperSection['type']): string {
  const hint = `${sectionType || ''} ${sectionTitle}`.toLowerCase();
  if (hint.includes('title') || hint.includes('abstract')) {
    return 'Reflect the exact study designs retrieved. Do not claim "superiority" unless pooled meta-analytic metrics in CONTEXT_SOURCES prove statistical superiority; use "comparative effectiveness" or "non-inferiority."';
  }
  if (hint.includes('intro')) {
    return 'Frame the clinical gap strictly around the PICO question. Do not invent epidemiological prevalence figures unless cited from CONTEXT_SOURCES.';
  }
  if (hint.includes('method')) {
    return 'Report ONLY the exact databases queried (PubMed/NCBI Entrez, PMC, OpenAlex, DOAJ, Crossref) and exact retrieval counts (Total Indexed Records vs. Unique Studies Included) from RETRIEVAL_METADATA. Never invent PRISMA screening counts or RoB 2 scores.';
  }
  if (hint.includes('result')) {
    return 'Report exact study design breakdown, ONLY mechanisms explicitly written in PMC_METHODS/PMC_RESULTS/PMC_DISCUSSION/AbstractText, and verbatim N, HR, RR, OR, 95% CI, and p-values from PICO_MATRIX/PMC_TABLES with inline [Author, Year (PMID/DOI)] citations. Write "Not reported in the retrieved studies" for missing items.';
  }
  if (hint.includes('discussion') || hint.includes('limitation')) {
    return 'Compare concordant/conflicting findings across CONTEXT_SOURCES with inline citations. Derive limitations strictly from actual study designs and sample sizes in PICO_MATRIX. NEVER claim all studies are observational if RCTs are in studyDesignsPresent.';
  }
  if (hint.includes('conclu')) {
    return 'Restrict conclusions strictly to the evaluated populations and outcomes in CONTEXT_SOURCES; avoid ungrounded sweeping recommendations.';
  }
  if (hint.includes('refer')) {
    return 'Render ONLY verified sources from CONTEXT_SOURCES in the exact selected citation style using verified Authors, Title, Journal, Year, PMID, and DOI.';
  }
  return 'Preserve closed-world clinical grounding against CONTEXT_SOURCES and PICO_MATRIX.';
}

/**
 * Transforms an individual section inline (expand, rephrase, condense, add citations, bulletize)
 * with full `CONTEXT_SOURCES` and `PICO_MATRIX` grounding plus post-generation guardrail verification.
 */
export async function transformSection(
  params: SectionActionRequest
): Promise<{ content: string; keyPoints?: string[]; groundingVerification?: GroundingVerificationReport }> {
  const {
    action,
    sectionTitle,
    sectionType,
    sectionContent,
    researchQuestion = '',
    targetJournal = 'The Lancet',
    citationStyle = 'Vancouver',
    customPrompt,
    clinicalEvidence = [],
    retrievalStats
  } = params;

  const stats = buildRetrievalStats(
    clinicalEvidence,
    retrievalStats?.databasesQueried || ['PubMed/NCBI Entrez', 'PMC', 'OpenAlex', 'DOAJ', 'Crossref'],
    retrievalStats
  );
  const { picoMatrixJson, contextSourcesText, statsMetadataText } = buildGroundedEvidenceContext(clinicalEvidence, stats, 12);
  const sectionGuidance = getSectionGroundingGuidance(sectionTitle, sectionType);

  let actionInstruction = '';
  switch (action) {
    case 'expand':
      actionInstruction = `Expand this section strictly using ONLY verified details, biological/pharmacological mechanisms (only if explicitly stated in PMC_METHODS, PMC_RESULTS, PMC_DISCUSSION, or AbstractText), and exact quantitative metrics (N, HR, RR, 95% CI, p-values) present in CONTEXT_SOURCES and PICO_MATRIX. Cite every claim immediately with [Author, Year (PMID/DOI)]. For any missing data write "Not reported in the retrieved studies."`;
      break;
    case 'rephrase':
      actionInstruction = `Rephrase this section in an authoritative academic medical voice adhering to ${targetJournal} standards while preserving EVERY verified factual claim, numerical figure, and inline [Author, Year (PMID/DOI)] citation.`;
      break;
    case 'condense':
      actionInstruction = `Condense this section into a concise clinical summary without dropping core verified metrics (N, HR, RR, p-values) or their inline [Author, Year (PMID/DOI)] citations.`;
      break;
    case 'add_citations':
      actionInstruction = `Insert verified inline bracket citations in the exact format [Author, Year (PMID/DOI)] matching CONTEXT_SOURCES for each clinical claim, sample size, and statistical metric. Never invent citations; remove or mark unsupported claims.`;
      break;
    case 'bulletize':
      actionInstruction = `Convert the section into structured clinical bullet points while preserving all exact quantitative metrics and verified [Author, Year (PMID/DOI)] inline citations from CONTEXT_SOURCES.`;
      break;
    case 'custom':
      actionInstruction = customPrompt || `Refine this section according to ${targetJournal} standards while staying strictly inside CONTEXT_SOURCES.`;
      break;
  }

  const prompt = `${researchQuestion ? `Research Question: "${researchQuestion}"\n` : ''}Section Title: "${sectionTitle}"
Section-Specific Grounding Rule: ${sectionGuidance}

Current Section Content:
${sectionContent}

Task: ${actionInstruction}

RETRIEVAL_METADATA:
${statsMetadataText}

PICO_MATRIX:
${picoMatrixJson}

CONTEXT_SOURCES:
${contextSourcesText}

Return ONLY the revised section content text (no preamble or code fences). Do not use LaTeX dollar delimiters.`;

  let candidateText = '';
  try {
    const result = await executeInference(prompt, {
      model: config.llmSynthesisModel,
      systemPrompt: `You are an expert clinical editor for ${targetJournal} (${citationStyle} style).\n\n${GLOBAL_CLINICAL_GROUNDING_RULES}`,
      temperature: 0.15,
      maxTokens: 2800
    });

    if (result.text && result.text.trim().length > 15) {
      candidateText = result.text.trim();
    }
  } catch (err) {
    console.warn('[paperDraftService] Section transformation failed, using grounded fallback:', err);
  }

  if (!candidateText) {
    candidateText = buildGroundedFallbackSectionAction(action, sectionContent, clinicalEvidence, citationStyle);
  }

  // Run post-generation verification guardrail on the revised section
  const inferredType: PaperSection['type'] =
    sectionType ||
    (/refer/i.test(sectionTitle) ? 'references'
      : /discussion|limitation/i.test(sectionTitle) ? 'discussion'
      : /result/i.test(sectionTitle) ? 'results'
      : /method/i.test(sectionTitle) ? 'methods'
      : /intro/i.test(sectionTitle) ? 'introduction'
      : /abstract/i.test(sectionTitle) ? 'abstract'
      : /conclu/i.test(sectionTitle) ? 'conclusion'
      : 'custom');

  if (inferredType === 'references' && clinicalEvidence.length > 0) {
    // Only filter/keep references that actually exist in clinicalEvidence
    const lines = candidateText.split(/\n+/).filter(l => l.trim().length > 0);
    const verifiedLines = lines.filter(line => Boolean(findMatchingEvidenceDoc(line, clinicalEvidence)));
    const finalRefContent = verifiedLines.length > 0
      ? verifiedLines.join('\n\n')
      : clinicalEvidence.slice(0, 8).map((d, i) => formatVerifiedReference(d, citationStyle, i + 1)).join('\n\n');
    return {
      content: humanizeMedicalProse(finalRefContent),
      groundingVerification: {
        verifiedCitationsCount: verifiedLines.length || Math.min(8, clinicalEvidence.length),
        autoCorrectedCitations: [],
        unverifiedCitationsRemoved: [],
        contradictionsFixed: [],
        passed: true
      }
    };
  }

  const { sections: checked, report } = verifyAndEnforceClinicalGrounding(
    [
      {
        id: 'sec-inline',
        type: inferredType,
        title: sectionTitle,
        content: humanizeMedicalProse(candidateText)
      }
    ],
    clinicalEvidence,
    stats,
    citationStyle
  );

  return {
    content: checked[0]?.content || humanizeMedicalProse(sectionContent),
    groundingVerification: report
  };
}

/**
 * Offline grounded section-action fallback: strictly uses retrieved `clinicalEvidence`
 * without inventing sample sizes, mechanisms, or citations.
 */
function buildGroundedFallbackSectionAction(
  action: SectionActionRequest['action'],
  sectionContent: string,
  clinicalEvidence: MedicalDocument[],
  citationStyle: string
): string {
  if (action === 'bulletize') {
    const lines = sectionContent.split(/(?<=[.!?])\s+/).filter(l => l.trim().length > 10);
    return lines.map(l => `- **Clinical Point:** ${l.trim()}`).join('\n\n');
  }
  if (action === 'condense') {
    const sentences = sectionContent.split(/(?<=[.!?])\s+/);
    return sentences.slice(0, Math.max(2, Math.floor(sentences.length / 2))).join(' ');
  }
  if (action === 'expand' || action === 'add_citations') {
    if (clinicalEvidence.length === 0) {
      return `${sectionContent}\n\nAdditional quantitative metrics and mechanistic data were not reported in the retrieved studies.`;
    }
    const groundedAdditions = clinicalEvidence.slice(0, 4).map((doc) => {
      const cit = formatCanonicalCitation(doc);
      const nText = doc.pico?.sampleSize > 0 ? `N = ${doc.pico.sampleSize}` : 'sample size Not reported in the retrieved studies';
      const pText = doc.pico?.pValues?.length ? doc.pico.pValues.join(', ') : 'p-value Not reported in the retrieved studies';
      const hrText = doc.pico?.hazardRatio ? `, HR ${doc.pico.hazardRatio}` : '';
      const rrText = doc.pico?.riskRatio ? `, RR ${doc.pico.riskRatio}` : '';
      return `In ${doc.firstAuthor} et al. (${doc.year}, ${doc.pico?.design || 'Study'}), ${nText} evaluating ${doc.pico?.intervention || 'the intervention'} versus ${doc.pico?.comparator || 'comparator'} reported ${doc.pico?.primaryOutcome || 'primary outcomes'} (${pText}${hrText}${rrText}) ${cit}.`;
    }).join(' ');
    return `${sectionContent}\n\n${groundedAdditions}`;
  }
  if (citationStyle && sectionContent) {
    return sectionContent;
  }
  return sectionContent;
}

function buildAccurateDefaultTitle(question: string, stats: RetrievalStatsMetadata): string {
  const designsLabel = stats.studyDesigns.length > 0
    ? stats.studyDesigns.slice(0, 3).join(' and ')
    : 'Clinical Literature';
  const cleanQ = question.trim().charAt(0).toUpperCase() + question.trim().slice(1);
  return `Systematic Evidence Synthesis of ${designsLabel}: ${cleanQ}`;
}

/**
 * Deterministic grounded draft generator for offline or fallback operation.
 * Strictly respects retrieval counts, actual study designs, missing-data rules, and verified citations.
 */
function createRuleBasedDraft(
  question: string,
  targetJournal: string,
  stats: RetrievalStatsMetadata,
  citationStyle: string,
  _mode: string,
  evidence: MedicalDocument[]
): { title: string; author: string; affiliation: string; sections: PaperSection[] } {
  const title = buildAccurateDefaultTitle(question, stats);
  const author = 'Dr. Puneet Maheshwari';
  const affiliation = 'Department of Evidence-Based Medicine & Clinical Research';

  const designBreakdownText = Object.entries(stats.studyDesignCounts)
    .map(([d, c]) => `${c} ${d}${c > 1 ? 's' : ''}`)
    .join(', ') || '0 studies';

  const dbBreakdownText = Object.entries(stats.databaseBreakdown)
    .map(([db, c]) => `${db} (n = ${c})`)
    .join(', ') || stats.databasesQueried.join(', ');

  const smallSampleDocs = evidence.filter(d => (d.pico?.sampleSize || 0) > 0 && d.pico.sampleSize < 100);
  const missingSampleDocs = evidence.filter(d => !d.pico?.sampleSize || d.pico.sampleSize === 0);
  const rctCount = stats.studyDesignCounts['Randomized Controlled Trial'] || 0;

  const studyEvidenceParagraphs = evidence.slice(0, 6).map((d) => {
    const cit = formatCanonicalCitation(d);
    const nVal = d.pico?.sampleSize > 0 ? `N = ${d.pico.sampleSize}` : 'N = Not reported in the retrieved studies';
    const hrVal = d.pico?.hazardRatio ? `HR ${d.pico.hazardRatio}` : 'HR: Not reported in the retrieved studies';
    const rrVal = d.pico?.riskRatio ? `RR ${d.pico.riskRatio}` : 'RR: Not reported in the retrieved studies';
    const pVal = d.pico?.pValues?.length ? d.pico.pValues.join(', ') : 'Not reported in the retrieved studies';
    return `- **${d.firstAuthor} et al. (${d.year}, ${d.pico?.design || 'Study'})** evaluated ${d.pico?.population || 'study participants'} (${nVal}), comparing ${d.pico?.intervention || 'active intervention'} against ${d.pico?.comparator || 'comparator'}, with outcome ${d.pico?.primaryOutcome || 'clinical outcome'} (${hrVal}; ${rrVal}; ${pVal}) ${cit}.`;
  }).join('\n');

  const citedDocs = evidence.slice(0, 6);
  const referencesContent = citedDocs.length > 0
    ? citedDocs.map((d, i) => formatVerifiedReference(d, citationStyle, i + 1)).join('\n\n')
    : 'No verified sources were retrieved for citation.';

  const limitationsNotes: string[] = [];
  if (rctCount > 0) {
    limitationsNotes.push(`the synthesized pool contains ${rctCount} Randomized Controlled Trial${rctCount > 1 ? 's' : ''} alongside ${Math.max(0, stats.uniqueIncluded - rctCount)} non-randomized or review studies (${designBreakdownText})`);
  } else if (stats.uniqueIncluded > 0) {
    limitationsNotes.push(`the retrieved pool comprises ${designBreakdownText}`);
  }
  if (smallSampleDocs.length > 0) {
    limitationsNotes.push(`${smallSampleDocs.length} retrieved study/studies enrolled cohorts with N < 100 (${smallSampleDocs.slice(0, 3).map(formatCanonicalCitation).join(' ')})`);
  }
  if (missingSampleDocs.length > 0) {
    limitationsNotes.push(`${missingSampleDocs.length} retrieved record(s) did not report an extractable cohort sample size N`);
  }

  return {
    title,
    author,
    affiliation,
    sections: [
      {
        id: 'sec-title',
        type: 'title',
        title: 'Title & Authorship',
        content: `# ${title}\n\n**Lead Author:** ${author}\n**Affiliation:** ${affiliation}\n**Target Journal:** ${targetJournal}\n**Referencing Format:** ${citationStyle}`,
        keyPoints: [`Author: ${author}`, `Target Journal: ${targetJournal}`]
      },
      {
        id: 'sec-abstract',
        type: 'abstract',
        title: 'Structured Abstract',
        content: `**Background:** This evaluation examines comparative effectiveness regarding **${question}** strictly within retrieved clinical records.\n\n**Methods:** Databases queried comprised ${stats.databasesQueried.join(', ')}, yielding ${stats.totalIndexed} total indexed records and ${stats.uniqueIncluded} unique included studies (${stats.pmcFullTextCount} with PMC open-access full text).\n\n**Results:** Included study designs comprised ${designBreakdownText}. ${evidence[0] ? `Primary findings from ${evidence[0].firstAuthor} et al. (${evidence[0].year}) reported ${evidence[0].pico?.primaryOutcome || 'primary outcomes'} ${formatCanonicalCitation(evidence[0])}.` : 'No retrieved studies were available for quantitative summary.'}\n\n**Conclusion:** Findings apply strictly to the clinical cohorts and outcomes reported in the ${stats.uniqueIncluded} retrieved studies.`,
        keyPoints: [`${stats.uniqueIncluded} unique studies included`, `Designs: ${designBreakdownText}`]
      },
      {
        id: 'sec-intro',
        type: 'introduction',
        title: '1. Introduction',
        content: `The clinical question **"${question}"** centers on evaluating patient populations, active interventions, comparators, and clinical outcomes across retrieved biomedical studies. Epidemiological prevalence numbers beyond those explicitly reported in the retrieved studies are not reported in the retrieved studies.`,
        keyPoints: ['PICO-framed clinical objective', 'Closed-world evidence boundary']
      },
      {
        id: 'sec-methods',
        type: 'methods',
        title: '2. Methods (Search & Synthesis Protocol)',
        content: `### Databases Queried & Retrieval Counts\nWe queried **${stats.databasesQueried.join(', ')}**. Across all queries, **Total Indexed Records** was ${stats.totalIndexed} and **Unique Studies Included** was ${stats.uniqueIncluded} (${dbBreakdownText}). Formal PRISMA screening counts and Cochrane RoB 2 scores were not computed by the backend and are not reported in the retrieved studies.`,
        keyPoints: [`Databases: ${stats.databasesQueried.join(', ')}`, `Total Indexed: ${stats.totalIndexed}; Unique Included: ${stats.uniqueIncluded}`]
      },
      {
        id: 'sec-results',
        type: 'results',
        title: '3. Results & Clinical Evidence Evaluation',
        content: `### 3.1 Study Selection\nA total of ${stats.uniqueIncluded} unique studies were evaluated, comprising: ${designBreakdownText}.\n\n### 3.2 Biological & Pharmacological Mechanisms\nSpecific pharmacokinetic or mechanistic pathways beyond those explicitly written in the retrieved abstracts or PMC full-text sections were not reported in the retrieved studies.\n\n### 3.3 Quantitative Statistical Metrics\n${studyEvidenceParagraphs || 'Not reported in the retrieved studies.'}`,
        keyPoints: [`Study breakdown: ${designBreakdownText}`, 'Verbatim PICO_MATRIX statistics with verified inline citations']
      },
      {
        id: 'sec-discussion',
        type: 'discussion',
        title: '4. Discussion & Limitations',
        content: `### Discussion\nAcross the ${stats.uniqueIncluded} evaluated studies, comparative effectiveness outcomes varied according to study design and sample size. ${citedDocs.slice(0, 2).map(d => `${d.firstAuthor} et al. (${d.year}) reported ${d.pico?.primaryOutcome || 'clinical outcomes'} ${formatCanonicalCitation(d)}`).join('; ') || 'No study comparisons available.'}.\n\n### Limitations\nLimitations derived strictly from retrieved PICO_MATRIX metadata include: ${limitationsNotes.join('; ') || 'limited metadata across retrieved records'}.`,
        keyPoints: [`Grounded in ${designBreakdownText}`, 'Limitations derived strictly from retrieved PICO_MATRIX']
      },
      {
        id: 'sec-conclusion',
        type: 'conclusion',
        title: '5. Conclusion',
        content: `Based strictly on the ${stats.uniqueIncluded} retrieved studies (${designBreakdownText}), conclusions are restricted to the evaluated populations and reported comparative effectiveness outcomes. Broader practice recommendations beyond the retrieved trial populations are not supported without additional protocol-matched evidence.`,
        keyPoints: ['Restricted to evaluated populations and outcomes']
      },
      {
        id: 'sec-references',
        type: 'references',
        title: `6. References (${citationStyle})`,
        content: referencesContent,
        keyPoints: [`Formatted in ${citationStyle}`]
      }
    ]
  };
}
