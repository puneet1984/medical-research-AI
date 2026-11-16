import type { MedicalDocument, PicoData } from '../services/searchService.js';
import {
  sanitizeDocumentMetadata,
  sanitizeDoi,
  sanitizeAuthorsList,
  computePicoCompletenessScore,
  computeTitleSimilarity
} from '../services/corpusContextBuilder.js';

/**
 * Primary source authority ranking:
 * Peer-reviewed publications ALWAYS outrank registry records as the primary record
 * so `databaseBreakdown` / `uniqueStudies` reflects peer-reviewed journals first.
 */
const SOURCE_PRIORITY_RANK: Record<string, number> = {
  'PubMed': 100,
  'OpenAlex': 90,
  'Scopus': 80,
  'Crossref': 70,
  'Embase': 65,
  'DOAJ': 60,
  'Google Scholar': 50,
  'Google Search': 40,
  'ClinicalTrials.gov': 20,
  'ClinicalTrials': 20,
  'ISRCTN': 10
};

function getSourceRank(source?: string): number {
  if (!source) return 0;
  return SOURCE_PRIORITY_RANK[source] ?? 30;
}

function normalizeTitleKey(title?: string | null): string {
  return String(title || '')
    .toLowerCase()
    .replace(/\[[^\]]*(?:abstract|poster|letter|comment|erratum)[^\]]*\]/gi, ' ')
    .replace(/\([^)]*(?:abstract|poster|suppl)[^)]*\)/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAllPmids(doc: MedicalDocument): string[] {
  const ids = new Set<string>();
  if (doc.pmid && /^\d+$/.test(doc.pmid.trim())) ids.add(doc.pmid.trim());
  for (const lp of doc.linkedPmids || []) {
    if (/^\d+$/.test(String(lp).trim())) ids.add(String(lp).trim());
  }
  return Array.from(ids);
}

function extractAllDois(doc: MedicalDocument): string[] {
  const dois = new Set<string>();
  const mainDoi = sanitizeDoi(doc.doi).toLowerCase();
  if (mainDoi) dois.add(mainDoi);
  for (const ld of doc.linkedDois || []) {
    const clean = sanitizeDoi(ld).toLowerCase();
    if (clean) dois.add(clean);
  }
  return Array.from(dois);
}

function extractNctId(doc: MedicalDocument): string | undefined {
  if (doc.nctId && /^NCT\d{8}$/i.test(doc.nctId.trim())) {
    return doc.nctId.trim().toUpperCase();
  }
  const haystack = [doc.title, doc.abstract, doc.doi, doc.webUrl].filter(Boolean).join(' ');
  const m = haystack.match(/\b(NCT\d{8})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function extractIsrctnId(doc: MedicalDocument): string | undefined {
  if (doc.isrctnId && /^ISRCTN\d{6,10}$/i.test(doc.isrctnId.trim())) {
    return doc.isrctnId.trim().toUpperCase();
  }
  const doiMatch = String(doc.doi || '').match(/10\.1186\/(isrctn\d+)/i);
  if (doiMatch?.[1]) return doiMatch[1].toUpperCase();
  const haystack = [doc.title, doc.abstract, doc.webUrl].filter(Boolean).join(' ');
  const m = haystack.match(/\b(ISRCTN\d{6,10})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function pickBetterPicoField(primaryVal?: string, secondaryVal?: string): string {
  const pClean = (primaryVal || '').trim();
  const sClean = (secondaryVal || '').trim();
  const pValid = Boolean(pClean && pClean !== 'Not reported');
  const sValid = Boolean(sClean && sClean !== 'Not reported');
  if (pValid && sValid) {
    return pClean.length >= sClean.length ? pClean : sClean;
  }
  return pValid ? pClean : (sValid ? sClean : 'Not reported');
}

function mergePicoData(primary: PicoData, secondary: PicoData): PicoData {
  const primaryPvals = Array.isArray(primary?.pValues) ? primary.pValues : [];
  const secondaryPvals = Array.isArray(secondary?.pValues) ? secondary.pValues : [];
  const mergedPValues = Array.from(new Set([...primaryPvals, ...secondaryPvals])).slice(0, 6);

  const primaryN = typeof primary?.sampleSize === 'number' && primary.sampleSize > 0 ? primary.sampleSize : 0;
  const secondaryN = typeof secondary?.sampleSize === 'number' && secondary.sampleSize > 0 ? secondary.sampleSize : 0;

  let mergedDesign = primary?.design || 'Observational / Descriptive Study';
  if (mergedDesign === 'Observational / Descriptive Study' && secondary?.design && secondary.design !== 'Observational / Descriptive Study') {
    mergedDesign = secondary.design;
  }

  return {
    population: pickBetterPicoField(primary?.population, secondary?.population),
    sampleSize: primaryN > 0 ? primaryN : secondaryN,
    intervention: pickBetterPicoField(primary?.intervention, secondary?.intervention),
    comparator: pickBetterPicoField(primary?.comparator, secondary?.comparator),
    primaryOutcome: pickBetterPicoField(primary?.primaryOutcome, secondary?.primaryOutcome),
    pValues: mergedPValues,
    hazardRatio: primary?.hazardRatio || secondary?.hazardRatio,
    riskRatio: primary?.riskRatio || secondary?.riskRatio,
    design: mergedDesign
  };
}

function isSameStudy(a: MedicalDocument, b: MedicalDocument, normTitleA: string, normTitleB: string): boolean {
  // 1. Direct or linked PMID overlap
  const pmidsA = extractAllPmids(a);
  const pmidsB = new Set(extractAllPmids(b));
  if (pmidsA.some(p => pmidsB.has(p))) return true;

  // 2. Direct or linked DOI overlap
  const doisA = extractAllDois(a);
  const doisB = new Set(extractAllDois(b));
  if (doisA.some(d => doisB.has(d))) return true;

  // 3. NCT ID overlap
  const nctA = extractNctId(a);
  const nctB = extractNctId(b);
  if (nctA && nctB && nctA === nctB) return true;

  // 4. ISRCTN ID overlap
  const isrA = extractIsrctnId(a);
  const isrB = extractIsrctnId(b);
  if (isrA && isrB && isrA === isrB) return true;

  // 5. >90% normalized title match (for meaningful titles length > 25)
  if (normTitleA.length > 25 && normTitleB.length > 25) {
    const sim = computeTitleSimilarity(normTitleA, normTitleB);
    if (sim > 0.90) return true;
  } else if (normTitleA && normTitleA === normTitleB) {
    return true;
  }

  return false;
}

function mergeStudyPair(docA: MedicalDocument, docB: MedicalDocument): MedicalDocument {
  const rankA = getSourceRank(docA.source);
  const rankB = getSourceRank(docB.source);

  let primary = docA;
  let secondary = docB;

  if (rankB > rankA) {
    primary = docB;
    secondary = docA;
  } else if (rankA === rankB) {
    // Within same tier, prefer richer PMC full text / PICO completeness / longer abstract
    const scoreA = (docA.hasFullText ? 50 : 0) + computePicoCompletenessScore(docA) * 3 + Math.min(20, (docA.abstract || '').length / 100);
    const scoreB = (docB.hasFullText ? 50 : 0) + computePicoCompletenessScore(docB) * 3 + Math.min(20, (docB.abstract || '').length / 100);
    if (scoreB > scoreA) {
      primary = docB;
      secondary = docA;
    }
  }

  const mergedSources = Array.from(
    new Set([
      ...(primary.mergedSources || [primary.source]),
      ...(secondary.mergedSources || [secondary.source]),
      primary.source,
      secondary.source
    ].filter(Boolean))
  );

  const mergedLinkedPmids = Array.from(new Set([...extractAllPmids(primary), ...extractAllPmids(secondary)]));
  const mergedLinkedDois = Array.from(new Set([...extractAllDois(primary), ...extractAllDois(secondary)]));

  const validAuthorsPrimary = sanitizeAuthorsList(primary.authors);
  const validAuthorsSecondary = sanitizeAuthorsList(secondary.authors);
  const authors = validAuthorsPrimary.length > 0 ? validAuthorsPrimary : validAuthorsSecondary;
  const firstAuthor = primary.firstAuthor || secondary.firstAuthor;

  const hasFullText = Boolean(primary.hasFullText || secondary.hasFullText);
  const fullText = (primary.fullText || '').length >= (secondary.fullText || '').length
    ? (primary.fullText || secondary.fullText)
    : secondary.fullText;

  return {
    ...primary,
    authors,
    firstAuthor: authors[0] || firstAuthor,
    doi: sanitizeDoi(primary.doi) || sanitizeDoi(secondary.doi),
    pmid: primary.pmid || secondary.pmid,
    pmcid: primary.pmcid || secondary.pmcid,
    nctId: extractNctId(primary) || extractNctId(secondary),
    isrctnId: extractIsrctnId(primary) || extractIsrctnId(secondary),
    nctVerified: Boolean(primary.nctVerified || secondary.nctVerified),
    isrctnVerified: Boolean(primary.isrctnVerified || secondary.isrctnVerified),
    registryUrl: primary.registryUrl || secondary.registryUrl,
    linkedPmids: mergedLinkedPmids.length > 0 ? mergedLinkedPmids : undefined,
    linkedDois: mergedLinkedDois.length > 0 ? mergedLinkedDois : undefined,
    mergedSources,
    hasFullText,
    fullText,
    fullTextSections: primary.fullTextSections || secondary.fullTextSections,
    abstract: (primary.abstract || '').length >= (secondary.abstract || '').length ? primary.abstract : secondary.abstract,
    citationCount: Math.max(primary.citationCount || 0, secondary.citationCount || 0),
    isOpenAccess: Boolean(primary.isOpenAccess || secondary.isOpenAccess),
    score: typeof primary.score === 'number' || typeof secondary.score === 'number'
      ? Math.max(primary.score || 0, secondary.score || 0)
      : undefined,
    pico: mergePicoData(primary.pico, secondary.pico)
  };
}

/**
 * Unifies duplicate studies across PubMed, OpenAlex, Scopus, Crossref, DOAJ,
 * Google Scholar, ClinicalTrials.gov, and ISRCTN using multi-key identity matching
 * (PMID, linkedPmids, DOI, linkedDois, NCT, ISRCTN, >90% normalized title match).
 *
 * Always preserves peer-reviewed publication as primary metadata record while absorbing
 * structured registry arms, enrollment (N), outcomes, and PMC full text.
 */
export function deduplicateAndMergeStudies(rawStudies: MedicalDocument[]): MedicalDocument[] {
  if (!rawStudies || rawStudies.length === 0) return [];

  const merged: MedicalDocument[] = [];
  const normTitles: string[] = [];

  for (const raw of rawStudies) {
    const doc = sanitizeDocumentMetadata(raw);
    const normTitle = normalizeTitleKey(doc.title);

    let matchIdx = -1;
    for (let i = 0; i < merged.length; i++) {
      if (isSameStudy(merged[i], doc, normTitles[i], normTitle)) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx >= 0) {
      merged[matchIdx] = mergeStudyPair(merged[matchIdx], doc);
      normTitles[matchIdx] = normalizeTitleKey(merged[matchIdx].title);
    } else {
      merged.push({
        ...doc,
        nctId: extractNctId(doc),
        isrctnId: extractIsrctnId(doc),
        mergedSources: doc.mergedSources && doc.mergedSources.length > 0 ? doc.mergedSources : [doc.source]
      });
      normTitles.push(normTitle);
    }
  }

  return merged;
}
