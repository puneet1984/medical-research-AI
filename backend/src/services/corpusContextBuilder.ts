import type { MedicalDocument } from './searchService.js';
import { generateLocalEmbedding, cosineSimilarity } from './embeddingService.js';

export interface RetrievalStatsMetadata {
  totalIndexed: number;
  uniqueIncluded: number;
  pmcFullTextCount: number;
  pubmedTotalCount: number;
  filteredOutLowRelevanceCount: number;
  databasesQueried: string[];
  databaseBreakdown: Record<string, number>;
  studyDesignCounts: Record<string, number>;
  studyDesigns: string[];
}

export interface RankedCorpusResult {
  relevantStudies: MedicalDocument[];
  filteredOutCount: number;
  totalEvaluated: number;
  queryEntities: string[];
}

/**
 * Proper biomedical study design pluralization map (replaces naive `${design}s`).
 */
export const STUDY_DESIGN_PLURAL_MAP: Record<string, string> = {
  'Cohort Study': 'Cohort Studies',
  'Case Series': 'Case Series',
  'Meta-Analysis': 'Meta-Analyses',
  'Case Report': 'Case Reports',
  'Systematic Review': 'Systematic Reviews',
  'Review Article': 'Review Articles',
  'Randomized Controlled Trial': 'Randomized Controlled Trials',
  'Clinical Trial': 'Clinical Trials',
  'Preclinical / Experimental Study': 'Preclinical / Experimental Studies',
  'Consensus / Classification Paper': 'Consensus / Classification Papers',
  'Observational / Descriptive Study': 'Observational / Descriptive Studies'
};

/**
 * Validates that a publication year is an authentic 4-digit year between 1950 and the current calendar year.
 * Returns null instead of defaulting missing/invalid years to the current year.
 */
export function parseValidPublicationYear(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const currentYear = new Date().getFullYear();
  if (typeof raw === 'number') {
    const yr = Math.trunc(raw);
    return yr >= 1950 && yr <= currentYear ? yr : null;
  }
  const matches = String(raw).match(/\b(19[5-9]\d|20\d{2})\b/g);
  if (!matches || matches.length === 0) return null;
  for (const m of matches) {
    const yr = parseInt(m, 10);
    if (yr >= 1950 && yr <= currentYear) return yr;
  }
  return null;
}

export function formatPublicationYear(year?: number | null): string {
  return typeof year === 'number' && year >= 1950 ? String(year) : 'Year n.d.';
}

export function pluralizeStudyDesign(design: string, count: number): string {
  const cleanDesign = (design || 'Observational / Descriptive Study').trim();
  if (count === 1) return cleanDesign;
  if (STUDY_DESIGN_PLURAL_MAP[cleanDesign]) {
    return STUDY_DESIGN_PLURAL_MAP[cleanDesign];
  }
  if (cleanDesign.endsWith('Series')) return cleanDesign;
  if (cleanDesign.endsWith('Analysis')) return cleanDesign.replace(/Analysis$/, 'Analyses');
  if (cleanDesign.endsWith('Study')) return cleanDesign.replace(/Study$/, 'Studies');
  if (cleanDesign.endsWith('s')) return cleanDesign;
  return `${cleanDesign}s`;
}

/**
 * Decodes common named and numeric HTML/XML entities (e.g. &gt;, &lt;, &amp;, &quot;, &#39;, &nbsp;)
 * and collapses excessive whitespace.
 */
export function decodeHtmlEntities(input?: string | null, preserveNewlines = false): string {
  if (!input || typeof input !== 'string') return '';
  let text = input
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—');

  // Decode decimal numeric entities
  text = text.replace(/&#(\d+);/g, (_m, dec) => {
    const code = parseInt(dec, 10);
    return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
  });
  // Decode hex numeric entities
  text = text.replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
  });

  // Re-run once in case of double-encoded entities like &amp;gt;
  text = text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');

  if (preserveNewlines) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitizes journal metadata fields: decodes entities, strips HTML tags,
 * strips embedded/malformed URLs, and normalizes punctuation.
 */
export function sanitizeJournalField(journal?: string | null): string {
  if (!journal || typeof journal !== 'string') return 'Biomedical Journal';
  let cleaned = decodeHtmlEntities(journal)
    .replace(/<[^>]+>/g, ' ')
    // Remove embedded or malformed URLs sometimes leaked into journal names
    .replace(/https?:\/{1,2}[^\s,;)]+/gi, ' ')
    .replace(/\bwww\.[^\s,;)]+/gi, ' ')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\-.\s]+|[,;:\-\s]+$/g, '')
    .trim();

  if (!cleaned || cleaned.length < 2) return 'Biomedical Journal';
  return cleaned;
}

/**
 * Sanitizes DOI values by removing duplicate URL prefixes or accidental whitespace.
 */
export function sanitizeDoi(doi?: string | null): string {
  if (!doi || typeof doi !== 'string') return '';
  let cleaned = decodeHtmlEntities(doi)
    .replace(/^https?:\/+doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[\s<>"]/g, '')
    .replace(/[.,;]+$/g, '')
    .trim();
  return cleaned;
}

/**
 * Sanitizes URLs in metadata fields so malformed protocols or trailing junk do not leak into Markdown/references.
 */
export function sanitizeUrlField(url?: string | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  let cleaned = decodeHtmlEntities(url)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^https?:\/(?!\/)/i, m => `${m}/`)
    .replace(/[.,;>)\]]+$/g, '');
  if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

const PLACEHOLDER_AUTHOR_RE = /^(?:investigator|lead\s+investigator|lead\s+researcher|lead\s+author|researcher|author|authors|unknown|anonymous|anon|none|n\/a|na|unavailable|editorial\s+team|staff)(?:\s+et\s+al\.?)?$/i;

export function isPlaceholderAuthor(name?: string | null): boolean {
  if (!name || typeof name !== 'string') return true;
  const trimmed = decodeHtmlEntities(name).replace(/[.,;]+$/g, '').trim();
  if (!trimmed || trimmed.length < 2) return true;
  return PLACEHOLDER_AUTHOR_RE.test(trimmed);
}

export function sanitizeAuthorsList(authors?: string[] | null): string[] {
  if (!Array.isArray(authors)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of authors) {
    const val = decodeHtmlEntities(raw || '').replace(/\s+/g, ' ').trim();
    if (isPlaceholderAuthor(val)) continue;
    const key = val.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push(val);
    }
  }
  return cleaned;
}

/**
 * Resolves a clean display author or falls back to the journal/organization name (or '' if generic).
 */
export function resolveAuthorOrJournalFallback(doc: Pick<MedicalDocument, 'firstAuthor' | 'authors' | 'journal'>): string {
  const validAuthors = sanitizeAuthorsList(doc.authors);
  if (validAuthors.length > 0) return validAuthors[0];
  const rawFirst = decodeHtmlEntities(doc.firstAuthor || '').trim();
  if (!isPlaceholderAuthor(rawFirst)) return rawFirst;
  const cleanJournal = sanitizeJournalField(doc.journal);
  if (cleanJournal && cleanJournal !== 'Biomedical Journal' && cleanJournal !== 'Medical Journal') {
    return cleanJournal;
  }
  return '';
}

/**
 * Sanitizes all textual and URL metadata fields on a MedicalDocument.
 */
export function sanitizeDocumentMetadata(doc: MedicalDocument): MedicalDocument {
  const cleanDoi = sanitizeDoi(doc.doi);
  const cleanTitle = decodeHtmlEntities(doc.title).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'Clinical Study';
  const cleanJournal = sanitizeJournalField(doc.journal);
  const cleanAuthors = sanitizeAuthorsList(doc.authors);
  const cleanFirstAuthor = resolveAuthorOrJournalFallback({
    firstAuthor: doc.firstAuthor,
    authors: cleanAuthors,
    journal: cleanJournal
  });
  const cleanAbstract = decodeHtmlEntities(doc.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    ...doc,
    title: cleanTitle,
    journal: cleanJournal,
    authors: cleanAuthors,
    firstAuthor: cleanFirstAuthor,
    doi: cleanDoi,
    webUrl: sanitizeUrlField(doc.webUrl),
    abstract: cleanAbstract,
    pico: doc.pico
      ? {
          ...doc.pico,
          population: decodeHtmlEntities(doc.pico.population) || 'Not reported',
          intervention: decodeHtmlEntities(doc.pico.intervention) || 'Not reported',
          comparator: decodeHtmlEntities(doc.pico.comparator) || 'Not reported',
          primaryOutcome: decodeHtmlEntities(doc.pico.primaryOutcome) || 'Not reported',
          effectMetricType: doc.pico.effectMetricType ?? null,
          effectEstimate: doc.pico.effectEstimate ? decodeHtmlEntities(doc.pico.effectEstimate) : undefined,
          hazardRatio: doc.pico.hazardRatio ? decodeHtmlEntities(doc.pico.hazardRatio) : undefined,
          riskRatio: doc.pico.riskRatio ? decodeHtmlEntities(doc.pico.riskRatio) : undefined,
          pValues: (doc.pico.pValues || []).map(p => decodeHtmlEntities(p)).filter(Boolean)
        }
      : doc.pico
  };
}

/**
 * Computes PICO data richness score for Section 3.3 / PICO_MATRIX ranking:
 * +3 if N is reported, +3 if HR/RR/OR/p-value is reported,
 * +2 if intervention & comparator are reported, +2 if hasFullText is true.
 */
export function computePicoCompletenessScore(doc: MedicalDocument): number {
  let score = 0;
  const pico = doc.pico;
  if (!pico) return doc.hasFullText ? 2 : 0;

  if (typeof pico.sampleSize === 'number' && pico.sampleSize > 0) {
    score += 3;
  }
  const hasStats =
    Boolean(pico.effectEstimate && pico.effectEstimate !== 'Not reported') ||
    Boolean(pico.hazardRatio && pico.hazardRatio !== 'Not reported') ||
    Boolean(pico.riskRatio && pico.riskRatio !== 'Not reported') ||
    Boolean(pico.primaryStatistic && pico.primaryStatistic !== 'Not reported') ||
    (Array.isArray(pico.pValues) && pico.pValues.length > 0);
  if (hasStats) {
    score += 3;
  }
  const hasIntervention = Boolean(pico.intervention && pico.intervention !== 'Not reported');
  const hasComparator = Boolean(pico.comparator && pico.comparator !== 'Not reported');
  if (hasIntervention && hasComparator) {
    score += 2;
  }
  if (doc.hasFullText) {
    score += 2;
  }
  return score;
}

/**
 * Ranks studies by `picoCompletenessScore * queryRelevance` and avoids empty rows
 * when metric-bearing studies exist in the corpus.
 */
export function selectStudiesByDataRichness(
  studies: MedicalDocument[],
  maxCount = 15
): MedicalDocument[] {
  if (!studies || studies.length === 0) return [];
  const sanitized = studies.map(sanitizeDocumentMetadata);
  const withScores = sanitized.map((doc) => {
    const richness = computePicoCompletenessScore(doc);
    const hasAnyMeaningfulPico =
      richness > 0 ||
      Boolean(doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported') ||
      Boolean(doc.pico?.population && doc.pico.population !== 'Not reported');
    const relevance = typeof doc.score === 'number' && doc.score > 0 ? doc.score : 0.5;
    const weighted = (richness > 0 ? richness : (hasAnyMeaningfulPico ? 0.5 : 0)) * relevance;
    return { doc, richness, hasAnyMeaningfulPico, weighted };
  });

  const nonEmpty = withScores.filter(x => x.hasAnyMeaningfulPico);
  const pool = nonEmpty.length > 0 ? nonEmpty : withScores;

  pool.sort((a, b) => {
    if (Math.abs(b.weighted - a.weighted) > 0.01) return b.weighted - a.weighted;
    if (b.richness !== a.richness) return b.richness - a.richness;
    return (b.doc.score || 0) - (a.doc.score || 0);
  });

  return pool.slice(0, maxCount).map(x => x.doc);
}

function normalizeTitleForDedup(title?: string | null): string {
  return decodeHtmlEntities(title || '')
    .toLowerCase()
    .replace(/\[[^\]]*(?:abstract|poster|letter|comment|erratum)[^\]]*\]/gi, ' ')
    .replace(/\([^)]*(?:abstract|poster|suppl)[^)]*\)/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBigrams(str: string): Set<string> {
  const clean = str.replace(/\s+/g, ' ');
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

export function computeTitleSimilarity(titleA: string, titleB: string): number {
  const normA = normalizeTitleForDedup(titleA);
  const normB = normalizeTitleForDedup(titleB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  // Token Jaccard similarity
  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  let tokenIntersect = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) tokenIntersect++;
  }
  const tokenUnion = tokensA.size + tokensB.size - tokenIntersect;
  const jaccard = tokenUnion > 0 ? tokenIntersect / tokenUnion : 0;

  // Character bigram Dice similarity
  const biA = getBigrams(normA);
  const biB = getBigrams(normB);
  let biIntersect = 0;
  for (const b of biA) {
    if (biB.has(b)) biIntersect++;
  }
  const dice = biA.size + biB.size > 0 ? (2 * biIntersect) / (biA.size + biB.size) : 0;

  return Math.max(jaccard, dice);
}

function getNormalizedSurname(doc: MedicalDocument): string {
  const candidate = sanitizeAuthorsList(doc.authors)[0] || doc.firstAuthor || '';
  if (isPlaceholderAuthor(candidate)) return '';
  return candidate.toLowerCase().split(/[\s,]+/)[0]?.replace(/[^a-z]/g, '') || '';
}

function chooseRicherDocument(a: MedicalDocument, b: MedicalDocument): MedicalDocument {
  const scoreDoc = (d: MedicalDocument) =>
    (d.hasFullText ? 50 : 0) +
    (d.source === 'PubMed' ? 20 : 0) +
    (d.pmid ? 10 : 0) +
    (d.doi ? 8 : 0) +
    computePicoCompletenessScore(d) * 3 +
    Math.min(20, Math.floor((d.abstract || '').length / 100)) +
    (sanitizeAuthorsList(d.authors).length > 0 ? 5 : 0);

  const primary = scoreDoc(b) > scoreDoc(a) ? b : a;
  const secondary = primary === a ? b : a;

  return {
    ...primary,
    pmid: primary.pmid || secondary.pmid,
    pmcid: primary.pmcid || secondary.pmcid,
    doi: primary.doi || secondary.doi,
    hasFullText: primary.hasFullText || secondary.hasFullText,
    fullText: primary.fullText || secondary.fullText,
    fullTextSections: primary.fullTextSections || secondary.fullTextSections,
    abstract: (primary.abstract || '').length >= (secondary.abstract || '').length ? primary.abstract : secondary.abstract,
    authors: sanitizeAuthorsList(primary.authors).length > 0 ? primary.authors : secondary.authors
  };
}

/**
 * Deduplicates studies with identical DOI/PMID or >90% normalized title similarity
 * (e.g., conference abstract + published journal article by same first author and year),
 * retaining the richest metadata record before counting or citing.
 */
export function deduplicateNearIdenticalStudies(studies: MedicalDocument[]): MedicalDocument[] {
  if (!studies || studies.length === 0) return [];
  const result: MedicalDocument[] = [];
  const normTitles: string[] = [];

  for (const rawDoc of studies) {
    const doc = sanitizeDocumentMetadata(rawDoc);
    const normTitle = normalizeTitleForDedup(doc.title);
    const docDoi = sanitizeDoi(doc.doi).toLowerCase();
    const docPmid = (doc.pmid || '').trim();
    const docSurname = getNormalizedSurname(doc);

    let duplicateIdx = -1;
    for (let i = 0; i < result.length; i++) {
      const existing = result[i];
      if (docPmid && existing.pmid && docPmid === existing.pmid.trim()) {
        duplicateIdx = i;
        break;
      }
      if (docDoi && existing.doi && docDoi === sanitizeDoi(existing.doi).toLowerCase()) {
        duplicateIdx = i;
        break;
      }
      const sim = computeTitleSimilarity(normTitle, normTitles[i]);
      if (sim > 0.90) {
        const existingSurname = getNormalizedSurname(existing);
        const sameYearBand = Math.abs((doc.year || 0) - (existing.year || 0)) <= 1;
        const sameAuthorOrMissing = !docSurname || !existingSurname || docSurname === existingSurname;
        if ((sameYearBand && sameAuthorOrMissing) || sim >= 0.95) {
          duplicateIdx = i;
          break;
        }
      }
    }

    if (duplicateIdx >= 0) {
      result[duplicateIdx] = chooseRicherDocument(result[duplicateIdx], doc);
      normTitles[duplicateIdx] = normalizeTitleForDedup(result[duplicateIdx].title);
    } else {
      result.push(doc);
      normTitles.push(normTitle);
    }
  }

  return result;
}

const QUERY_STOP_WORDS = new Set([
  'vs', 'versus', 'v', 'and', 'or', 'the', 'in', 'of', 'for', 'with', 'to', 'a', 'an', 'at', 'by',
  'from', 'on', 'is', 'are', 'was', 'were', 'be', 'been', 'as', 'into', 'during', 'after', 'before',
  'between', 'among', 'compared', 'comparing', 'comparison', 'what', 'which', 'how', 'does', 'do',
  'role', 'impact', 'effect', 'effects', 'efficacy', 'safety', 'effectiveness', 'outcomes', 'outcome'
]);

/**
 * Broad intervention/clinical nouns that frequently cause false keyword-collision matches
 * (e.g., matching "antibiotics" or "therapy" without matching the actual disease/population).
 */
const GENERIC_CLINICAL_TERMS = new Set([
  'antibiotic', 'antibiotics', 'antimicrobial', 'antimicrobials', 'therapy', 'therapies',
  'treatment', 'treatments', 'regimen', 'regimens', 'management', 'medication', 'medications',
  'drug', 'drugs', 'agent', 'agents', 'medicine', 'pharmacotherapy', 'intervention', 'interventions',
  'control', 'placebo', 'standard', 'care', 'protocol', 'protocols', 'approach', 'surgery',
  'surgical', 'operative', 'nonoperative', 'conservative', 'oral', 'intravenous', 'iv', 'topical',
  'study', 'studies', 'trial', 'trials', 'clinical', 'patient', 'patients', 'adults', 'adult',
  'children', 'pediatric', 'elderly', 'review', 'meta', 'analysis', 'cohort', 'prospective',
  'retrospective', 'randomized', 'randomised', 'long', 'short', 'term', 'early', 'late', 'acute',
  'chronic', 'severe', 'mild', 'moderate', 'primary', 'secondary', 'mortality', 'morbidity', 'rate',
  'rates', 'risk', 'risks', 'prevention', 'prophylaxis', 'diagnosis', 'diagnostic'
]);

const WEAK_CONDITION_MODIFIERS = new Set([
  'infection', 'infections', 'disease', 'diseases', 'syndrome', 'syndromes',
  'disorder', 'disorders', 'condition', 'conditions', 'complication', 'complications',
  'failure', 'injury', 'injuries', 'pain', 'bleeding', 'inflammation', 'symptom',
  'symptoms', 'deficiency', 'dysfunction', 'toxicity', 'resistance', 'fever',
  'recurrence', 'survival', 'outcome', 'outcomes', 'dose', 'dosage', 'use', 'usage'
]);

function stemToken(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function stripConferencePosterCodes(textLower: string): string {
  return textLower.replace(/\b[a-z]{2,5}-\d{2,6}\b/g, ' ');
}

function tokenMatchesText(token: string, textLower: string): boolean {
  const cleanText = stripConferencePosterCodes(textLower);
  const stemmed = stemToken(token);
  if (token.length <= 4) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Require strict word boundaries and exclude hyphenated poster/abstract codes (e.g. FRI-247)
    return new RegExp(`(^|[^a-z0-9-])${escaped}(?![a-z0-9-]|-?\\d)`, 'i').test(cleanText);
  }
  return cleanText.includes(token) || (stemmed.length >= 4 && cleanText.includes(stemmed));
}

export function extractQueryRelevanceProfile(researchQuestion: string): {
  specificEntities: string[];
  coreEntities: string[];
  allTerms: string[];
  specificPhrases: string[];
} {
  const rawTokens = decodeHtmlEntities(researchQuestion)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !QUERY_STOP_WORDS.has(t));

  const allTerms = Array.from(new Set(rawTokens));
  const specificEntities = allTerms.filter(t => !GENERIC_CLINICAL_TERMS.has(t));
  const resolvedSpecific = specificEntities.length > 0 ? specificEntities : allTerms;
  const coreEntities = resolvedSpecific.filter(t => !WEAK_CONDITION_MODIFIERS.has(t));

  // Build consecutive 2-word phrases using specific entities (keeps clinical targets like "diabetic foot" or "heart failure")
  const specificPhrases: string[] = [];
  for (let i = 0; i < rawTokens.length - 1; i++) {
    const t1 = rawTokens[i];
    const t2 = rawTokens[i + 1];
    if (!GENERIC_CLINICAL_TERMS.has(t1) || !GENERIC_CLINICAL_TERMS.has(t2)) {
      if (t1.length >= 3 && t2.length >= 3) {
        specificPhrases.push(`${t1} ${t2}`);
      }
    }
  }

  return {
    specificEntities: resolvedSpecific,
    coreEntities,
    allTerms,
    specificPhrases: Array.from(new Set(specificPhrases))
  };
}

/**
 * Domain-agnostic dynamic relevance ranking & keyword-collision filtering:
 * - Uses 384-d dense biomedical embeddings (cosine similarity) combined with key entity overlap.
 * - Filters out low-relevance keyword collisions (e.g., matching only generic terms like "antibiotics"
 *   or "therapy" without matching the target condition or population in the researchQuestion).
 */
export function rankAndFilterStudiesForQuestion(
  studies: MedicalDocument[],
  researchQuestion: string
): RankedCorpusResult {
  if (!studies || studies.length === 0) {
    return {
      relevantStudies: [],
      filteredOutCount: 0,
      totalEvaluated: 0,
      queryEntities: []
    };
  }

  const sanitizedStudies = deduplicateNearIdenticalStudies(studies);
  const { specificEntities, coreEntities, allTerms, specificPhrases } = extractQueryRelevanceProfile(researchQuestion);
  const queryVector = generateLocalEmbedding(researchQuestion, 384);

  interface ScoredEntry {
    doc: MedicalDocument;
    combinedScore: number;
    cosine: number;
    specificHits: number;
    coreHits: number;
    titleSpecificHits: number;
    phraseHits: number;
  }

  const evaluated: ScoredEntry[] = sanitizedStudies.map((doc) => {
    const titleLower = (doc.title || '').toLowerCase();
    const rawAbs = (doc.abstract || '').trim();
    const hasMeaningfulAbstract =
      rawAbs.length >= 25 &&
      !/^abstract not reported in source metadata\.?$/i.test(rawAbs) &&
      !/^not reported in the retrieved studies\.?$/i.test(rawAbs);

    const abstractAndPicoLower = [
      hasMeaningfulAbstract ? rawAbs : '',
      doc.pico?.population && doc.pico.population !== 'Not reported' ? doc.pico.population : '',
      doc.pico?.intervention && doc.pico.intervention !== 'Not reported' ? doc.pico.intervention : '',
      doc.pico?.comparator && doc.pico.comparator !== 'Not reported' ? doc.pico.comparator : '',
      doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported' ? doc.pico.primaryOutcome : '',
      doc.fullTextSections?.methods || '',
      doc.fullTextSections?.results || ''
    ].join(' ').toLowerCase();
    const fullLower = `${titleLower} ${abstractAndPicoLower}`;

    const embedText = hasMeaningfulAbstract || doc.hasFullText
      ? `${doc.title} ${rawAbs} ${doc.fullText ? doc.fullText.slice(0, 3000) : ''}`.slice(0, 3500)
      : doc.title;
    const docVector = generateLocalEmbedding(embedText, 384);
    const rawCosine = Math.max(0, cosineSimilarity(queryVector, docVector));
    const localCosine = hasMeaningfulAbstract || doc.hasFullText ? rawCosine : rawCosine * 0.65;
    const priorScore = typeof doc.score === 'number' && doc.score > 0 && doc.score <= 1 ? doc.score : localCosine;
    const cosine = localCosine * 0.70 + priorScore * 0.30;

    let specificHits = 0;
    let titleSpecificHits = 0;
    for (const entity of specificEntities) {
      if (tokenMatchesText(entity, fullLower)) {
        specificHits++;
        if (tokenMatchesText(entity, titleLower)) {
          titleSpecificHits++;
        }
      }
    }

    let coreHits = 0;
    for (const core of coreEntities) {
      if (tokenMatchesText(core, fullLower)) {
        coreHits++;
      }
    }

    let phraseHits = 0;
    for (const phrase of specificPhrases) {
      if (stripConferencePosterCodes(fullLower).includes(phrase)) {
        phraseHits++;
      }
    }

    const specificRatio = specificEntities.length > 0 ? specificHits / specificEntities.length : 0;
    const titleRatio = specificEntities.length > 0 ? titleSpecificHits / specificEntities.length : 0;
    const phraseRatio = specificPhrases.length > 0 ? phraseHits / specificPhrases.length : 0;
    const fullTextBonus = doc.hasFullText ? 0.03 : 0;

    let combinedScore =
      cosine * 0.42 +
      specificRatio * 0.38 +
      titleRatio * 0.12 +
      phraseRatio * 0.08 +
      fullTextBonus;

    if (!hasMeaningfulAbstract && !doc.hasFullText) {
      combinedScore = combinedScore * 0.65;
    }

    return {
      doc: {
        ...doc,
        score: Number(Math.min(0.99, Math.max(0.01, combinedScore)).toFixed(4))
      },
      combinedScore,
      cosine,
      specificHits,
      coreHits,
      titleSpecificHits,
      phraseHits
    };
  });

  // Strict collision filter: discard studies that have ZERO core/specific entity matches
  // when specific condition/population entities exist in the query (prevents generic "antibiotics" / "infection" collisions)
  const hasDistinctTargets = specificEntities.length > 0 && allTerms.length >= 2;
  let filtered = evaluated.filter((item) => {
    if (!hasDistinctTargets) {
      return item.specificHits > 0 || item.cosine >= 0.16;
    }
    if (coreEntities.length > 0 && item.coreHits === 0) {
      return false;
    }
    if (item.specificHits === 0) {
      return false;
    }
    if (specificEntities.length >= 3 && item.specificHits === 1 && item.titleSpecificHits === 0 && item.cosine < 0.25) {
      return false;
    }
    return true;
  });

  // Graceful fallback if query relies purely on synonyms/MeSH terms not literally echoed in text
  if (filtered.length === 0) {
    filtered = evaluated.filter(item => item.cosine >= 0.18);
  }
  if (filtered.length === 0) {
    filtered = evaluated.slice(0, Math.min(10, evaluated.length));
  }

  filtered.sort((a, b) => {
    if (Math.abs(b.combinedScore - a.combinedScore) > 0.005) {
      return b.combinedScore - a.combinedScore;
    }
    if ((b.doc.year || 0) !== (a.doc.year || 0)) return (b.doc.year || 0) - (a.doc.year || 0);
    return (b.doc.citationCount || 0) - (a.doc.citationCount || 0);
  });

  return {
    relevantStudies: filtered.map(f => f.doc),
    filteredOutCount: Math.max(0, evaluated.length - filtered.length),
    totalEvaluated: evaluated.length,
    queryEntities: specificEntities
  };
}

const DATABASE_LABEL_MAP: Record<string, string> = {
  pubmed: 'PubMed/NCBI Entrez',
  'pubmed/ncbi entrez': 'PubMed/NCBI Entrez',
  openalex: 'OpenAlex',
  doaj: 'DOAJ',
  crossref: 'Crossref',
  'google scholar': 'Google Scholar',
  scopus: 'Scopus',
  embase: 'Embase',
  'google search': 'Google Search',
  clinicaltrials: 'ClinicalTrials.gov',
  'clinicaltrials.gov': 'ClinicalTrials.gov',
  isrctn: 'ISRCTN'
};

/**
 * Reconciles queried databases and primary deduplicated source counts:
 * - Lists ONLY the databases actually queried for the session.
 * - Sums ONLY primary deduplicated sources (`uniqueIncluded === sum(databaseBreakdown)`).
 * - Tracks `PMC` open-access full-text retrievals strictly as an enrichment subset of `PubMed`.
 */
export function buildRetrievalStats(
  relevantStudies: MedicalDocument[],
  targetDatabases: string[],
  overrideStats?: Partial<RetrievalStatsMetadata>,
  totalEvaluatedPoolSize?: number
): RetrievalStatsMetadata {
  const databaseBreakdown: Record<string, number> = {};
  const studyDesignCounts: Record<string, number> = {};
  let pmcFullTextCount = 0;
  let pubmedTotalCount = 0;

  for (const doc of relevantStudies) {
    const src = doc.source || 'PubMed';
    databaseBreakdown[src] = (databaseBreakdown[src] || 0) + 1;

    if (src === 'PubMed') {
      pubmedTotalCount++;
    }
    if (doc.hasFullText && (src === 'PubMed' || Boolean(doc.pmcid))) {
      pmcFullTextCount++;
    }

    const design = doc.pico?.design || 'Observational / Descriptive Study';
    studyDesignCounts[design] = (studyDesignCounts[design] || 0) + 1;
  }

  // Strictly preserve only databases queried in this session (do not force-add unselected databases)
  const rawQueried = targetDatabases && targetDatabases.length > 0
    ? targetDatabases
    : Object.keys(databaseBreakdown).length > 0
    ? Object.keys(databaseBreakdown)
    : ['PubMed/NCBI Entrez', 'OpenAlex', 'DOAJ', 'Crossref'];

  const queriedSet = new Set<string>();
  for (const db of rawQueried) {
    const cleanDb = db.trim();
    const lower = cleanDb.toLowerCase();
    // Skip standalone 'PMC' as a primary DB row since PMC is reported strictly as an enrichment subset of PubMed
    if (lower === 'pmc' || lower.startsWith('pmc (')) continue;
    queriedSet.add(DATABASE_LABEL_MAP[lower] || cleanDb);
  }
  // Ensure any database that actually produced a unique primary study in the pool is accounted for in queried list
  for (const src of Object.keys(databaseBreakdown)) {
    const mapped = DATABASE_LABEL_MAP[src.toLowerCase()] || src;
    if (mapped) queriedSet.add(mapped);
  }

  const uniqueIncluded = relevantStudies.length;
  const totalIndexed = Math.max(
    uniqueIncluded,
    totalEvaluatedPoolSize ?? 0,
    overrideStats?.totalIndexed ?? 0
  );

  return {
    totalIndexed,
    uniqueIncluded,
    pmcFullTextCount,
    pubmedTotalCount,
    filteredOutLowRelevanceCount: Math.max(0, (totalEvaluatedPoolSize ?? uniqueIncluded) - uniqueIncluded),
    databasesQueried: Array.from(queriedSet),
    databaseBreakdown,
    studyDesignCounts,
    studyDesigns: Object.keys(studyDesignCounts)
  };
}

/**
 * Formats canonical inline citation tag: [Author, Year (PMID/DOI)]
 * Uses sanitized author or falls back cleanly to journal/organization name or Year+ID (never "Investigator").
 */
export function formatCanonicalCitation(doc: MedicalDocument): string {
  const cleanDoi = sanitizeDoi(doc.doi);
  const idPart = doc.pmid ? `PMID:${doc.pmid}` : (cleanDoi || doc.id);
  const yearLabel = typeof doc.year === 'number' && doc.year >= 1950 ? String(doc.year) : 'n.d.';
  const validAuthors = sanitizeAuthorsList(doc.authors);
  const candidateFirst = validAuthors[0] || (!isPlaceholderAuthor(doc.firstAuthor) ? decodeHtmlEntities(doc.firstAuthor) : '');

  if (candidateFirst) {
    const authorSurname = candidateFirst.split(/\s+/)[0] || candidateFirst;
    return `[${authorSurname}, ${yearLabel} (${idPart})]`;
  }

  const cleanJournal = sanitizeJournalField(doc.journal);
  if (cleanJournal && cleanJournal !== 'Biomedical Journal' && cleanJournal !== 'Medical Journal') {
    return `[${cleanJournal}, ${yearLabel} (${idPart})]`;
  }
  return `[${yearLabel} (${idPart})]`;
}

/**
 * Builds structured `PICO_MATRIX`, `CONTEXT_SOURCES`, and reconciled `RETRIEVAL_METADATA`
 * from relevance-ranked, data-richness-prioritized, HTML-decoded studies.
 */
export function buildCorpusContext(
  relevantStudies: MedicalDocument[],
  stats: RetrievalStatsMetadata,
  maxDocsInContext = 15
): { picoMatrixJson: string; contextSourcesText: string; statsMetadataText: string } {
  const includedDocs = selectStudiesByDataRichness(relevantStudies, maxDocsInContext);

  const picoMatrix = includedDocs.map((doc, idx) => {
    const validAuthors = sanitizeAuthorsList(doc.authors);
    const authorLabel = resolveAuthorOrJournalFallback(doc);
    return {
      sourceIndex: idx + 1,
      canonicalCitation: formatCanonicalCitation(doc),
      firstAuthor: authorLabel || null,
      authors: validAuthors.slice(0, 6),
      title: doc.title,
      journal: doc.journal,
      year: typeof doc.year === 'number' && doc.year >= 1950 ? doc.year : 'Year n.d.',
      pmid: doc.pmid || null,
      pmcid: doc.pmcid || null,
      nctId: doc.nctId || null,
      isrctnId: doc.isrctnId || null,
      doi: doc.doi || null,
      sourceDatabase: doc.source,
      mergedSources: doc.mergedSources && doc.mergedSources.length > 0 ? doc.mergedSources : [doc.source],
      relevanceScore: doc.score ?? null,
      picoCompletenessScore: computePicoCompletenessScore(doc),
      hasPmcFullText: Boolean(doc.hasFullText),
      design: doc.pico?.design || 'Observational / Descriptive Study',
      population: doc.pico?.population && doc.pico.population !== 'Not reported' ? doc.pico.population : 'Not reported',
      sampleSizeN: typeof doc.pico?.sampleSize === 'number' && doc.pico.sampleSize > 0
        ? doc.pico.sampleSize
        : 'Not reported',
      intervention: doc.pico?.intervention && doc.pico.intervention !== 'Not reported' ? doc.pico.intervention : 'Not reported',
      comparator: doc.pico?.comparator && doc.pico.comparator !== 'Not reported' ? doc.pico.comparator : 'Not reported',
      primaryOutcome: doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported' ? doc.pico.primaryOutcome : 'Not reported',
      primaryStatistic: doc.pico?.primaryStatistic || 'Not reported',
      effectMetricType: doc.pico?.effectMetricType || null,
      effectEstimate: doc.pico?.effectEstimate || 'Not reported',
      hazardRatio: doc.pico?.hazardRatio || 'Not reported',
      riskRatio: doc.pico?.riskRatio || 'Not reported',
      pValues: Array.isArray(doc.pico?.pValues) && doc.pico.pValues.length > 0
        ? doc.pico.pValues
        : ['Not reported']
    };
  });

  const contextSourcesText = includedDocs.map((doc, idx) => {
    const citationKey = formatCanonicalCitation(doc);
    const validAuthors = sanitizeAuthorsList(doc.authors);
    const authorDisplay = validAuthors.length > 0
      ? validAuthors.slice(0, 8).join(', ')
      : (resolveAuthorOrJournalFallback(doc) || 'Not reported');
    const registryIds = [
      doc.nctId ? `NCT: ${doc.nctId}` : null,
      doc.isrctnId ? `ISRCTN: ${doc.isrctnId}` : null
    ].filter(Boolean).join(' | ');
    const mergedLabel = doc.mergedSources && doc.mergedSources.length > 1
      ? ` (Merged from: ${doc.mergedSources.join(', ')})`
      : '';
    const yearDisplay = formatPublicationYear(doc.year);
    const lines: string[] = [
      `[SOURCE ${idx + 1}] ${citationKey}`,
      `Authors: ${authorDisplay}`,
      `Title: ${doc.title}`,
      `Journal: ${doc.journal} (${yearDisplay}) | Source DB: ${doc.source}${mergedLabel} | PMID: ${doc.pmid || 'N/A'} | PMCID: ${doc.pmcid || 'N/A'} | DOI: ${doc.doi || 'N/A'}${registryIds ? ` | ${registryIds}` : ''}`,
      `Study Design: ${doc.pico?.design || 'Observational / Descriptive Study'} | Sample Size N: ${doc.pico?.sampleSize > 0 ? doc.pico.sampleSize : 'Not reported'} | Primary Statistic: ${doc.pico?.primaryStatistic || doc.pico?.pValues?.[0] || 'Not reported'}`,
      `AbstractText: ${doc.abstract || 'Not reported in the retrieved studies'}`
    ];

    if (doc.hasFullText && doc.fullTextSections) {
      const { methods, results, tables, discussion } = doc.fullTextSections;
      if (methods) lines.push(`PMC_METHODS: ${decodeHtmlEntities(methods).slice(0, 1200)}`);
      if (results) lines.push(`PMC_RESULTS: ${decodeHtmlEntities(results).slice(0, 1400)}`);
      if (tables) lines.push(`PMC_TABLES: ${decodeHtmlEntities(tables).slice(0, 1000)}`);
      if (discussion) lines.push(`PMC_DISCUSSION: ${decodeHtmlEntities(discussion).slice(0, 900)}`);
    } else if (doc.hasFullText && doc.fullText) {
      lines.push(`PMC_FULL_TEXT_EXCERPT: ${decodeHtmlEntities(doc.fullText).slice(0, 2200)}`);
    }

    return lines.join('\n');
  }).join('\n\n---\n\n');

  const designBreakdownSummary = Object.entries(stats.studyDesignCounts)
    .map(([design, count]) => `${count} ${pluralizeStudyDesign(design, count)}`)
    .join(', ');

  const statsMetadataText = JSON.stringify({
    databasesQueried: stats.databasesQueried,
    totalRetrievedPool: stats.totalIndexed,
    filteredOutLowRelevanceCount: stats.filteredOutLowRelevanceCount,
    uniqueRelevantStudiesIncluded: stats.uniqueIncluded,
    primarySourceCountsSummingToUnique: stats.databaseBreakdown,
    pmcFullTextEnrichmentSubsetOfPubMed: {
      pmcFullTextArticles: stats.pmcFullTextCount,
      pubmedPrimaryArticles: stats.pubmedTotalCount,
      note: 'PMC is an open-access full-text enrichment subset of PubMed, not an additive database count.'
    },
    studyDesignCounts: stats.studyDesignCounts,
    studyDesignSummary: designBreakdownSummary,
    studyDesignsPresent: stats.studyDesigns
  }, null, 2);

  return {
    picoMatrixJson: JSON.stringify(picoMatrix, null, 2),
    contextSourcesText: contextSourcesText || 'NO RETRIEVED STUDIES AVAILABLE. Explicitly write "Not reported in the retrieved studies" for empirical figures and avoid fabricating citations.',
    statsMetadataText
  };
}
