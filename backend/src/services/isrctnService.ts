import type { MedicalDocument, PicoData } from './searchService.js';
import {
  decodeHtmlEntities,
  sanitizeAuthorsList,
  resolveAuthorOrJournalFallback,
  sanitizeDoi,
  parseValidPublicationYear
} from './corpusContextBuilder.js';
import { apiCache } from '../utils/apiCache.js';
import { config } from '../config.js';

const ISRCTN_XML_API_URL = 'https://www.isrctn.com/api/query/format/default';
const ISRCTN_COOKIE_WALL_TEXT = 'Please enable cookies and JavaScript to use ISRCTN';

export interface ParsedIsrctnRecord {
  isrctnId: string;
  title: string;
  scientificTitle?: string;
  authors: string[];
  firstAuthor: string;
  journal: 'ISRCTN Clinical Trial Registry';
  year: number | null;
  doi: string;
  nctId?: string;
  studyDesign: PicoData['design'];
  abstract: string;
  sampleSize: number;
  population: string;
  intervention: string;
  comparator: string;
  primaryOutcome: string;
  linkedPmids: string[];
  linkedDois: string[];
  registryUrl: string;
}

let lastIsrctnRequestTime = 0;
async function waitForIsrctnRateLimit(): Promise<void> {
  const minIntervalMs = 200;
  const now = Date.now();
  const elapsed = now - lastIsrctnRequestTime;
  if (elapsed < minIntervalMs) {
    await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastIsrctnRequestTime = Date.now();
}

function stripXmlTags(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  return decodeHtmlEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstTagText(xml: string, tagName: string): string {
  const m = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return m ? stripXmlTags(m[1]) : '';
}

function extractAllTagTexts(xml: string, tagName: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi'));
  const out: string[] = [];
  for (const m of matches) {
    const cleaned = stripXmlTags(m[1]);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

export function mapIsrctnStudyDesign(primaryStudyDesign: string, studyDesign: string, combinedText = ''): PicoData['design'] {
  const hint = `${primaryStudyDesign} ${studyDesign} ${combinedText}`.toLowerCase();
  if (/\b(?:randomised|randomized|rct)\b/.test(hint)) {
    return 'Randomized Controlled Trial';
  }
  if (/\b(?:observational|cohort|case-control|cross-sectional|longitudinal)\b/.test(hint)) {
    return 'Cohort Study';
  }
  if (/\b(?:interventional|clinical\s+trial|non-randomised|non-randomized|phase\s*(?:i|ii|iii|iv|1|2|3|4)|adaptive\s+trial)\b/.test(hint)) {
    return 'Clinical Trial';
  }
  return 'Observational / Descriptive Study';
}

export function extractIsrctnIdFromDocument(
  doc: Pick<MedicalDocument, 'isrctnId' | 'doi' | 'title' | 'abstract' | 'webUrl'>
): string | undefined {
  if (doc.isrctnId && /^ISRCTN\d{6,10}$/i.test(doc.isrctnId.trim())) {
    return doc.isrctnId.trim().toUpperCase();
  }
  const doiMatch = String(doc.doi || '').match(/10\.1186\/(isrctn\d+)/i);
  if (doiMatch?.[1]) {
    return doiMatch[1].toUpperCase();
  }
  const text = [doc.title, doc.abstract, doc.webUrl].filter(Boolean).join(' ');
  const idMatch = text.match(/\b(ISRCTN\d{6,10})\b/i);
  return idMatch?.[1] ? idMatch[1].toUpperCase() : undefined;
}

/**
 * Parses an official ISRCTN XML `<trial>` / `<allTrials>` response into structured metadata.
 * Discards cookie/JS wall HTML payloads cleanly.
 */
export function parseIsrctnXmlResponse(xmlPayload: string, expectedIsrctnId?: string): ParsedIsrctnRecord | null {
  if (!xmlPayload || typeof xmlPayload !== 'string') return null;
  if (xmlPayload.includes(ISRCTN_COOKIE_WALL_TEXT) || !/<(?:allTrials|fullTrial|trial)\b/i.test(xmlPayload)) {
    return null;
  }

  const trialBlockMatch = xmlPayload.match(/<trial\b[^>]*>[\s\S]*?<\/trial>/i);
  const trialXml = trialBlockMatch ? trialBlockMatch[0] : xmlPayload;

  const canonicalAttrMatch = trialXml.match(/publicIdentifierCanonical\s*=\s*["'](ISRCTN\d+)["']/i);
  const isrctnTag = extractFirstTagText(trialXml, 'isrctn');
  const resolvedId =
    (canonicalAttrMatch?.[1] || (isrctnTag ? `ISRCTN${isrctnTag.replace(/^ISRCTN/i, '')}` : '') || expectedIsrctnId || '')
      .toUpperCase();

  if (!/^ISRCTN\d{6,10}$/.test(resolvedId)) return null;

  const title = extractFirstTagText(trialXml, 'title');
  const scientificTitle = extractFirstTagText(trialXml, 'scientificTitle');
  const plainEnglishSummary = extractFirstTagText(trialXml, 'plainEnglishSummary');
  const primaryOutcome = extractFirstTagText(trialXml, 'primaryOutcome');
  const primaryStudyDesign = extractFirstTagText(trialXml, 'primaryStudyDesign');
  const studyDesignRaw = extractFirstTagText(trialXml, 'studyDesign');

  const conditionsBlock = extractFirstTagText(trialXml, 'conditions');
  const condition = conditionsBlock || extractAllTagTexts(trialXml, 'condition').join('; ');

  const interventionsBlock = extractFirstTagText(trialXml, 'interventions');
  const interventionText = interventionsBlock || extractAllTagTexts(trialXml, 'intervention').join('; ');

  const inclusion = extractFirstTagText(trialXml, 'inclusion');
  const studyDesign = mapIsrctnStudyDesign(primaryStudyDesign, studyDesignRaw, `${title} ${scientificTitle}`);

  // Sample size: <totalFinalEnrolment> or <targetEnrolment> or <targetNumberOfParticipants>
  const finalEnrolStr = extractFirstTagText(trialXml, 'totalFinalEnrolment');
  const targetEnrolStr =
    extractFirstTagText(trialXml, 'targetNumberOfParticipants') ||
    extractFirstTagText(trialXml, 'targetEnrolment');
  const parsedFinal = parseInt(finalEnrolStr.replace(/[^\d]/g, ''), 10);
  const parsedTarget = parseInt(targetEnrolStr.replace(/[^\d]/g, ''), 10);
  const sampleSize =
    Number.isFinite(parsedFinal) && parsedFinal > 0
      ? parsedFinal
      : Number.isFinite(parsedTarget) && parsedTarget > 0
      ? parsedTarget
      : 0;

  // Publication Year (never default to current year if missing)
  const dateCandidates = [
    extractFirstTagText(trialXml, 'overallEndDate'),
    extractFirstTagText(trialXml, 'recruitmentStart'),
    trialXml.match(/lastUpdated\s*=\s*["'](\d{4})/i)?.[1] || ''
  ];
  let year: number | null = null;
  for (const dc of dateCandidates) {
    const parsed = parseValidPublicationYear(dc);
    if (parsed !== null) {
      year = parsed;
      break;
    }
  }

  // Contacts & Sponsors -> Authors (never placeholder "Investigator")
  const rawContacts: string[] = [];
  const contactMatches = trialXml.matchAll(/<contact\b[^>]*>([\s\S]*?)<\/contact>/gi);
  for (const cm of contactMatches) {
    const fore = extractFirstTagText(cm[1], 'forename');
    const sur = extractFirstTagText(cm[1], 'surname');
    const full = `${sur} ${fore?.charAt(0) || ''}`.trim();
    if (full) rawContacts.push(full);
  }
  const sponsorOrg = extractFirstTagText(trialXml, 'organisation');
  let authors = sanitizeAuthorsList(rawContacts);
  if (authors.length === 0 && sponsorOrg) {
    authors = sanitizeAuthorsList([sponsorOrg]);
  }
  const journal = 'ISRCTN Clinical Trial Registry';
  const firstAuthor = resolveAuthorOrJournalFallback({ firstAuthor: '', authors, journal });

  // External Refs, DOIs & Linked Publications (PMIDs / DOIs)
  const ownDoi = sanitizeDoi(extractFirstTagText(trialXml, 'doi')) || `10.1186/${resolvedId}`;
  const rawNct = extractFirstTagText(trialXml, 'clinicalTrialsGovNumber').toUpperCase();
  const nctId = /^NCT\d{8}$/.test(rawNct) ? rawNct : undefined;

  const pubArea = [
    ...extractAllTagTexts(trialXml, 'publicationDetails'),
    ...extractAllTagTexts(trialXml, 'outputs'),
    ...extractAllTagTexts(trialXml, 'results'),
    ...extractAllTagTexts(trialXml, 'publication'),
    ...extractAllTagTexts(trialXml, 'externalLink')
  ].join(' ');

  const linkedPmids = new Set<string>();
  for (const m of pubArea.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{6,10})/gi)) {
    linkedPmids.add(m[1]);
  }
  for (const m of pubArea.matchAll(/\bPMID\s*[:#]?\s*(\d{6,10})/gi)) {
    linkedPmids.add(m[1]);
  }
  for (const pmidTag of extractAllTagTexts(trialXml, 'pmid')) {
    if (/^\d{6,10}$/.test(pmidTag)) linkedPmids.add(pmidTag);
  }

  const linkedDois = new Set<string>();
  for (const m of pubArea.matchAll(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/gi)) {
    const clean = sanitizeDoi(m[1]);
    if (clean && clean.toLowerCase() !== ownDoi.toLowerCase()) {
      linkedDois.add(clean);
    }
  }

  const abstractParts = [
    scientificTitle && scientificTitle !== title ? `Scientific Title: ${scientificTitle}` : '',
    plainEnglishSummary,
    condition ? `Condition: ${condition}` : '',
    interventionText ? `Intervention: ${interventionText}` : '',
    primaryOutcome ? `Primary Outcome: ${primaryOutcome}` : ''
  ].filter(Boolean);

  const populationSummary = [condition, inclusion ? inclusion.slice(0, 140) : ''].filter(Boolean).join(' — ');

  return {
    isrctnId: resolvedId,
    title: scientificTitle || title || `ISRCTN Trial ${resolvedId}`,
    scientificTitle: scientificTitle || undefined,
    authors: authors.slice(0, 8),
    firstAuthor,
    journal,
    year,
    doi: ownDoi,
    nctId,
    studyDesign,
    abstract: abstractParts.join('\n\n').trim(),
    sampleSize,
    population: populationSummary && populationSummary.split(/\s+/).length >= 3 ? populationSummary.slice(0, 240) : 'Not reported',
    intervention: interventionText && interventionText.split(/\s+/).length >= 3 ? interventionText.slice(0, 240) : 'Not reported',
    comparator: /\b(?:placebo|standard\s+care|usual\s+care|control\s+group)\b/i.test(interventionText)
      ? 'Placebo or standard-of-care control group (see intervention arms)'
      : 'Not reported',
    primaryOutcome: primaryOutcome && primaryOutcome.split(/\s+/).length >= 3 ? primaryOutcome.slice(0, 240) : 'Not reported',
    linkedPmids: Array.from(linkedPmids),
    linkedDois: Array.from(linkedDois),
    registryUrl: `https://www.isrctn.com/${resolvedId}`
  };
}

/**
 * Queries the official ISRCTN XML API for a single `ISRCTN...` identifier (with 24h TTL cache).
 */
export async function fetchIsrctnRecord(isrctnId: string): Promise<ParsedIsrctnRecord | null> {
  const cleanId = String(isrctnId || '').trim().toUpperCase();
  if (!/^ISRCTN\d{6,10}$/.test(cleanId)) return null;

  const cacheKey = `isrctn:xml:${cleanId}`;
  try {
    const { value } = await apiCache.getOrFetch<ParsedIsrctnRecord | null>(
      cacheKey,
      async () => {
        await waitForIsrctnRateLimit();
        const url = `${ISRCTN_XML_API_URL}?q=${encodeURIComponent(cleanId)}`;
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/xml,text/xml',
            'User-Agent': `MedResearchAI/1.0 (mailto:${config.scholarlyEmail})`
          },
          signal: AbortSignal.timeout(9000)
        });
        if (!res.ok) return null;
        const xmlText = await res.text();
        return parseIsrctnXmlResponse(xmlText, cleanId);
      },
      { shouldCache: (rec) => rec !== null }
    );
    return value;
  } catch (err) {
    console.warn(`[isrctnService] fetchIsrctnRecord(${cleanId}) notice:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolves ISRCTN XML records for any study whose DOI matches `10.1186/isrctn\d+`
 * or whose title/abstract contains `ISRCTN\d+`, cleaning raw ISRCTN URLs, discarding
 * cookie-wall HTML, and enriching PICO/linked publication identifiers.
 */
export async function enrichIsrctnRecords(studies: MedicalDocument[], maxToEnrich = 15): Promise<MedicalDocument[]> {
  if (!studies || studies.length === 0) return studies;

  const docIsrctnMap = new Map<number, string>();
  const uniqueIds: string[] = [];
  const seen = new Set<string>();

  studies.forEach((doc, idx) => {
    const id = extractIsrctnIdFromDocument(doc);
    if (id) {
      docIsrctnMap.set(idx, id);
      if (!seen.has(id)) {
        seen.add(id);
        uniqueIds.push(id);
      }
    }
  });

  if (uniqueIds.length === 0) {
    // Still sanitize any stray ISRCTN cookie-wall abstracts/raw journals defensively
    return studies.map((doc) => {
      const hasCookieWall = (doc.abstract || '').includes(ISRCTN_COOKIE_WALL_TEXT);
      const hasRawIsrctnUrl = /https?:\/\/(?:www\.)?isrctn\.org/i.test(doc.journal || '');
      if (!hasCookieWall && !hasRawIsrctnUrl) return doc;
      return {
        ...doc,
        journal: hasRawIsrctnUrl ? 'ISRCTN Clinical Trial Registry' : doc.journal,
        abstract: hasCookieWall ? '' : doc.abstract
      };
    });
  }

  const resolvedMap = new Map<string, ParsedIsrctnRecord>();
  for (const id of uniqueIds.slice(0, maxToEnrich)) {
    const parsed = await fetchIsrctnRecord(id);
    if (parsed) {
      resolvedMap.set(id, parsed);
    }
  }

  return studies.map((doc, idx) => {
    const hasCookieWall = (doc.abstract || '').includes(ISRCTN_COOKIE_WALL_TEXT);
    const hasRawIsrctnUrl = /https?:\/\/(?:www\.)?isrctn\.org/i.test(doc.journal || '');
    const matchedId = doc.isrctnId?.toUpperCase() || docIsrctnMap.get(idx);

    if (!matchedId) {
      return hasCookieWall || hasRawIsrctnUrl
        ? {
            ...doc,
            journal: hasRawIsrctnUrl ? 'ISRCTN Clinical Trial Registry' : doc.journal,
            abstract: hasCookieWall ? '' : doc.abstract
          }
        : doc;
    }

    const reg = resolvedMap.get(matchedId);
    const cleanJournal =
      hasRawIsrctnUrl || /isrctn/i.test(doc.journal || '')
        ? 'ISRCTN Clinical Trial Registry'
        : doc.journal;

    if (!reg) {
      return {
        ...doc,
        isrctnId: matchedId,
        journal: cleanJournal,
        registryUrl: doc.registryUrl || `https://www.isrctn.com/${matchedId}`,
        abstract: hasCookieWall ? '' : doc.abstract
      };
    }

    const mergedLinkedPmids = Array.from(new Set([...(doc.linkedPmids || []), ...reg.linkedPmids]));
    const mergedLinkedDois = Array.from(new Set([...(doc.linkedDois || []), ...reg.linkedDois]));
    const mergedSources = Array.from(new Set([...(doc.mergedSources || [doc.source]), 'ISRCTN']));

    const cleanExistingAbstract = hasCookieWall ? '' : (doc.abstract || '');
    const finalAbstract = cleanExistingAbstract.length >= 80 ? cleanExistingAbstract : reg.abstract;

    const updatedPico: PicoData = {
      ...doc.pico,
      sampleSize: doc.pico?.sampleSize && doc.pico.sampleSize > 0 ? doc.pico.sampleSize : reg.sampleSize,
      population: doc.pico?.population && doc.pico.population !== 'Not reported' ? doc.pico.population : reg.population,
      intervention: doc.pico?.intervention && doc.pico.intervention !== 'Not reported' ? doc.pico.intervention : reg.intervention,
      comparator: doc.pico?.comparator && doc.pico.comparator !== 'Not reported' ? doc.pico.comparator : reg.comparator,
      primaryOutcome: doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported' ? doc.pico.primaryOutcome : reg.primaryOutcome,
      design: doc.pico?.design === 'Observational / Descriptive Study' ? reg.studyDesign : doc.pico.design
    };

    return {
      ...doc,
      year: doc.year ?? reg.year ?? null,
      isrctnId: matchedId,
      isrctnVerified: true,
      nctId: doc.nctId || reg.nctId,
      journal: cleanJournal,
      registryUrl: reg.registryUrl,
      linkedPmids: mergedLinkedPmids,
      linkedDois: mergedLinkedDois,
      mergedSources,
      abstract: finalAbstract,
      pico: updatedPico
    };
  });
}

export const isrctnService = {
  extractIsrctnIdFromDocument,
  parseIsrctnXmlResponse,
  fetchIsrctnRecord,
  enrichIsrctnRecords
};
