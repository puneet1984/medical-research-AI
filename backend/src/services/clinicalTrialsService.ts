import type { MedicalDocument, PicoData } from './searchService.js';
import {
  decodeHtmlEntities,
  sanitizeAuthorsList,
  resolveAuthorOrJournalFallback
} from './corpusContextBuilder.js';
import { apiCache } from '../utils/apiCache.js';
import { config } from '../config.js';

const CLINICAL_TRIALS_V2_BASE = 'https://clinicaltrials.gov/api/v2/studies';

let lastCtGovRequestTime = 0;
async function waitForCtGovRateLimit(): Promise<void> {
  const minIntervalMs = 120;
  const now = Date.now();
  const elapsed = now - lastCtGovRequestTime;
  if (elapsed < minIntervalMs) {
    await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastCtGovRequestTime = Date.now();
}

function cleanField(raw?: string | null, maxLen = 260): string {
  if (!raw || typeof raw !== 'string') return 'Not reported';
  const cleaned = decodeHtmlEntities(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.split(/\s+/).length < 2) return 'Not reported';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3).trimEnd()}...` : cleaned;
}

function mapCtGovStudyDesign(designModule: any): PicoData['design'] {
  const studyType = String(designModule?.studyType || '').toUpperCase();
  const allocation = String(designModule?.designInfo?.allocation || '').toUpperCase();
  const model = String(designModule?.designInfo?.observationalModel || '').toUpperCase();

  if (studyType === 'INTERVENTIONAL') {
    if (allocation === 'RANDOMIZED') {
      return 'Randomized Controlled Trial';
    }
    return 'Clinical Trial';
  }
  if (studyType === 'OBSERVATIONAL' || model) {
    return 'Cohort Study';
  }
  return 'Observational / Descriptive Study';
}

function extractCtGovYear(statusModule: any): number {
  const rawDate =
    statusModule?.primaryCompletionDateStruct?.date ||
    statusModule?.completionDateStruct?.date ||
    statusModule?.startDateStruct?.date ||
    statusModule?.lastUpdatePostDateStruct?.date ||
    '';
  const m = String(rawDate).match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : new Date().getFullYear();
}

function extractCtGovArms(armsModule: any): { intervention: string; comparator: string } {
  const armGroups: any[] = Array.isArray(armsModule?.armGroups) ? armsModule.armGroups : [];
  const interventionsList: any[] = Array.isArray(armsModule?.interventions) ? armsModule.interventions : [];

  const experimentalArms: string[] = [];
  const comparatorArms: string[] = [];

  for (const arm of armGroups) {
    const label = decodeHtmlEntities(arm?.label || '');
    const desc = decodeHtmlEntities(arm?.description || '');
    const type = String(arm?.type || '').toUpperCase();
    const summary = desc && desc.length <= 110 ? `${label}: ${desc}` : label;
    if (!summary) continue;

    if (
      type === 'PLACEBO_COMPARATOR' ||
      type === 'ACTIVE_COMPARATOR' ||
      type === 'SHAM_COMPARATOR' ||
      type === 'NO_INTERVENTION' ||
      /\b(placebo|control|standard\s+of\s+care|usual\s+care|sham|comparator)\b/i.test(`${label} ${desc}`)
    ) {
      comparatorArms.push(summary);
    } else {
      experimentalArms.push(summary);
    }
  }

  if (experimentalArms.length === 0 && interventionsList.length > 0) {
    for (const iv of interventionsList) {
      const name = decodeHtmlEntities(iv?.name || '');
      if (!name) continue;
      if (/\bplacebo|sham\b/i.test(name)) {
        comparatorArms.push(name);
      } else {
        experimentalArms.push(name);
      }
    }
  }

  return {
    intervention: cleanField(experimentalArms.slice(0, 3).join('; '), 220),
    comparator: cleanField(comparatorArms.slice(0, 3).join('; '), 220)
  };
}

function extractCtGovPopulation(conditionsModule: any, eligibilityModule: any): string {
  const conditions = Array.isArray(conditionsModule?.conditions)
    ? conditionsModule.conditions.map((c: any) => decodeHtmlEntities(String(c || ''))).filter(Boolean)
    : [];

  let criteriaSnippet = '';
  const rawCriteria = decodeHtmlEntities(eligibilityModule?.eligibilityCriteria || '');
  if (rawCriteria) {
    const incMatch = rawCriteria.match(/Inclusion Criteria[:\s]*([\s\S]{10,220}?)(?:Exclusion Criteria|$)/i);
    const base = (incMatch?.[1] || rawCriteria).replace(/\s*\*+\s*/g, '; ').replace(/\s+/g, ' ').trim();
    criteriaSnippet = base.slice(0, 140).trim();
  }

  const combined = [conditions.slice(0, 3).join(', '), criteriaSnippet].filter(Boolean).join(' — ');
  return cleanField(combined, 240);
}

function extractCtGovPrimaryOutcome(outcomesModule: any): string {
  const primaries: any[] = Array.isArray(outcomesModule?.primaryOutcomes) ? outcomesModule.primaryOutcomes : [];
  if (primaries.length === 0) return 'Not reported';
  const formatted = primaries.slice(0, 2).map((o: any) => {
    const measure = decodeHtmlEntities(o?.measure || '');
    const timeFrame = decodeHtmlEntities(o?.timeFrame || '');
    return timeFrame ? `${measure} (${timeFrame})` : measure;
  }).filter(Boolean);
  return cleanField(formatted.join('; '), 240);
}

function extractCtGovLinkedPmids(referencesModule: any): string[] {
  const refs: any[] = Array.isArray(referencesModule?.references) ? referencesModule.references : [];
  const pmids = new Set<string>();
  for (const r of refs) {
    const raw = String(r?.pmid || '').trim();
    if (/^\d+$/.test(raw)) pmids.add(raw);
  }
  return Array.from(pmids);
}

export function mapProtocolSectionToDocument(protocolSection: any, score?: number): MedicalDocument | null {
  if (!protocolSection || typeof protocolSection !== 'object') return null;

  const idMod = protocolSection.identificationModule || {};
  const statusMod = protocolSection.statusModule || {};
  const sponsorMod = protocolSection.sponsorCollaboratorsModule || {};
  const descMod = protocolSection.descriptionModule || {};
  const condMod = protocolSection.conditionsModule || {};
  const designMod = protocolSection.designModule || {};
  const armsMod = protocolSection.armsInterventionsModule || {};
  const outMod = protocolSection.outcomesModule || {};
  const eligMod = protocolSection.eligibilityModule || {};
  const contactsMod = protocolSection.contactsLocationsModule || {};
  const refsMod = protocolSection.referencesModule || {};

  const nctId = String(idMod.nctId || '').trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(nctId)) return null;

  const title = decodeHtmlEntities(idMod.officialTitle || idMod.briefTitle || `Clinical Study ${nctId}`);
  const officialNames = (Array.isArray(contactsMod.overallOfficials) ? contactsMod.overallOfficials : [])
    .map((o: any) => decodeHtmlEntities(o?.name || ''))
    .filter(Boolean);
  const leadSponsor = decodeHtmlEntities(sponsorMod?.leadSponsor?.name || '');

  let authors = sanitizeAuthorsList(officialNames);
  if (authors.length === 0 && leadSponsor) {
    authors = sanitizeAuthorsList([leadSponsor]);
  }
  const journal = 'ClinicalTrials.gov Registry';
  const firstAuthor = resolveAuthorOrJournalFallback({ firstAuthor: '', authors, journal });
  const year = extractCtGovYear(statusMod);
  const registryUrl = `https://clinicaltrials.gov/study/${nctId}`;

  const briefSummary = decodeHtmlEntities(descMod.briefSummary || '');
  const detailedDescription = decodeHtmlEntities(descMod.detailedDescription || '');
  const abstract = [briefSummary, detailedDescription].filter(Boolean).join('\n\n').trim();

  const design = mapCtGovStudyDesign(designMod);
  const sampleSizeRaw = Number(designMod?.enrollmentInfo?.count);
  const sampleSize = Number.isFinite(sampleSizeRaw) && sampleSizeRaw > 0 ? Math.round(sampleSizeRaw) : 0;
  const population = extractCtGovPopulation(condMod, eligMod);
  const { intervention, comparator } = extractCtGovArms(armsMod);
  const primaryOutcome = extractCtGovPrimaryOutcome(outMod);
  const linkedPmids = extractCtGovLinkedPmids(refsMod);

  const pico: PicoData = {
    population,
    sampleSize,
    intervention,
    comparator,
    primaryOutcome,
    pValues: [],
    design
  };

  return {
    id: `nct-${nctId.toLowerCase()}`,
    title,
    authors: authors.slice(0, 8),
    firstAuthor,
    journal,
    year,
    doi: '',
    nctId,
    nctVerified: true,
    registryUrl,
    linkedPmids,
    mergedSources: ['ClinicalTrials.gov'],
    hasFullText: false,
    abstract,
    citationCount: linkedPmids.length * 10,
    isOpenAccess: true,
    source: 'ClinicalTrials.gov',
    webUrl: registryUrl,
    pico,
    ...(typeof score === 'number' ? { score } : {})
  };
}

/**
 * Queries ClinicalTrials.gov REST API v2 directly for clinical trials matching `query`.
 */
export async function searchClinicalTrials(query: string, maxResults = 15): Promise<MedicalDocument[]> {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return [];

  const cappedLimit = Math.min(50, Math.max(1, maxResults));
  const cacheKey = `ctgov:search:${cleanQuery.toLowerCase()}:${cappedLimit}`;

  try {
    const { value } = await apiCache.getOrFetch<MedicalDocument[]>(
      cacheKey,
      async () => {
        await waitForCtGovRateLimit();
        const url = `${CLINICAL_TRIALS_V2_BASE}?query.term=${encodeURIComponent(cleanQuery)}&pageSize=${cappedLimit}&format=json`;
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': `MedResearchAI/1.0 (mailto:${config.scholarlyEmail})`
          },
          signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) {
          console.warn(`[clinicalTrialsService] CT.gov search HTTP ${res.status}`);
          return [];
        }

        const data = (await res.json()) as { studies?: any[] };
        const studies = Array.isArray(data?.studies) ? data.studies : [];
        const docs: MedicalDocument[] = [];
        for (const s of studies) {
          const mapped = mapProtocolSectionToDocument(s?.protocolSection);
          if (mapped) docs.push(mapped);
        }
        return docs;
      },
      { shouldCache: (docs) => docs.length > 0 }
    );
    return value;
  } catch (err) {
    console.warn('[clinicalTrialsService] searchClinicalTrials notice:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetches a single trial protocolSection by NCT ID from ClinicalTrials.gov REST API v2.
 */
export async function fetchNctStudyById(nctId: string): Promise<MedicalDocument | null> {
  const cleanNct = String(nctId || '').trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(cleanNct)) return null;

  const cacheKey = `ctgov:study:${cleanNct}`;
  try {
    const { value } = await apiCache.getOrFetch<MedicalDocument | null>(
      cacheKey,
      async () => {
        await waitForCtGovRateLimit();
        const url = `${CLINICAL_TRIALS_V2_BASE}/${encodeURIComponent(cleanNct)}?format=json`;
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': `MedResearchAI/1.0 (mailto:${config.scholarlyEmail})`
          },
          signal: AbortSignal.timeout(7000)
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { protocolSection?: any };
        return mapProtocolSectionToDocument(data?.protocolSection);
      },
      { shouldCache: (doc) => doc !== null }
    );
    return value;
  } catch (err) {
    console.warn(`[clinicalTrialsService] fetchNctStudyById(${cleanNct}) notice:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function extractNctIdsFromDocument(doc: Pick<MedicalDocument, 'nctId' | 'title' | 'abstract' | 'doi' | 'webUrl'>): string[] {
  const haystack = [doc.nctId, doc.title, doc.abstract, doc.doi, doc.webUrl].filter(Boolean).join(' ');
  const matches = haystack.match(/\bNCT\d{8}\b/gi) || [];
  return Array.from(new Set(matches.map(m => m.toUpperCase())));
}

/**
 * Scans all retrieved studies across databases for `NCT\d{8}` identifiers,
 * queries ClinicalTrials.gov v2 for matching protocol records, and fills missing PICO fields.
 */
export async function enrichNctRecords(studies: MedicalDocument[], maxToEnrich = 15): Promise<MedicalDocument[]> {
  if (!studies || studies.length === 0) return studies;

  const docNctMap = new Map<number, string>();
  const uniqueNcts: string[] = [];
  const seenNcts = new Set<string>();

  studies.forEach((doc, idx) => {
    const found = extractNctIdsFromDocument(doc);
    if (found.length > 0) {
      docNctMap.set(idx, found[0]);
      if (!seenNcts.has(found[0])) {
        seenNcts.add(found[0]);
        uniqueNcts.push(found[0]);
      }
    }
  });

  if (uniqueNcts.length === 0) return studies;

  const nctDetails = new Map<string, MedicalDocument>();
  for (const nctId of uniqueNcts.slice(0, maxToEnrich)) {
    const detail = await fetchNctStudyById(nctId);
    if (detail) {
      nctDetails.set(nctId, detail);
    }
  }

  return studies.map((doc, idx) => {
    const matchedNct = doc.nctId?.toUpperCase() || docNctMap.get(idx);
    if (!matchedNct) return doc;

    const reg = nctDetails.get(matchedNct);
    const registryUrl = `https://clinicaltrials.gov/study/${matchedNct}`;
    if (!reg) {
      return {
        ...doc,
        nctId: matchedNct,
        registryUrl: doc.registryUrl || registryUrl
      };
    }

    const mergedLinkedPmids = Array.from(
      new Set([...(doc.linkedPmids || []), ...(reg.linkedPmids || [])].filter(Boolean))
    );
    const mergedSources = Array.from(
      new Set([...(doc.mergedSources || [doc.source]), 'ClinicalTrials.gov'])
    );

    const updatedPico: PicoData = {
      ...doc.pico,
      sampleSize: doc.pico?.sampleSize && doc.pico.sampleSize > 0 ? doc.pico.sampleSize : reg.pico.sampleSize,
      population: doc.pico?.population && doc.pico.population !== 'Not reported' ? doc.pico.population : reg.pico.population,
      intervention: doc.pico?.intervention && doc.pico.intervention !== 'Not reported' ? doc.pico.intervention : reg.pico.intervention,
      comparator: doc.pico?.comparator && doc.pico.comparator !== 'Not reported' ? doc.pico.comparator : reg.pico.comparator,
      primaryOutcome: doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported' ? doc.pico.primaryOutcome : reg.pico.primaryOutcome,
      design: doc.pico?.design === 'Observational / Descriptive Study' ? reg.pico.design : doc.pico.design
    };

    return {
      ...doc,
      nctId: matchedNct,
      nctVerified: true,
      registryUrl,
      linkedPmids: mergedLinkedPmids,
      mergedSources,
      abstract: doc.abstract && doc.abstract.length >= 40 ? doc.abstract : reg.abstract,
      pico: updatedPico
    };
  });
}

export const clinicalTrialsService = {
  searchClinicalTrials,
  fetchNctStudyById,
  enrichNctRecords,
  extractNctIdsFromDocument,
  mapProtocolSectionToDocument
};
