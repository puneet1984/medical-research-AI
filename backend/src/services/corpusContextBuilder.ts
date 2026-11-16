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
  'Randomized Controlled Trial': 'Randomized Controlled Trials',
  'Clinical Trial': 'Clinical Trials'
};

export function pluralizeStudyDesign(design: string, count: number): string {
  const cleanDesign = (design || 'Clinical Trial').trim();
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
export function decodeHtmlEntities(input?: string | null): string {
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

/**
 * Sanitizes all textual and URL metadata fields on a MedicalDocument.
 */
export function sanitizeDocumentMetadata(doc: MedicalDocument): MedicalDocument {
  const cleanDoi = sanitizeDoi(doc.doi);
  const cleanTitle = decodeHtmlEntities(doc.title).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'Clinical Study';
  const cleanJournal = sanitizeJournalField(doc.journal);
  const cleanAuthors = (doc.authors || []).map(a => decodeHtmlEntities(a).trim()).filter(Boolean);
  const cleanFirstAuthor = decodeHtmlEntities(doc.firstAuthor || cleanAuthors[0] || 'Investigator').trim();
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
          hazardRatio: doc.pico.hazardRatio ? decodeHtmlEntities(doc.pico.hazardRatio) : undefined,
          riskRatio: doc.pico.riskRatio ? decodeHtmlEntities(doc.pico.riskRatio) : undefined,
          pValues: (doc.pico.pValues || []).map(p => decodeHtmlEntities(p)).filter(Boolean)
        }
      : doc.pico
  };
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

function tokenMatchesText(token: string, textLower: string): boolean {
  const stemmed = stemToken(token);
  if (token.length <= 3) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(textLower);
  }
  return textLower.includes(token) || (stemmed.length >= 4 && textLower.includes(stemmed));
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

  const sanitizedStudies = studies.map(sanitizeDocumentMetadata);
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
    const abstractAndPicoLower = [
      doc.abstract || '',
      doc.pico?.population || '',
      doc.pico?.intervention || '',
      doc.pico?.comparator || '',
      doc.pico?.primaryOutcome || '',
      doc.fullTextSections?.methods || '',
      doc.fullTextSections?.results || ''
    ].join(' ').toLowerCase();
    const fullLower = `${titleLower} ${abstractAndPicoLower}`;

    const docVector = generateLocalEmbedding(
      `${doc.title} ${doc.abstract || ''} ${doc.pico?.population || ''} ${doc.pico?.intervention || ''} ${doc.pico?.primaryOutcome || ''}`.slice(0, 3000),
      384
    );
    const localCosine = Math.max(0, cosineSimilarity(queryVector, docVector));
    const priorScore = typeof doc.score === 'number' && doc.score > 0 && doc.score <= 1 ? doc.score : localCosine;
    const cosine = localCosine * 0.65 + priorScore * 0.35;

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
      if (fullLower.includes(phrase)) {
        phraseHits++;
      }
    }

    const specificRatio = specificEntities.length > 0 ? specificHits / specificEntities.length : 0;
    const titleRatio = specificEntities.length > 0 ? titleSpecificHits / specificEntities.length : 0;
    const phraseRatio = specificPhrases.length > 0 ? phraseHits / specificPhrases.length : 0;
    const fullTextBonus = doc.hasFullText ? 0.03 : 0;

    const combinedScore =
      cosine * 0.42 +
      specificRatio * 0.38 +
      titleRatio * 0.12 +
      phraseRatio * 0.08 +
      fullTextBonus;

    return {
      doc: {
        ...doc,
        score: Number(Math.min(0.99, Math.max(0.05, combinedScore)).toFixed(4))
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
    if (Math.abs(b.combinedScore - a.combinedScore) > 0.025) {
      return b.combinedScore - a.combinedScore;
    }
    if (b.doc.year !== a.doc.year) return b.doc.year - a.doc.year;
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
  clinicaltrials: 'ClinicalTrials.gov'
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

    const design = doc.pico?.design || 'Clinical Trial';
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
 */
export function formatCanonicalCitation(doc: MedicalDocument): string {
  const authorSurname = decodeHtmlEntities(doc.firstAuthor || 'Investigator').split(/\s+/)[0] || 'Investigator';
  const cleanDoi = sanitizeDoi(doc.doi);
  const idPart = doc.pmid ? `PMID:${doc.pmid}` : (cleanDoi || doc.id);
  return `[${authorSurname}, ${doc.year} (${idPart})]`;
}

/**
 * Builds structured `PICO_MATRIX`, `CONTEXT_SOURCES`, and reconciled `RETRIEVAL_METADATA`
 * from relevance-ranked, HTML-decoded studies.
 */
export function buildCorpusContext(
  relevantStudies: MedicalDocument[],
  stats: RetrievalStatsMetadata,
  maxDocsInContext = 15
): { picoMatrixJson: string; contextSourcesText: string; statsMetadataText: string } {
  const includedDocs = relevantStudies.slice(0, maxDocsInContext).map(sanitizeDocumentMetadata);

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
    relevanceScore: doc.score ?? null,
    hasPmcFullText: Boolean(doc.hasFullText),
    design: doc.pico?.design || 'Clinical Trial',
    population: doc.pico?.population && doc.pico.population !== 'Not reported' ? doc.pico.population : 'Not reported',
    sampleSizeN: typeof doc.pico?.sampleSize === 'number' && doc.pico.sampleSize > 0
      ? doc.pico.sampleSize
      : 'Not reported',
    intervention: doc.pico?.intervention && doc.pico.intervention !== 'Not reported' ? doc.pico.intervention : 'Not reported',
    comparator: doc.pico?.comparator && doc.pico.comparator !== 'Not reported' ? doc.pico.comparator : 'Not reported',
    primaryOutcome: doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported' ? doc.pico.primaryOutcome : 'Not reported',
    hazardRatio: doc.pico?.hazardRatio || 'Not reported',
    riskRatio: doc.pico?.riskRatio || 'Not reported',
    pValues: Array.isArray(doc.pico?.pValues) && doc.pico.pValues.length > 0
      ? doc.pico.pValues
      : ['Not reported']
  }));

  const contextSourcesText = includedDocs.map((doc, idx) => {
    const citationKey = formatCanonicalCitation(doc);
    const lines: string[] = [
      `[SOURCE ${idx + 1}] ${citationKey}`,
      `Authors: ${doc.authors.slice(0, 8).join(', ') || doc.firstAuthor}`,
      `Title: ${doc.title}`,
      `Journal: ${doc.journal} (${doc.year}) | Source DB: ${doc.source} | PMID: ${doc.pmid || 'N/A'} | PMCID: ${doc.pmcid || 'N/A'} | DOI: ${doc.doi || 'N/A'}`,
      `Study Design: ${doc.pico?.design || 'Clinical Trial'} | Sample Size N: ${doc.pico?.sampleSize > 0 ? doc.pico.sampleSize : 'Not reported'}`,
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
