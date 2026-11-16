import { executeInference } from './openRouterService.js';
import { MedicalDocument, validateExtractedPicoField, extractPValues } from './searchService.js';
import { config } from '../config.js';
import {
  RetrievalStatsMetadata,
  pluralizeStudyDesign,
  decodeHtmlEntities,
  sanitizeDocumentMetadata,
  sanitizeAuthorsList,
  isPlaceholderAuthor,
  sanitizeJournalField,
  selectStudiesByDataRichness,
  rankAndFilterStudiesForQuestion,
  buildRetrievalStats,
  buildCorpusContext,
  formatCanonicalCitation,
  formatPublicationYear
} from './corpusContextBuilder.js';

export type { RetrievalStatsMetadata };
export { formatCanonicalCitation, buildRetrievalStats };

export interface PaperSection {
  id: string;
  type: 'title' | 'abstract' | 'introduction' | 'methods' | 'results' | 'discussion' | 'conclusion' | 'references' | 'custom';
  title: string;
  content: string;
  keyPoints?: string[];
  wordCount?: number;
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
 * Strictly enforces Markdown block spacing:
 * - Splits inline `##`/`###`/`####` headings onto separate lines with `\n\n` after every heading.
 * - Separates headings that accidentally run directly into body text or bullets on the same line.
 * - Splits inline `- **` or bullet items inside paragraphs onto new lines (`\n- `).
 */
export function enforceStrictMarkdownFormatting(text: string): string {
  if (!text) return '';
  let out = text.replace(/\r\n?/g, '\n');

  // 1. Ensure any inline ##/###/#### heading starts on a fresh paragraph without splitting # of ###
  out = out.replace(/([^\n#])[ \t]*(#{2,4}\s+)/g, '$1\n\n$2');

  // 2. Split headings followed by inline bullets on the same line (e.g. "### 3.3 Quantitative Metrics - **...")
  out = out.replace(/^(#{1,4}\s+[^\n]+?)\s+(-\s+\*\*)/gm, '$1\n\n$2');

  // 3. Split known IMRaD subheadings if body prose immediately follows on the same line
  out = out.replace(
    /^(#{2,4}\s+(?:3\.1\s+Study\s+Selection|3\.2\s+Biological\s*(?:&|and)\s*Pharmacological\s+Mechanisms|3\.3\s+Quantitative\s+Statistical\s+Metrics|Databases\s+Queried\s*(?:&|and)\s*Retrieval\s+Counts|Study\s+Selection|Biological\s*(?:&|and)\s*Pharmacological\s+Mechanisms|Quantitative\s+Statistical\s+Metrics|Discussion|Limitations|Search\s*(?:&|and)\s*Synthesis\s+Protocol))\s+(?=\S)/gim,
    '$1\n\n'
  );

  // 4. Split headings ending with colon or bold lead-in followed by body text on same line
  out = out.replace(/^(#{2,4}\s+[^\n:]{2,90}:)\s+(?=\S)/gm, '$1\n\n');
  out = out.replace(/^(#{2,4}\s+[^\n]+?)\s+(\*\*[A-Za-z0-9])/gm, '$1\n\n$2');

  // 5. Split Title-Case headings that accidentally run into a lowercase-continuing body sentence
  out = out.replace(
    /^(#{2,4}\s+(?:[A-Z0-9][^\n]*?))\s+((?:[A-Z][a-z]*)\s+(?!(?:and|or|of|in|on|at|to|for|with|by|from|vs\.?|versus|the|a|an|as)\s+[A-Z])[a-z]{2,}\b[^\n]*)$/gm,
    '$1\n\n$2'
  );

  // 6. Force blank line (\n\n) after every Markdown heading before body/list lines
  out = out.replace(/^(#{1,4}\s+[^\n]+)\n(?!\n)/gm, '$1\n\n');

  // 7. Split inline bullet points (` - **` or sentence-end ` - Item`) onto new lines
  out = out.replace(/([^\n])\s+(-\s+\*\*)/g, '$1\n- **');
  out = out.replace(/([.!?:;])\s+(-\s+[A-Z0-9*])/g, '$1\n$2');

  // 8. Ensure a blank line precedes the start of a bullet list after prose
  out = out.replace(/([^\n-])\n(-\s+)/g, '$1\n\n$2');

  // 9. Collapse excess consecutive blank lines
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Post-processes text to strictly enforce medical journal typography:
 * - Decodes HTML entities (&gt;, &lt;, &amp;, &quot;, etc.) while preserving Markdown newlines
 * - Strips LaTeX dollar math delimiters ($p < 0.05$ -> p < 0.05, $N = 250$ -> N = 250)
 * - Humanizes robotic/agentic phrasing ('were synthesized' -> 'were critically evaluated and analyzed')
 * - Enforces strict Markdown newlines around headings & bullets
 */
export function humanizeMedicalProse(text: string): string {
  if (!text) return '';
  const decodedAndHumanized = decodeHtmlEntities(text, true)
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

  return enforceStrictMarkdownFormatting(decodedAndHumanized);
}

const GLOBAL_CLINICAL_GROUNDING_RULES = `STRICT CLINICAL GROUNDING RULES (APPLY TO EVERY SECTION & INLINE ACTION):
1. Closed-World Evidence Boundary: Use ONLY facts, numbers, mechanisms, and conclusions explicitly present in the retrieved CONTEXT_SOURCES and PICO_MATRIX. Never rely on pre-trained parametric assumptions to fill missing data.
2. Mandatory Inline Citations: Every clinical claim, sample size (N), outcome metric (HR, RR, OR, MD, 95% CI, p-value), and mechanism MUST be immediately followed by an exact citation tag matching CONTEXT_SOURCES in the format [Author, Year (PMID/DOI)]. Never cite a source ID not present in CONTEXT_SOURCES.
3. Explicit Missing-Data Handling: If a specific metric (e.g., long-term mortality, exact p-value, or mechanism) is absent from CONTEXT_SOURCES, explicitly write "Not reported in the retrieved studies" instead of estimating or inventing a value.
4. Medical Journal Typography & Tone: Never use LaTeX dollar delimiters ($p < 0.05$ or $N = 250$). Write standard medical prose (p < 0.05, N = 250) in an authoritative human academic voice.`;

const SECTION_SPECIFIC_GROUNDING_RULES = `IMRaD SECTION-BY-SECTION CLINICAL GROUNDING RULES:
- Title & Abstract:
  * Accurately reflect the exact study designs retrieved with proper pluralization (e.g., "Cohort Studies", "Meta-Analyses", "Case Series", "Randomized Controlled Trials").
  * Do NOT claim "superiority" unless pooled meta-analytic metrics in CONTEXT_SOURCES prove statistical superiority; otherwise use "comparative effectiveness" or "non-inferiority."
- 1. Introduction:
  * Frame the clinical gap strictly around the user's PICO question (Population, Intervention, Comparator, Outcome).
  * Do NOT invent epidemiological prevalence numbers unless explicitly cited from CONTEXT_SOURCES.
- 2. Methods (Search & Synthesis Protocol):
  * State ONLY the exact databases actually queried in RETRIEVAL_METADATA (databasesQueried) and exact primary retrieval counts (primarySourceCountsSummingToUnique, summing strictly to uniqueRelevantStudiesIncluded).
  * Report PMC open-access full-text retrievals strictly as an enrichment subset of PubMed rather than an additive database count.
  * Do NOT fabricate PRISMA screening numbers or bias-assessment scores (e.g., Cochrane RoB 2) unless explicitly present in backend metadata.
- 3. Results & Clinical Evidence Evaluation:
  * 3.1 Study Selection: List exact study counts broken down by actual study design metadata from RETRIEVAL_METADATA using proper pluralization (e.g., X Randomized Controlled Trials, Y Cohort Studies, Z Meta-Analyses).
  * 3.2 Biological & Pharmacological Mechanisms: Report ONLY mechanisms explicitly stated in the retrieved PMC_METHODS, PMC_RESULTS, PMC_DISCUSSION, or AbstractText. Never fabricate pharmacokinetic claims (e.g., onset speed, bioavailability, or tissue localization). If absent, explicitly write "Not reported in the retrieved studies."
  * 3.3 Quantitative Statistical Metrics: Quote exact values (N, HR, RR, 95% CI, p-values) verbatim from PICO_MATRIX and PMC_TABLES with inline citations [Author, Year (PMID/DOI)] for every single figure.
- 4. Discussion & Limitations:
  * Discussion: Compare findings across included studies relevant to the clinical target and highlight concordant or conflicting outcomes with inline citations.
  * Limitations: Derive limitations strictly from the actual study designs and sample sizes in PICO_MATRIX (e.g., small sample sizes N < 100, short follow-up duration, or heterogeneity across cohorts). NEVER call an RCT cohort "observational" or suggest "future RCTs are needed" if Randomized Controlled Trials are already present in studyDesignsPresent without explaining why.
- 5. Conclusion:
  * Restrict conclusions strictly to the population and outcomes evaluated in Results. Avoid sweeping clinical practice recommendations unless supported by Grade-A guidelines or multi-center RCTs in CONTEXT_SOURCES.
- Formatting & References Rule:
  * Put a blank line (\\n\\n) after every ## or ### heading before body text, and start every bullet item (- **...**) on its own new line.
  * Do NOT output a References section; the backend compiles Section 6 (References) deterministically from your inline citations in Sections 1-5.`;

/**
 * Formats a clean human-readable study label without placeholder author strings.
 */
function formatStudyActorLabel(doc: MedicalDocument, includeDesign = false): string {
  const validAuthors = sanitizeAuthorsList(doc.authors);
  const actor = validAuthors.length > 0
    ? `${validAuthors[0]}${validAuthors.length > 1 ? ' et al.' : ''}`
    : (doc.journal && doc.journal !== 'Biomedical Journal' && doc.journal !== 'Medical Journal'
        ? doc.journal
        : 'Retrieved Study');
  const yearLabel = formatPublicationYear(doc.year);
  if (includeDesign) {
    return `${actor} (${yearLabel}, ${doc.pico?.design || 'Observational / Descriptive Study'})`;
  }
  return `${actor} (${yearLabel})`;
}

/**
 * Formats a single reference entry strictly in the chosen citation style using sanitized verified metadata.
 * When author metadata is absent or placeholder-only, omits the author prefix cleanly rather than emitting "Investigator et al.".
 */
function formatVerifiedReference(rawDoc: MedicalDocument, citationStyle: string, indexOneBased: number): string {
  const doc = sanitizeDocumentMetadata(rawDoc);
  const validAuthors = sanitizeAuthorsList(doc.authors);
  const authorList = validAuthors.length > 0
    ? validAuthors.slice(0, 6).join(', ') + (validAuthors.length > 6 ? ', et al.' : '')
    : (!isPlaceholderAuthor(doc.firstAuthor) && doc.firstAuthor !== sanitizeJournalField(doc.journal)
        ? doc.firstAuthor
        : '');

  const cleanTitle = doc.title.replace(/\.+$/, '');
  const cleanJournal = doc.journal.replace(/\.+$/, '');
  const yearLabel = formatPublicationYear(doc.year);
  const pmidSegment = doc.pmid ? ` PMID: ${doc.pmid}.` : '';
  const pmcidSegment = doc.pmcid ? ` PMCID: ${doc.pmcid}.` : '';
  const doiUrl = doc.doi ? `https://doi.org/${doc.doi}` : '';
  const doiText = doc.doi ? `doi:${doc.doi}.` : '';

  if (citationStyle === 'APA') {
    const parts = authorList
      ? [
          `${authorList} (${yearLabel}).`,
          `${cleanTitle}.`,
          `*${cleanJournal}*.`,
          doiUrl,
          pmidSegment.trim(),
          pmcidSegment.trim()
        ]
      : [
          `${cleanTitle}.`,
          `(${yearLabel}).`,
          `*${cleanJournal}*.`,
          doiUrl,
          pmidSegment.trim(),
          pmcidSegment.trim()
        ];
    return parts.filter(Boolean).join(' ').trim();
  }
  if (citationStyle === 'Chicago') {
    const parts = authorList
      ? [
          `${indexOneBased}. ${authorList}.`,
          `"${cleanTitle}."`,
          `*${cleanJournal}* (${yearLabel}).`,
          doiText,
          pmidSegment.trim(),
          pmcidSegment.trim()
        ]
      : [
          `${indexOneBased}. "${cleanTitle}."`,
          `*${cleanJournal}* (${yearLabel}).`,
          doiText,
          pmidSegment.trim(),
          pmcidSegment.trim()
        ];
    return parts.filter(Boolean).join(' ').trim();
  }
  if (citationStyle === 'MLA') {
    const parts = authorList
      ? [
          `${authorList}.`,
          `"${cleanTitle}."`,
          `*${cleanJournal}*, ${yearLabel}${doiUrl ? `, ${doiUrl}` : ''}.`,
          pmidSegment.trim(),
          pmcidSegment.trim()
        ]
      : [
          `"${cleanTitle}."`,
          `*${cleanJournal}*, ${yearLabel}${doiUrl ? `, ${doiUrl}` : ''}.`,
          pmidSegment.trim(),
          pmcidSegment.trim()
        ];
    return parts.filter(Boolean).join(' ').trim();
  }
  // Vancouver (ICMJE)
  const parts = authorList
    ? [
        `${indexOneBased}. ${authorList}.`,
        `${cleanTitle}.`,
        `${cleanJournal}.`,
        `${yearLabel};`,
        doiText,
        pmidSegment.trim(),
        pmcidSegment.trim()
      ]
    : [
        `${indexOneBased}. ${cleanTitle}.`,
        `${cleanJournal}.`,
        `${yearLabel};`,
        doiText,
        pmidSegment.trim(),
        pmcidSegment.trim()
      ];
  return parts.filter(Boolean).join(' ').trim();
}

/**
 * Deterministically renders Section 6 (References) from cited studies in the requested style.
 * Alphabetizes for APA/MLA; preserves order of first appearance for Vancouver/Chicago.
 */
function buildDeterministicReferencesContent(citedDocs: MedicalDocument[], citationStyle: string): string {
  if (!citedDocs || citedDocs.length === 0) {
    return 'No verified sources from the retrieved evidence pool were cited inline in the preceding manuscript sections.';
  }

  const normalizedDocs = citedDocs.map(sanitizeDocumentMetadata);
  const orderedDocs = (citationStyle === 'APA' || citationStyle === 'MLA')
    ? [...normalizedDocs].sort((a, b) => {
        const validA = sanitizeAuthorsList(a.authors);
        const validB = sanitizeAuthorsList(b.authors);
        const keyA = (validA[0] || a.title || '').toLowerCase();
        const keyB = (validB[0] || b.title || '').toLowerCase();
        if (keyA !== keyB) return keyA.localeCompare(keyB);
        return (a.year || 0) - (b.year || 0);
      })
    : normalizedDocs;

  return orderedDocs
    .map((d, i) => formatVerifiedReference(d, citationStyle, i + 1))
    .join('\n\n');
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

  // 2. Author Surname or Journal + Year match
  const yearMatch = bracketText.match(/\b(19|20)\d{2}\b/);
  const citedYear = yearMatch ? parseInt(yearMatch[0], 10) : null;

  for (const doc of clinicalEvidence) {
    if (citedYear && doc.year !== citedYear) continue;
    const candidateNames = sanitizeAuthorsList(doc.authors)
      .map(a => (a || '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z-]/g, ''))
      .filter(n => n && n.length >= 2);
    if (candidateNames.some(surname => lower.includes(surname))) {
      return doc;
    }
    const cleanJournal = sanitizeJournalField(doc.journal).toLowerCase();
    if (cleanJournal.length >= 4 && lower.includes(cleanJournal)) {
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
    .map(([design, count]) => `${count} ${pluralizeStudyDesign(design, count)}`)
    .join(', ');

  // Never pass LLM-generated references through; Section 6 is compiled deterministically from Sections 1-5
  const nonReferenceSections = sections.filter(
    (sec) => sec.type !== 'references' && !/^\s*(?:6\.\s*)?references\b/i.test(sec.title || '')
  );

  // Match bracketed citations that are NOT markdown links `[label](url)` and contain a year / PMID / DOI / et al.
  const citationRegex = /\[([^\]]+?)\](?!\()/g;

  const verifiedSections = nonReferenceSections.map((sec) => {
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
        const replacement = `The retrieved evidence includes ${rctCount} ${pluralizeStudyDesign('Randomized Controlled Trial', rctCount)} alongside other study designs (${designSummary || 'mixed designs'}), rather than exclusively observational studies.`;
        text = text.replace(obsFalseClaimRegex, replacement);
        contradictionsFixed.push('Corrected false claim that all included studies were observational when RCTs were retrieved.');
        console.warn('[paperDraftService] Grounding guardrail fixed observational-only contradiction in Discussion/Limitations.');
      }

      if (noRctClaimRegex.test(text)) {
        const replacement = `${rctCount} ${pluralizeStudyDesign('Randomized Controlled Trial', rctCount)} ${rctCount > 1 ? 'were' : 'was'} included in this synthesis (${designSummary}).`;
        text = text.replace(noRctClaimRegex, replacement);
        contradictionsFixed.push('Corrected false claim asserting no RCTs were included.');
        console.warn('[paperDraftService] Grounding guardrail fixed missing-RCT contradiction in Discussion/Limitations.');
      }

      if (/\bfuture\s+(?:randomized\s+controlled\s+trials|rcts?)\s+are\s+needed\b/i.test(text) && !/\bdespite|given|small|longer|multi-?center|additional|larger\b/i.test(text)) {
        text = text.replace(
          /\b(future\s+(?:randomized\s+controlled\s+trials|rcts?)\s+are\s+needed)\b/gi,
          `$1 (building upon the ${rctCount} existing ${pluralizeStudyDesign('Randomized Controlled Trial', rctCount)} in this synthesis to address sample size or follow-up constraints)`
        );
        contradictionsFixed.push('Contextualized recommendation for future RCTs against existing synthesized RCTs.');
      }
    }

    // Ensure sec-title contains at most one # heading cleanly
    if (sec.type === 'title') {
      const lines = text.split('\n');
      let seenTopHeading = false;
      text = lines.filter((line) => {
        if (/^#\s+/.test(line.trim())) {
          if (seenTopHeading) return false;
          seenTopHeading = true;
        }
        return true;
      }).join('\n');
    }

    const cleanOut = humanizeMedicalProse(text).trim();
    const words = cleanOut.split(/\s+/).filter(Boolean).length;
    return {
      ...sec,
      content: cleanOut,
      wordCount: words
    };
  });

  // Deterministically render Section 6 (References) from actual verified inline citations in Sections 1-5
  const formattedRefsContent = clinicalEvidence.length === 0
    ? 'No verified references were cited from retrieved clinical databases.'
    : buildDeterministicReferencesContent(citedDocsOrder, citationStyle);

  const finalSections = [...verifiedSections];
  if (sections.some(s => s.type === 'conclusion' || s.type === 'discussion' || s.type === 'results' || s.type === 'references')) {
    finalSections.push({
      id: 'sec-references',
      type: 'references',
      title: `6. References (${citationStyle})`,
      content: formattedRefsContent,
      keyPoints: [`Deterministically formatted in ${citationStyle} (${citedDocsOrder.length} verified sources)`],
      wordCount: formattedRefsContent.trim().split(/\s+/).filter(Boolean).length
    });
  }

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
 * Runs a single batched LLM-assisted PICO/metric extraction fallback on top-ranked studies
 * where regex extraction left `sampleSize === 0` or `primaryOutcome === 'Not reported'`.
 * Never invents missing metrics; only fills fields verbatim from the study's abstract or PMC full text.
 */
async function enrichTopStudiesPicoWithLlm(
  studies: MedicalDocument[],
  researchQuestion: string,
  maxToInspect = 5
): Promise<MedicalDocument[]> {
  if (!studies || studies.length === 0) return studies;

  const hasAnyLlmKey = Boolean(
    config.openRouterApiKey || config.geminiApiKey || config.omniRouteApiKey || config.huggingFaceApiKey || config.llmProvider === 'ollama'
  );
  if (!hasAnyLlmKey) return studies;

  const candidates = studies
    .slice(0, 12)
    .filter((doc) => {
      const missingN = !doc.pico?.sampleSize || doc.pico.sampleSize === 0;
      const missingOutcome = !doc.pico?.primaryOutcome || doc.pico.primaryOutcome === 'Not reported';
      const hasReadableText = (doc.abstract || '').length >= 60 || Boolean(doc.hasFullText && (doc.fullText || doc.fullTextSections));
      return (missingN || missingOutcome) && hasReadableText;
    })
    .slice(0, maxToInspect);

  if (candidates.length === 0) return studies;

  try {
    const payload = candidates.map((doc) => {
      const pmcSnippet = doc.hasFullText && doc.fullTextSections
        ? [doc.fullTextSections.methods, doc.fullTextSections.results, doc.fullTextSections.tables].filter(Boolean).join('\n').slice(0, 1600)
        : '';
      return {
        id: doc.id,
        title: doc.title,
        text: `${doc.abstract || ''}\n${pmcSnippet}`.trim().slice(0, 2200)
      };
    });

    const prompt = `Extract ONLY explicitly stated PICO fields and quantitative statistical metrics from each biomedical study below (relevant to "${researchQuestion}").
For each study, return an entry in JSON array "items" with:
- "id": exact study id
- "sampleSize": integer > 0 ONLY if explicitly stated in the text, else 0
- "population": concise noun phrase (>= 3 words) ONLY if explicitly stated, else "Not reported"
- "intervention": concise noun phrase (>= 3 words) ONLY if explicitly stated, else "Not reported"
- "comparator": concise noun phrase (>= 3 words) ONLY if explicitly stated, else "Not reported"
- "primaryOutcome": concise noun phrase (>= 3 words) ONLY if explicitly stated, else "Not reported"
- "hazardRatio": exact HR string if reported, else ""
- "riskRatio": exact RR or OR string if reported, else ""
- "pValues": array of exact p-value strings (e.g. ["p = 0.012"]) if explicitly reported, else []

STUDIES:
${JSON.stringify(payload, null, 2)}

Return ONLY valid JSON: { "items": [ ... ] }`;

    const res = await executeInference(prompt, {
      model: config.llmSynthesisModel,
      systemPrompt: 'You are a strict biomedical data extraction parser. Never infer or fabricate unstated sample sizes or p-values. Return strictly valid JSON.',
      temperature: 0.05,
      maxTokens: 1500
    });

    const jsonMatch = (res.text || '').trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) return studies;
    const parsed = JSON.parse(jsonMatch[0]);
    const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
    const byId = new Map<string, any>(items.filter(it => it && typeof it.id === 'string').map(it => [it.id, it]));

    return studies.map((doc) => {
      const ext = byId.get(doc.id);
      if (!ext || !doc.pico) return doc;

      const updatedPico = { ...doc.pico };
      if ((!updatedPico.sampleSize || updatedPico.sampleSize === 0) && typeof ext.sampleSize === 'number' && Number.isFinite(ext.sampleSize) && ext.sampleSize > 0 && ext.sampleSize < 10000000) {
        updatedPico.sampleSize = Math.round(ext.sampleSize);
      }
      if (updatedPico.population === 'Not reported' && typeof ext.population === 'string') {
        const valid = validateExtractedPicoField(ext.population);
        if (valid !== 'Not reported') updatedPico.population = valid;
      }
      if (updatedPico.intervention === 'Not reported' && typeof ext.intervention === 'string') {
        const valid = validateExtractedPicoField(ext.intervention);
        if (valid !== 'Not reported') updatedPico.intervention = valid;
      }
      if (updatedPico.comparator === 'Not reported' && typeof ext.comparator === 'string') {
        const valid = validateExtractedPicoField(ext.comparator);
        if (valid !== 'Not reported') updatedPico.comparator = valid;
      }
      if (updatedPico.primaryOutcome === 'Not reported' && typeof ext.primaryOutcome === 'string') {
        const valid = validateExtractedPicoField(ext.primaryOutcome);
        if (valid !== 'Not reported') updatedPico.primaryOutcome = valid;
      }
      if (!updatedPico.hazardRatio && typeof ext.hazardRatio === 'string' && /\d/.test(ext.hazardRatio)) {
        updatedPico.hazardRatio = decodeHtmlEntities(ext.hazardRatio).trim();
      }
      if (!updatedPico.riskRatio && typeof ext.riskRatio === 'string' && /\d/.test(ext.riskRatio)) {
        updatedPico.riskRatio = decodeHtmlEntities(ext.riskRatio).trim();
      }
      if ((!updatedPico.pValues || updatedPico.pValues.length === 0) && Array.isArray(ext.pValues)) {
        const validP = extractPValues(ext.pValues.join(' '), 4, false);
        if (validP.length > 0) updatedPico.pValues = validP;
      }

      return { ...doc, pico: updatedPico };
    });
  } catch (err) {
    console.warn('[paperDraftService] LLM PICO enrichment fallback skipped:', err instanceof Error ? err.message : err);
    return studies;
  }
}

/**
 * Generates an initial structural outline or complete IMRaD paper draft strictly grounded
 * in `CONTEXT_SOURCES`, `PICO_MATRIX`, PMC full-text sections, and backend retrieval metadata.
 */
export async function generatePaperDraft(params: GenerateDraftRequest): Promise<PaperDraft> {
  const {
    researchQuestion,
    targetJournal = 'Standard Academic / ICMJE Systematic Review',
    targetDatabases = [],
    citationStyle = 'APA',
    mode = 'full_draft',
    clinicalEvidence = [],
    retrievalStats
  } = params;

  // Dynamic query-relevance ranking & keyword-collision filtering BEFORE building Context & Section 3.3 / 4
  const ranked = rankAndFilterStudiesForQuestion(clinicalEvidence, researchQuestion);
  const relevantStudies = await enrichTopStudiesPicoWithLlm(ranked.relevantStudies, researchQuestion, 5);
  const stats = buildRetrievalStats(relevantStudies, targetDatabases, retrievalStats, ranked.totalEvaluated);
  const { picoMatrixJson, contextSourcesText, statsMetadataText } = buildCorpusContext(relevantStudies, stats, 15);

  const systemPrompt = `You are an elite academic medical writer, biostatistician, and clinical journal editor specializing in ${targetJournal} style and ICMJE biomedical reporting guidelines.
Your lead author is Dr. Puneet Maheshwari.
You format structured IMRaD papers conforming strictly to ${targetJournal} editorial standards with ${citationStyle} referencing.

${GLOBAL_CLINICAL_GROUNDING_RULES}

${SECTION_SPECIFIC_GROUNDING_RULES}

OUTPUT FORMAT RULE: Return ONLY valid JSON matching the requested schema with no markdown code fences or commentary. Never include a References section in the JSON output.`;

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

Return ONLY a valid JSON object with this exact 7-section schema (do NOT include References; Section 6 is compiled deterministically from your inline citations):
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
    parsedResponse = createRuleBasedDraft(researchQuestion, targetJournal, stats, citationStyle, mode, relevantStudies);
  }

  const draftTitle = decodeHtmlEntities(parsedResponse.title || '') || buildAccurateDefaultTitle(researchQuestion, stats);

  const rawSections: PaperSection[] = parsedResponse.sections.map((s: any, idx: number) => {
    const cleanContent = humanizeMedicalProse(s.content || '');
    return {
      id: s.id || `sec-${idx}-${Date.now()}`,
      type: s.type || 'custom',
      title: decodeHtmlEntities(s.title || `Section ${idx + 1}`),
      content: cleanContent,
      keyPoints: Array.isArray(s.keyPoints) ? s.keyPoints.map(humanizeMedicalProse) : [],
      wordCount: cleanContent.trim().split(/\s+/).filter(Boolean).length
    };
  });

  // Ensure sec-title has a clean single # title if omitted or duplicated
  for (const sec of rawSections) {
    if (sec.type === 'title') {
      const stripped = sec.content.replace(/^(?:#+\s*[^\n]*\n+)+/, '').trim();
      sec.content = `# ${draftTitle}${stripped ? `\n\n${stripped}` : ''}`;
      sec.wordCount = sec.content.split(/\s+/).filter(Boolean).length;
    }
  }

  // Post-generation automated verification guardrail
  const { sections: verifiedSections, report } = verifyAndEnforceClinicalGrounding(
    rawSections,
    relevantStudies,
    stats,
    citationStyle
  );

  const totalWords = verifiedSections.reduce((acc, sec) => acc + (sec.wordCount || 0), 0);

  return {
    id: `draft-${Date.now()}`,
    title: draftTitle,
    researchQuestion,
    targetJournal,
    targetDatabases: stats.databasesQueried,
    citationStyle,
    mode,
    author: decodeHtmlEntities(parsedResponse.author || 'Dr. Puneet Maheshwari'),
    affiliation: decodeHtmlEntities(parsedResponse.affiliation || 'Department of Evidence-Based Medicine & Clinical Research'),
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
    return 'Reflect the exact study designs retrieved using proper pluralization (Cohort Studies, Meta-Analyses, Case Series). Do not claim "superiority" unless pooled meta-analytic metrics in CONTEXT_SOURCES prove statistical superiority; use "comparative effectiveness" or "non-inferiority."';
  }
  if (hint.includes('intro')) {
    return 'Frame the clinical gap strictly around the PICO question. Do not invent epidemiological prevalence figures unless cited from CONTEXT_SOURCES.';
  }
  if (hint.includes('method')) {
    return 'Report ONLY the exact databases actually queried (databasesQueried) and primary deduplicated counts (primarySourceCountsSummingToUnique) from RETRIEVAL_METADATA, with PMC reported strictly as an open-access full-text enrichment subset of PubMed. Never invent PRISMA screening counts or RoB 2 scores.';
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
    targetJournal = 'Standard Academic / ICMJE Systematic Review',
    citationStyle = 'APA',
    customPrompt,
    clinicalEvidence = [],
    retrievalStats
  } = params;

  const ranked = researchQuestion
    ? rankAndFilterStudiesForQuestion(clinicalEvidence, researchQuestion)
    : {
        relevantStudies: clinicalEvidence.map(sanitizeDocumentMetadata),
        filteredOutCount: 0,
        totalEvaluated: clinicalEvidence.length,
        queryEntities: []
      };
  const relevantStudies = ranked.relevantStudies;
  const stats = buildRetrievalStats(
    relevantStudies,
    retrievalStats?.databasesQueried || [],
    retrievalStats,
    ranked.totalEvaluated
  );
  const { picoMatrixJson, contextSourcesText, statsMetadataText } = buildCorpusContext(relevantStudies, stats, 12);
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
    candidateText = buildGroundedFallbackSectionAction(action, sectionContent, relevantStudies, citationStyle);
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

  if (inferredType === 'references' && relevantStudies.length > 0) {
    // Only filter/keep references that actually exist in relevantStudies, or render deterministically
    const lines = candidateText.split(/\n+/).filter(l => l.trim().length > 0);
    const matchedDocs: MedicalDocument[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const m = findMatchingEvidenceDoc(line, relevantStudies);
      if (m) {
        const key = (m.pmid || m.doi || m.id).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          matchedDocs.push(m);
        }
      }
    }
    const docsToFormat = matchedDocs.length > 0 ? matchedDocs : relevantStudies.slice(0, 8);
    const finalRefContent = buildDeterministicReferencesContent(docsToFormat, citationStyle);
    return {
      content: humanizeMedicalProse(finalRefContent),
      groundingVerification: {
        verifiedCitationsCount: docsToFormat.length,
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
    relevantStudies,
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
      const statText = doc.pico?.primaryStatistic ? `, ${doc.pico.primaryStatistic}` : '';
      const hrText = doc.pico?.hazardRatio ? `, HR ${doc.pico.hazardRatio}` : '';
      const rrText = doc.pico?.riskRatio ? `, RR ${doc.pico.riskRatio}` : '';
      return `In ${formatStudyActorLabel(doc, true)}, ${nText} evaluating ${doc.pico?.intervention || 'the intervention'} versus ${doc.pico?.comparator || 'comparator'} reported ${doc.pico?.primaryOutcome || 'primary outcomes'} (${pText}${statText}${hrText}${rrText}) ${cit}.`;
    }).join(' ');
    return `${sectionContent}\n\n${groundedAdditions}`;
  }
  if (citationStyle && sectionContent) {
    return sectionContent;
  }
  return sectionContent;
}

function buildAccurateDefaultTitle(question: string, stats: RetrievalStatsMetadata): string {
  const designEntries = Object.entries(stats.studyDesignCounts);
  const designsLabel = designEntries.length > 0
    ? designEntries
        .slice(0, 3)
        .map(([design, count]) => pluralizeStudyDesign(design, Math.max(2, count)))
        .join(', ')
    : 'Clinical Literature';
  const cleanQ = decodeHtmlEntities(question).trim();
  const formattedQ = cleanQ.charAt(0).toUpperCase() + cleanQ.slice(1);
  return `Systematic Evidence Synthesis of ${designsLabel}: ${formattedQ}`;
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
  const sanitizedEvidence = evidence.map(sanitizeDocumentMetadata);
  const title = buildAccurateDefaultTitle(question, stats);
  const author = 'Dr. Puneet Maheshwari';
  const affiliation = 'Department of Evidence-Based Medicine & Clinical Research';

  const designBreakdownText = Object.entries(stats.studyDesignCounts)
    .map(([d, c]) => `${c} ${pluralizeStudyDesign(d, c)}`)
    .join(', ') || '0 studies';

  const dbBreakdownText = Object.entries(stats.databaseBreakdown)
    .map(([db, c]) => `${db} (n = ${c})`)
    .join(', ') || stats.databasesQueried.join(', ');

  const pmcSubsetNote = stats.pubmedTotalCount > 0 || stats.pmcFullTextCount > 0
    ? `; PMC open-access full text retrieved for ${stats.pmcFullTextCount} of ${stats.pubmedTotalCount} PubMed records`
    : '';

  const smallSampleDocs = sanitizedEvidence.filter(d => (d.pico?.sampleSize || 0) > 0 && d.pico.sampleSize < 100);
  const missingSampleDocs = sanitizedEvidence.filter(d => !d.pico?.sampleSize || d.pico.sampleSize === 0);
  const rctCount = stats.studyDesignCounts['Randomized Controlled Trial'] || 0;

  // Rank Section 3.3 studies by PICO completeness * query relevance (skipping empty rows when metric-rich studies exist)
  const metricsStudies = selectStudiesByDataRichness(sanitizedEvidence, 6);
  const studyEvidenceParagraphs = metricsStudies.map((d) => {
    const cit = formatCanonicalCitation(d);
    const nVal = d.pico?.sampleSize > 0 ? `N = ${d.pico.sampleSize}` : 'N = Not reported';
    const statVal = d.pico?.primaryStatistic ? `Primary Stat: ${d.pico.primaryStatistic}; ` : '';
    const hrVal = d.pico?.hazardRatio ? `HR ${d.pico.hazardRatio}` : 'HR: Not reported';
    const rrVal = d.pico?.riskRatio ? `RR ${d.pico.riskRatio}` : 'RR: Not reported';
    const pVal = d.pico?.pValues?.length ? d.pico.pValues.join(', ') : 'p-value: Not reported';
    const popText = d.pico?.population && d.pico.population !== 'Not reported' ? d.pico.population : 'study participants (eligibility criteria not reported)';
    const intText = d.pico?.intervention && d.pico.intervention !== 'Not reported' ? d.pico.intervention : 'evaluated intervention (regimen details not reported)';
    const compText = d.pico?.comparator && d.pico.comparator !== 'Not reported' ? d.pico.comparator : 'comparator arm (not reported)';
    const outText = d.pico?.primaryOutcome && d.pico.primaryOutcome !== 'Not reported' ? d.pico.primaryOutcome : 'clinical outcomes (not reported)';
    return `- **${formatStudyActorLabel(d, true)}** evaluated ${popText} (${nVal}), comparing ${intText} against ${compText}, with primary outcome ${outText} (${statVal}${hrVal}; ${rrVal}; ${pVal}) ${cit}.`;
  }).join('\n');

  const leadStudy = metricsStudies[0] || sanitizedEvidence[0];

  const limitationsNotes: string[] = [];
  if (rctCount > 0) {
    limitationsNotes.push(`the synthesized pool contains ${rctCount} ${pluralizeStudyDesign('Randomized Controlled Trial', rctCount)} alongside ${Math.max(0, stats.uniqueIncluded - rctCount)} non-randomized or review studies (${designBreakdownText})`);
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
        content: `**Background:** This evaluation examines comparative effectiveness regarding **${question}** strictly within retrieved clinical records.\n\n**Methods:** Databases queried comprised ${stats.databasesQueried.join(', ')}, yielding ${stats.totalIndexed} total evaluated records and ${stats.uniqueIncluded} unique relevant studies included (${dbBreakdownText}${pmcSubsetNote}).\n\n**Results:** Included study designs comprised ${designBreakdownText}. ${leadStudy ? `Primary findings from ${formatStudyActorLabel(leadStudy)} reported ${leadStudy.pico?.primaryOutcome && leadStudy.pico.primaryOutcome !== 'Not reported' ? leadStudy.pico.primaryOutcome : 'clinical outcomes'} ${formatCanonicalCitation(leadStudy)}.` : 'No retrieved studies were available for quantitative summary.'}\n\n**Conclusion:** Findings apply strictly to the clinical cohorts and outcomes reported in the ${stats.uniqueIncluded} included studies.`,
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
        content: `### Databases Queried & Retrieval Counts\n\nWe queried **${stats.databasesQueried.join(', ')}**. Across all queries, **Total Evaluated Records** was ${stats.totalIndexed} (${stats.filteredOutLowRelevanceCount} low-relevance keyword-collision hits excluded prior to synthesis) and **Unique Studies Included** was ${stats.uniqueIncluded}, decomposed across primary sources as: ${dbBreakdownText}. Within PubMed records, **PMC open-access full text** was retrieved as an enrichment subset for ${stats.pmcFullTextCount} of ${stats.pubmedTotalCount} PubMed studies. Formal PRISMA screening counts and Cochrane RoB 2 scores were not computed by the backend and are not reported in the retrieved studies.`,
        keyPoints: [`Databases: ${stats.databasesQueried.join(', ')}`, `Total Evaluated: ${stats.totalIndexed}; Unique Included: ${stats.uniqueIncluded}; PMC Subset: ${stats.pmcFullTextCount}`]
      },
      {
        id: 'sec-results',
        type: 'results',
        title: '3. Results & Clinical Evidence Evaluation',
        content: `### 3.1 Study Selection\n\nA total of ${stats.uniqueIncluded} unique relevant studies were evaluated, comprising: ${designBreakdownText}.\n\n### 3.2 Biological & Pharmacological Mechanisms\n\nSpecific pharmacokinetic or mechanistic pathways beyond those explicitly written in the retrieved abstracts or PMC full-text sections were not reported in the retrieved studies.\n\n### 3.3 Quantitative Statistical Metrics\n\n${studyEvidenceParagraphs || 'Not reported in the retrieved studies.'}`,
        keyPoints: [`Study breakdown: ${designBreakdownText}`, 'Verbatim PICO_MATRIX statistics with verified inline citations']
      },
      {
        id: 'sec-discussion',
        type: 'discussion',
        title: '4. Discussion & Limitations',
        content: `### Discussion\n\nAcross the ${stats.uniqueIncluded} evaluated studies, comparative effectiveness outcomes varied according to study design and sample size. ${metricsStudies.slice(0, 2).map(d => `${formatStudyActorLabel(d)} evaluated ${d.pico?.primaryOutcome && d.pico.primaryOutcome !== 'Not reported' ? d.pico.primaryOutcome : d.title} ${formatCanonicalCitation(d)}`).join('; ') || 'No study comparisons available.'}.\n\n### Limitations\n\nLimitations derived strictly from retrieved PICO_MATRIX metadata include: ${limitationsNotes.join('; ') || 'limited metadata across retrieved records'}.`,
        keyPoints: [`Grounded in ${designBreakdownText}`, 'Limitations derived strictly from retrieved PICO_MATRIX']
      },
      {
        id: 'sec-conclusion',
        type: 'conclusion',
        title: '5. Conclusion',
        content: `Based strictly on the ${stats.uniqueIncluded} retrieved studies (${designBreakdownText}), conclusions are restricted to the evaluated populations and reported comparative effectiveness outcomes. Broader practice recommendations beyond the retrieved trial populations are not supported without additional protocol-matched evidence.`,
        keyPoints: ['Restricted to evaluated populations and outcomes']
      }
    ]
  };
}
