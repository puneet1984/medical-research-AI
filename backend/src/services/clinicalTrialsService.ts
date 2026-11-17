import type { MedicalDocument, PicoData } from './searchService.js';
import {
  decodeHtmlEntities,
  sanitizeAuthorsList,
  resolveAuthorOrJournalFallback,
  parseValidPublicationYear
} from './corpusContextBuilder.js';
import { apiCache } from '../utils/apiCache.js';
import { config } from '../config.js';

import { generateLocalEmbedding, cosineSimilarity } from './embeddingService.js';

const CLINICAL_TRIALS_V2_BASE = 'https://clinicaltrials.gov/api/v2/studies';

export interface CtGovSearchOptions {
  query: string;
  conditionTerms?: string[];
  interventionTerms?: string[];
  metaMapResult?: any;
}

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

function cleanField(raw?: string | null, maxLen = 260, allowSingleToken = false): string {
  if (!raw || typeof raw !== 'string') return 'Not reported';
  const cleaned = decodeHtmlEntities(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Not reported';
  if (/^(?:n\/?a|none|nil|null|unknown|not\s+reported|-+)$/i.test(cleaned)) {
    return 'Not reported';
  }
  if (!allowSingleToken && cleaned.split(/\s+/).length < 2) {
    return 'Not reported';
  }
  if (allowSingleToken && cleaned.length < 2) {
    return 'Not reported';
  }
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

/**
 * Prefers actual study first-posted date or start date (capped at currentYear)
 * instead of future estimated primaryCompletionDateStruct (e.g., 2030+).
 */
function extractCtGovYear(statusModule: any): number | null {
  const candidates = [
    statusModule?.studyFirstPostDateStruct?.date,
    statusModule?.startDateStruct?.date,
    statusModule?.studyFirstSubmitDate,
    statusModule?.primaryCompletionDateStruct?.date,
    statusModule?.completionDateStruct?.date,
    statusModule?.lastUpdatePostDateStruct?.date
  ];
  for (const raw of candidates) {
    const parsed = parseValidPublicationYear(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractCtGovArms(armsModule: any): { intervention: string; comparator: string } {
  const armGroups: any[] = Array.isArray(armsModule?.armGroups) ? armsModule.armGroups : [];
  const interventionsList: any[] = Array.isArray(armsModule?.interventions) ? armsModule.interventions : [];

  const experimentalArmLabels = new Set<string>();
  const experimentalArms: string[] = [];
  const comparatorArms: string[] = [];

  const formatArmSummary = (arm: any): string => {
    const label = decodeHtmlEntities(arm?.label || '').trim();
    const desc = decodeHtmlEntities(arm?.description || '').trim();
    if (!label && !desc) return '';
    if (!desc) return label;
    if (!label) return desc.slice(0, 150);
    const trimmedDesc = desc.length > 140 ? `${desc.slice(0, 137).trimEnd()}...` : desc;
    return `${label}: ${trimmedDesc}`;
  };

  // Detect 2-arm trial where one arm is NO_INTERVENTION / PLACEBO_COMPARATOR / SHAM_COMPARATOR
  const passiveTypes = new Set(['NO_INTERVENTION', 'PLACEBO_COMPARATOR', 'SHAM_COMPARATOR']);
  let twoArmActiveIndex = -1;
  if (armGroups.length === 2) {
    const type0 = String(armGroups[0]?.type || '').toUpperCase();
    const type1 = String(armGroups[1]?.type || '').toUpperCase();
    if (passiveTypes.has(type0) && !passiveTypes.has(type1)) {
      twoArmActiveIndex = 1;
    } else if (passiveTypes.has(type1) && !passiveTypes.has(type0)) {
      twoArmActiveIndex = 0;
    }
  }

  armGroups.forEach((arm, idx) => {
    const label = decodeHtmlEntities(arm?.label || '').trim();
    const desc = decodeHtmlEntities(arm?.description || '').trim();
    const type = String(arm?.type || '').toUpperCase();
    const summary = formatArmSummary(arm);
    if (!summary) return;

    if (type === 'EXPERIMENTAL' || idx === twoArmActiveIndex) {
      experimentalArms.push(summary);
      if (label) experimentalArmLabels.add(label.toLowerCase());
      return;
    }

    if (
      passiveTypes.has(type) ||
      type === 'ACTIVE_COMPARATOR' ||
      /\b(placebo|control|standard\s+of\s+care|usual\s+care|sham|comparator|non-treatment)\b/i.test(`${label} ${desc}`)
    ) {
      comparatorArms.push(summary);
    } else {
      experimentalArms.push(summary);
      if (label) experimentalArmLabels.add(label.toLowerCase());
    }
  });

  // Always append matching active drug/procedure/device details from interventions[]
  const matchedInterventionEntries: string[] = [];
  const comparatorInterventionEntries: string[] = [];
  const existingExpLower = experimentalArms.join(' ').toLowerCase();

  for (const iv of interventionsList) {
    const name = decodeHtmlEntities(iv?.name || '').trim();
    const desc = decodeHtmlEntities(iv?.description || '').trim();
    const ivType = decodeHtmlEntities(iv?.type || '').trim();
    if (!name && !desc) continue;

    const labels: string[] = Array.isArray(iv?.armGroupLabels)
      ? iv.armGroupLabels.map((l: any) => decodeHtmlEntities(String(l || '')).trim().toLowerCase())
      : [];

    const isPlaceboOrSham =
      /\b(?:placebo|sham|no\s+intervention)\b/i.test(name) &&
      !labels.some(l => experimentalArmLabels.has(l));

    const entryCore = name && desc && !desc.toLowerCase().includes(name.toLowerCase())
      ? `${name} (${desc.length > 100 ? `${desc.slice(0, 97).trimEnd()}...` : desc})`
      : name || desc;
    const entry = ivType && !entryCore.toLowerCase().includes(ivType.toLowerCase())
      ? `${ivType}: ${entryCore}`
      : entryCore;

    if (isPlaceboOrSham) {
      comparatorInterventionEntries.push(entry);
      continue;
    }

    const matchesExpLabel =
      labels.length === 0 ||
      experimentalArmLabels.size === 0 ||
      labels.some(l => experimentalArmLabels.has(l));

    if (matchesExpLabel) {
      const nameLower = (name || '').toLowerCase();
      if (!nameLower || !existingExpLower.includes(nameLower)) {
        matchedInterventionEntries.push(entry);
      } else if (desc && !existingExpLower.includes(desc.slice(0, 28).toLowerCase())) {
        matchedInterventionEntries.push(entry);
      }
    }
  }

  const combinedExperimental = Array.from(
    new Set([...experimentalArms, ...matchedInterventionEntries])
  );
  const combinedComparators = Array.from(
    new Set([...comparatorArms, ...comparatorInterventionEntries])
  );

  return {
    intervention: cleanField(combinedExperimental.slice(0, 3).join('; '), 260, true),
    comparator: cleanField(combinedComparators.slice(0, 3).join('; '), 240, true)
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
  const resultRefs: string[] = [];
  const otherRefs: string[] = [];
  const seen = new Set<string>();

  for (const r of refs) {
    const raw = String(r?.pmid || '').trim();
    if (!/^\d+$/.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    const refType = String(r?.type || '').toUpperCase();
    if (refType === 'RESULT') {
      resultRefs.push(raw);
    } else {
      otherRefs.push(raw);
    }
  }
  return [...resultRefs, ...otherRefs];
}

function normalizeCtGovPValue(rawP?: unknown): string | null {
  if (rawP === null || rawP === undefined) return null;
  const trimmed = decodeHtmlEntities(String(rawP)).replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (/^p\s*[<>=]/i.test(trimmed)) {
    return trimmed.replace(/^P/, 'p').replace(/\s*([<>]=?|=)\s*/, ' $1 ');
  }
  const opMatch = trimmed.match(/^([<>]=?|=)\s*(0?\.\d+|1(?:\.0+)?|\.\d+)$/);
  if (opMatch) {
    return `p ${opMatch[1]} ${opMatch[2]}`;
  }
  if (/^(?:0?\.\d+|\.\d+)$/.test(trimmed)) {
    return `p = ${trimmed.startsWith('.') ? `0${trimmed}` : trimmed}`;
  }
  return null;
}

function abbreviateParamType(rawType?: unknown): string {
  const str = decodeHtmlEntities(String(rawType || '')).trim();
  if (!str) return 'Effect';
  const abbrMatch = str.match(/\(([A-Z]{2,5})\)/);
  if (abbrMatch?.[1]) return abbrMatch[1];
  const lower = str.toLowerCase();
  if (lower.includes('hazard ratio')) return 'HR';
  if (lower.includes('odds ratio')) return 'OR';
  if (lower.includes('risk ratio') || lower.includes('relative risk')) return 'RR';
  if (lower.includes('risk difference')) return 'RD';
  if (lower.includes('mean difference')) return 'MD';
  return str;
}

export interface CtGovExtractedStats {
  pValues: string[];
  effectMetricType?: 'HR' | 'OR' | 'RR' | 'MD' | null;
  effectEstimate?: string;
  hazardRatio?: string;
  riskRatio?: string;
  primaryStatistic?: string;
  summaryText?: string;
}

export function extractCtGovResults(resultsSection: any): CtGovExtractedStats {
  const measures: any[] = Array.isArray(resultsSection?.outcomeMeasuresModule?.outcomeMeasures)
    ? resultsSection.outcomeMeasuresModule.outcomeMeasures
    : [];

  if (measures.length === 0) {
    return { pValues: [] };
  }

  const primaryMeasures = measures.filter(
    (m) => String(m?.type || '').toUpperCase() === 'PRIMARY' && Array.isArray(m?.analyses) && m.analyses.length > 0
  );
  const candidateMeasures =
    primaryMeasures.length > 0
      ? primaryMeasures
      : measures.filter((m) => Array.isArray(m?.analyses) && m.analyses.length > 0);

  const pValues: string[] = [];
  const seenP = new Set<string>();
  let effectMetricType: 'HR' | 'OR' | 'RR' | 'MD' | null = null;
  let effectEstimate: string | undefined;
  let hazardRatio: string | undefined;
  let riskRatio: string | undefined;
  let primaryStatistic: string | undefined;
  const summarySnippets: string[] = [];

  for (const measure of candidateMeasures.slice(0, 3)) {
    const unitRaw = decodeHtmlEntities(String(measure?.unitOfMeasure || '')).toLowerCase();
    const isPercentUnit = unitRaw.includes('percent') || unitRaw.includes('%');
    const analyses: any[] = Array.isArray(measure?.analyses) ? measure.analyses : [];

    for (const analysis of analyses.slice(0, 3)) {
      const pNorm = normalizeCtGovPValue(analysis?.pValue);
      if (pNorm && !seenP.has(pNorm)) {
        seenP.add(pNorm);
        pValues.push(pNorm);
      }

      const paramValue = analysis?.paramValue !== undefined && analysis?.paramValue !== null
        ? String(analysis.paramValue).trim()
        : '';
      const paramTypeRaw = String(analysis?.paramType || '').trim();
      const paramAbbr = abbreviateParamType(paramTypeRaw);
      const ciPct = analysis?.ciPctValue ? String(analysis.ciPctValue).replace(/%/g, '').trim() : '95';
      const ciLower = analysis?.ciLowerLimit !== undefined && analysis?.ciLowerLimit !== null
        ? String(analysis.ciLowerLimit).trim()
        : '';
      const ciUpper = analysis?.ciUpperLimit !== undefined && analysis?.ciUpperLimit !== null
        ? String(analysis.ciUpperLimit).trim()
        : '';

      if (paramValue) {
        const valWithUnit =
          isPercentUnit && !paramValue.includes('%') && !/ratio/i.test(paramTypeRaw)
            ? `${paramValue}%`
            : paramValue;
        const ciPart = ciLower && ciUpper ? ` (${ciPct}% CI: ${ciLower} to ${ciUpper})` : '';
        const statLabel = `${paramAbbr} ${valWithUnit}${ciPart}`.trim();

        const lowerType = paramTypeRaw.toLowerCase();
        const estimateValue = `${valWithUnit}${ciPart}`.trim();
        if (lowerType.includes('hazard') || paramAbbr === 'HR') {
          if (!hazardRatio) hazardRatio = estimateValue;
          if (!effectMetricType) {
            effectMetricType = 'HR';
            effectEstimate = estimateValue;
          }
        } else if (lowerType.includes('risk ratio') || lowerType.includes('relative risk') || paramAbbr === 'RR') {
          if (!riskRatio) riskRatio = estimateValue;
          if (!effectMetricType) {
            effectMetricType = 'RR';
            effectEstimate = estimateValue;
          }
        } else if (lowerType.includes('odds ratio') || paramAbbr === 'OR') {
          if (!effectMetricType) {
            effectMetricType = 'OR';
            effectEstimate = estimateValue;
          }
        } else if (lowerType.includes('mean difference') || paramAbbr === 'MD' || paramAbbr === 'WMD' || paramAbbr === 'SMD') {
          if (!effectMetricType) {
            effectMetricType = 'MD';
            effectEstimate = estimateValue;
          }
        }

        if (!primaryStatistic) {
          primaryStatistic = pNorm ? `${statLabel}; ${pNorm}` : statLabel;
        }
        summarySnippets.push(`${decodeHtmlEntities(measure?.title || 'Primary Outcome')}: ${statLabel}${pNorm ? ` (${pNorm})` : ''}`);
      } else if (pNorm) {
        if (!primaryStatistic) {
          primaryStatistic = pNorm;
        }
        summarySnippets.push(`${decodeHtmlEntities(measure?.title || 'Primary Outcome')}: ${pNorm}`);
      }
    }
  }

  return {
    pValues: pValues.slice(0, 6),
    effectMetricType,
    effectEstimate,
    hazardRatio,
    riskRatio,
    primaryStatistic,
    summaryText: summarySnippets.length > 0 ? summarySnippets.slice(0, 2).join('; ') : undefined
  };
}

export function mapProtocolSectionToDocument(
  protocolSection: any,
  score?: number,
  resultsSection?: any,
  hasResults?: boolean
): MedicalDocument | null {
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
  const extractedStats =
    hasResults === true || resultsSection?.outcomeMeasuresModule
      ? extractCtGovResults(resultsSection)
      : { pValues: [] };

  const abstractParts = [briefSummary, detailedDescription];
  if (extractedStats.summaryText) {
    abstractParts.push(`Reported Registry Results: ${extractedStats.summaryText}`);
  }
  const abstract = abstractParts.filter(Boolean).join('\n\n').trim();

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
    pValues: extractedStats.pValues,
    effectMetricType: extractedStats.effectMetricType ?? null,
    effectEstimate: extractedStats.effectEstimate,
    hazardRatio: extractedStats.hazardRatio,
    riskRatio: extractedStats.riskRatio,
    primaryStatistic: extractedStats.primaryStatistic,
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

const GENERIC_NON_INTERVENTION_TERMS = new Set([
  'placebo', 'control', 'sham', 'standard of care', 'usual care', 'no intervention',
  'vs', 'versus', 'and', 'or', 'the', 'in', 'for', 'of', 'with', 'trial', 'study', 'patients'
]);

const CONDITION_SEMANTIC_TYPES = new Set(['dsyn', 'inpo', 'sosy', 'neop', 'fndg']);
const INTERVENTION_SEMANTIC_TYPES = new Set(['phsu', 'orch', 'medd', 'topp', 'bacs']);

function normalizeRouteAbbreviations(phrase: string): string {
  return phrase
    .replace(/\biv\b(?=\s+[a-z])/gi, 'intravenous')
    .replace(/\bpo\b(?=\s+[a-z])/gi, 'oral')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanConceptCandidate(raw: string): string {
  return raw
    .replace(/\[(?:MeSH Terms|MeSH|tiab|tw|pt|All Fields)\]/gi, ' ')
    .replace(/[()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripParentheticalSummary(preferredName: string): string {
  const m = preferredName.match(/^([^()]{2,80}?)\s*\(/);
  return (m ? m[1] : preferredName).trim();
}

const GENERIC_SHARED_HEAD_NOUNS = new Set([
  'therapy', 'therapies', 'treatment', 'treatments', 'group', 'groups', 'arm', 'arms',
  'control', 'placebo', 'regimen', 'regimens', 'care', 'management', 'intervention',
  'interventions', 'study', 'trial', 'inhibitor', 'inhibitors', 'blocker', 'blockers',
  'agonist', 'agonists', 'antagonist', 'antagonists', 'agent', 'agents', 'drug', 'drugs',
  'procedure', 'procedures', 'surgery', 'device', 'devices', 'approach', 'protocol'
]);

const RELATIONAL_CONNECTOR_WORDS = new Set([
  'related', 'associated', 'induced', 'mediated', 'dependent', 'caused', 'derived'
]);

function stripConditionClauseFromArm(phrase: string): string {
  const m = phrase.match(/^(.+?)\s+(?:in|for|among|treating)\s+.+$/i);
  return (m ? m[1] : phrase).trim();
}

function expandComparativeArmNounSharing(arms: string[]): string[] {
  const cleanedArms = arms
    .map(a => stripConditionClauseFromArm(a.replace(/\s+/g, ' ').trim()))
    .filter(a => a.length > 0 && !GENERIC_NON_INTERVENTION_TERMS.has(a.toLowerCase()));
  if (cleanedArms.length === 0) return [];
  if (cleanedArms.length === 1) {
    const single = cleanedArms[0];
    const norm = normalizeRouteAbbreviations(single);
    return norm.toLowerCase() !== single.toLowerCase() ? [single, norm] : [single];
  }

  const lastWords = cleanedArms[cleanedArms.length - 1].split(/\s+/);
  const sharedHead = lastWords.length >= 2 ? lastWords[lastWords.length - 1] : '';

  const expanded: string[] = [];
  let headCount = 0;
  for (const arm of cleanedArms) {
    const words = arm.split(/\s+/);
    if (words.length === 1 && sharedHead && !arm.toLowerCase().includes(sharedHead.toLowerCase())) {
      const combined = `${arm} ${sharedHead}`;
      expanded.push(combined);
      const routeNorm = normalizeRouteAbbreviations(combined);
      if (routeNorm.toLowerCase() !== combined.toLowerCase()) expanded.push(routeNorm);
      headCount++;
    } else {
      expanded.push(arm);
      const routeNorm = normalizeRouteAbbreviations(arm);
      if (routeNorm.toLowerCase() !== arm.toLowerCase()) expanded.push(routeNorm);
      if (sharedHead && arm.toLowerCase().endsWith(sharedHead.toLowerCase())) {
        headCount++;
      }
    }
  }

  // If multiple comparative arms share a specific clinical head noun (e.g. "antibiotics", "aspirin", "corticosteroids"),
  // also include the shared head noun for CT.gov query.intr matching (since registries often index drug class alone)
  if (
    headCount >= 2 &&
    sharedHead.length >= 5 &&
    !GENERIC_SHARED_HEAD_NOUNS.has(sharedHead.toLowerCase()) &&
    !GENERIC_NON_INTERVENTION_TERMS.has(sharedHead.toLowerCase())
  ) {
    expanded.push(sharedHead);
  }

  return Array.from(new Set(expanded));
}

function formatCtGovClause(terms: string[], expandHyphenatedAnd = false): string {
  const cleanTerms = Array.from(
    new Set(
      terms
        .map(t => cleanConceptCandidate(t))
        .filter(t => t.length >= 2 && !GENERIC_NON_INTERVENTION_TERMS.has(t.toLowerCase()))
    )
  ).slice(0, 5);

  if (cleanTerms.length === 0) return '';
  const parts: string[] = [];
  const seen = new Set<string>();
  const addPart = (p: string) => {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      parts.push(p);
    }
  };

  for (const t of cleanTerms) {
    addPart(/[\s-]/.test(t) ? `"${t}"` : t);
    if (expandHyphenatedAnd && t.includes('-')) {
      const noHyphen = t.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
      if (noHyphen && noHyphen.toLowerCase() !== t.toLowerCase()) {
        addPart(`"${noHyphen}"`);
      }
      const coreWords = noHyphen
        .split(/\s+/)
        .filter(w => w.length >= 3 && !RELATIONAL_CONNECTOR_WORDS.has(w.toLowerCase()) && !GENERIC_NON_INTERVENTION_TERMS.has(w.toLowerCase()));
      if (coreWords.length >= 2) {
        addPart(`(${coreWords.join(' AND ')})`);
      }
    }
  }

  return parts.join(' OR ');
}

/**
 * Splits ANY clinical query into structured condition vs. intervention concept arrays
 * using syntactic decomposition + optional MetaMapLite semantic classifications,
 * producing ClinicalTrials.gov v2 `query.cond` and `query.intr` parameters.
 */
export function splitClinicalQueryForCtGov(
  query: string,
  metaMapResult?: any,
  explicitConditionTerms?: string[],
  explicitInterventionTerms?: string[]
): {
  condTerms: string[];
  intrTerms: string[];
  condQuery: string;
  intrQuery: string;
} {
  const cleanQuery = (query || '').trim();
  const condTerms: string[] = [...(explicitConditionTerms || [])];
  const intrTerms: string[] = [...(explicitInterventionTerms || [])];

  // 1. Syntactic decomposition: "<intervention(s)> in/for/among/treating <condition>"
  const prepMatch = cleanQuery.match(/^(.+?)\s+(?:in|for|among|treating)\s+(.+)$/i);
  if (prepMatch) {
    const leftSide = prepMatch[1].trim();
    const rightSide = prepMatch[2].trim().replace(/^(?:patients\s+with|adults\s+with|children\s+with)\s+/i, '');

    if (rightSide.length >= 2) {
      condTerms.push(rightSide);
    }

    const arms = leftSide.split(/\s+(?:vs\.?|versus|compared\s+with)\s+/i).map(a => a.trim()).filter(Boolean);
    if (arms.length >= 2) {
      for (const arm of expandComparativeArmNounSharing(arms)) {
        if (!GENERIC_NON_INTERVENTION_TERMS.has(arm.toLowerCase())) {
          intrTerms.push(arm);
        }
      }
    } else if (leftSide.length >= 2) {
      const normalizedLeft = normalizeRouteAbbreviations(leftSide);
      intrTerms.push(leftSide);
      if (normalizedLeft.toLowerCase() !== leftSide.toLowerCase()) intrTerms.push(normalizedLeft);
    }
  } else {
    // Check "In <cond>, <arm1> vs <arm2>" or "<cond>: <arm1> vs <arm2>"
    const leadCondMatch = cleanQuery.match(
      /^(?:in\s+)?(?:patients\s+with\s+|adults\s+with\s+)?([^:,]{3,80})(?:,\s*|\s*:\s*)(.+)$/i
    );
    if (leadCondMatch) {
      condTerms.push(leadCondMatch[1].trim());
      const arms = leadCondMatch[2].split(/\s+(?:vs\.?|versus|compared\s+with)\s+/i).map(a => a.trim()).filter(Boolean);
      for (const arm of expandComparativeArmNounSharing(arms)) {
        if (!GENERIC_NON_INTERVENTION_TERMS.has(arm.toLowerCase())) {
          intrTerms.push(arm);
        }
      }
    }
  }

  // 2. Semantic enrichment from MetaMapLite concepts & comparativeDetails
  if (metaMapResult && Array.isArray(metaMapResult.concepts)) {
    for (const c of metaMapResult.concepts) {
      const semTypes: string[] = Array.isArray(c.semanticTypes) ? c.semanticTypes : [];
      const candidates = [
        c.meshDescriptor ? cleanConceptCandidate(String(c.meshDescriptor)) : '',
        c.preferredName ? stripParentheticalSummary(cleanConceptCandidate(String(c.preferredName))) : '',
        c.matchedText ? cleanConceptCandidate(String(c.matchedText)) : ''
      ].filter(t => t.length >= 3 && !GENERIC_NON_INTERVENTION_TERMS.has(t.toLowerCase()));

      if (semTypes.some(st => CONDITION_SEMANTIC_TYPES.has(st))) {
        condTerms.push(...candidates);
      } else if (semTypes.some(st => INTERVENTION_SEMANTIC_TYPES.has(st))) {
        for (const cand of candidates) {
          const cleanedCand = stripConditionClauseFromArm(cand);
          if (!cleanedCand || GENERIC_NON_INTERVENTION_TERMS.has(cleanedCand.toLowerCase())) continue;
          intrTerms.push(cleanedCand);
          const routeNorm = normalizeRouteAbbreviations(cleanedCand);
          if (routeNorm.toLowerCase() !== cleanedCand.toLowerCase()) intrTerms.push(routeNorm);
        }
      }
    }
  }

  if (metaMapResult?.comparativeDetails) {
    const { arm1, arm2, contextCondition } = metaMapResult.comparativeDetails;
    if (contextCondition) {
      const condParts = String(contextCondition)
        .split(/\s+OR\s+/i)
        .map(cleanConceptCandidate)
        .filter(t => t.length >= 3);
      condTerms.push(...condParts);
    }
    const rawArms = [
      arm1?.expanded || arm1?.name,
      arm2?.expanded || arm2?.name
    ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    for (const arm of expandComparativeArmNounSharing(rawArms)) {
      if (!GENERIC_NON_INTERVENTION_TERMS.has(arm.toLowerCase())) {
        intrTerms.push(arm);
      }
    }
  }

  // Filter redundant short acronyms out of condTerms if an expanded multi-word term already exists
  const cleanCondRaw = Array.from(
    new Set(condTerms.map(cleanConceptCandidate).filter(t => t.length >= 2 && !GENERIC_NON_INTERVENTION_TERMS.has(t.toLowerCase())))
  );
  const hasLongCond = cleanCondRaw.some(t => t.length > 4);
  const filteredCondTerms = hasLongCond
    ? cleanCondRaw.filter(t => t.length > 4 || !/^[A-Z0-9]{2,4}$/.test(t))
    : cleanCondRaw;

  const cleanIntrTerms = Array.from(
    new Set(
      intrTerms
        .map(cleanConceptCandidate)
        .filter(t => t.length >= 2 && !GENERIC_NON_INTERVENTION_TERMS.has(t.toLowerCase()))
    )
  );
  const hasLongIntr = cleanIntrTerms.some(t => t.length > 4);
  const filteredIntrTerms = hasLongIntr
    ? cleanIntrTerms.filter(t => t.length > 4)
    : cleanIntrTerms;

  return {
    condTerms: filteredCondTerms,
    intrTerms: filteredIntrTerms,
    condQuery: formatCtGovClause(filteredCondTerms, true),
    intrQuery: formatCtGovClause(filteredIntrTerms, false)
  };
}

function termMatchesHaystack(term: string, haystack: string): boolean {
  const clean = cleanConceptCandidate(term).toLowerCase();
  if (!clean) return false;
  if (clean.length <= 4) {
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?![a-z0-9-]|-?\\d)`, 'i').test(haystack);
  }
  if (haystack.includes(clean)) return true;

  // Allow inflections & word-stem matching for multi-word clinical phrases (ignoring relational hyphen connectors)
  const words = clean
    .split(/[\s-]+/)
    .filter(w => w.length >= 3 && !GENERIC_NON_INTERVENTION_TERMS.has(w) && !RELATIONAL_CONNECTOR_WORDS.has(w));
  if (words.length === 0) return false;
  let matchedWords = 0;
  for (const w of words) {
    const stem = w.length >= 6 ? w.slice(0, w.length - 1) : w;
    if (haystack.includes(w) || (stem.length >= 5 && haystack.includes(stem))) {
      matchedWords++;
    }
  }
  return matchedWords === words.length || (words.length >= 3 && matchedWords >= words.length - 1);
}

/**
 * Verifies whether a ClinicalTrials.gov record satisfies BOTH the condition concept AND the intervention concept.
 */
export function doesTrialMatchConceptIntersection(
  doc: MedicalDocument,
  condTerms: string[],
  intrTerms: string[]
): { matchesCond: boolean; matchesIntr: boolean } {
  const rawHaystack = [
    doc.title || '',
    doc.abstract || '',
    doc.pico?.population || '',
    doc.pico?.intervention || '',
    doc.pico?.comparator || ''
  ]
    .join(' ')
    .toLowerCase()
    .replace(/\b[a-z]{2,5}-\d{2,6}\b/gi, ' ');

  const matchesCond = condTerms.length === 0 || condTerms.some(t => termMatchesHaystack(t, rawHaystack));
  const matchesIntr = intrTerms.length === 0 || intrTerms.some(t => termMatchesHaystack(t, rawHaystack));
  return { matchesCond, matchesIntr };
}

/**
 * Computes real 384-d cosine similarity for a ClinicalTrials.gov record (never assigns static 0.75).
 */
export function computeCtGovSimilarityScore(
  doc: MedicalDocument,
  query: string,
  condTerms: string[] = [],
  intrTerms: string[] = []
): number {
  const queryVec = generateLocalEmbedding(query, 384);
  const rawAbs = (doc.abstract || '').trim();
  const hasMeaningfulAbs = rawAbs.length >= 25 && !/^abstract not reported/i.test(rawAbs);
  const embedInput = hasMeaningfulAbs
    ? `${doc.title} ${rawAbs} ${doc.pico?.intervention || ''} ${doc.pico?.population || ''}`.slice(0, 3200)
    : `${doc.title} ${doc.pico?.intervention || ''} ${doc.pico?.population || ''}`.trim();

  const docVec = generateLocalEmbedding(embedInput, 384);
  const rawCosine = Math.max(0, cosineSimilarity(queryVec, docVec));

  const queryTokens = query
    .toLowerCase()
    .split(/[\s,()"]+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length > 1 && !GENERIC_NON_INTERVENTION_TERMS.has(t));

  const lowerText = `${doc.title} ${rawAbs} ${doc.pico?.intervention || ''} ${doc.pico?.population || ''}`.toLowerCase();
  const hits = queryTokens.filter(t => termMatchesHaystack(t, lowerText)).length;
  const tokenCoverage = queryTokens.length > 0 ? hits / queryTokens.length : 0.5;

  const { matchesCond, matchesIntr } = doesTrialMatchConceptIntersection(doc, condTerms, intrTerms);
  const intersectionFactor =
    condTerms.length > 0 && intrTerms.length > 0 && (!matchesCond || !matchesIntr) ? 0.35 : 1.0;

  let sim = (rawCosine * 0.65 + tokenCoverage * 0.35) * intersectionFactor;
  if (!hasMeaningfulAbs) {
    sim = sim * 0.65;
  }

  return Number(Math.min(0.99, Math.max(0.01, sim)).toFixed(4));
}

/**
 * Queries ClinicalTrials.gov REST API v2 using structured `query.cond` + `query.intr`
 * intersection, post-filters trials to match both condition and intervention, and scores
 * records with real 384-d cosine similarity (never static 0.75).
 */
export async function searchClinicalTrials(
  queryOrOptions: string | CtGovSearchOptions,
  maxResults = 15
): Promise<MedicalDocument[]> {
  const options: CtGovSearchOptions =
    typeof queryOrOptions === 'string' ? { query: queryOrOptions } : queryOrOptions;
  const cleanQuery = (options.query || '').trim();
  if (!cleanQuery) return [];

  const { condTerms, intrTerms, condQuery, intrQuery } = splitClinicalQueryForCtGov(
    cleanQuery,
    options.metaMapResult,
    options.conditionTerms,
    options.interventionTerms
  );

  const cappedLimit = Math.min(50, Math.max(1, maxResults));
  const fetchPageSize = Math.min(50, Math.max(cappedLimit * 2, 20));
  const cacheKey = `ctgov:search:v2:${condQuery.toLowerCase()}|${intrQuery.toLowerCase()}|${cleanQuery.toLowerCase()}:${cappedLimit}`;

  try {
    const { value } = await apiCache.getOrFetch<MedicalDocument[]>(
      cacheKey,
      async () => {
        await waitForCtGovRateLimit();
        const params = new URLSearchParams();
        if (condQuery && intrQuery) {
          params.set('query.cond', condQuery);
          params.set('query.intr', intrQuery);
        } else if (condQuery) {
          params.set('query.cond', condQuery);
          if (intrQuery) params.set('query.intr', intrQuery);
        } else if (intrQuery) {
          params.set('query.intr', intrQuery);
        } else {
          // Single-concept fallback: require ALL core terms via AND (never broad OR dump)
          const andTerms = cleanQuery
            .split(/\s+/)
            .map(w => w.replace(/[^a-z0-9-]/gi, ''))
            .filter(w => w.length > 2 && !GENERIC_NON_INTERVENTION_TERMS.has(w.toLowerCase()));
          params.set('query.term', andTerms.length > 1 ? andTerms.join(' AND ') : cleanQuery);
        }
        params.set('pageSize', String(fetchPageSize));
        params.set('format', 'json');

        const url = `${CLINICAL_TRIALS_V2_BASE}?${params.toString()}`;
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
          const mapped = mapProtocolSectionToDocument(
            s?.protocolSection,
            undefined,
            s?.resultsSection,
            Boolean(s?.hasResults)
          );
          if (!mapped) continue;

          // Post-filter: exclude any trial failing multi-concept intersection (both Condition AND Intervention)
          if (condTerms.length > 0 && intrTerms.length > 0) {
            const { matchesCond, matchesIntr } = doesTrialMatchConceptIntersection(mapped, condTerms, intrTerms);
            if (!matchesCond || !matchesIntr) {
              continue;
            }
          }

          mapped.score = computeCtGovSimilarityScore(mapped, cleanQuery, condTerms, intrTerms);
          docs.push(mapped);
        }

        docs.sort((a, b) => (b.score || 0) - (a.score || 0));
        return docs.slice(0, cappedLimit);
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
 * Fetches a single trial protocolSection (and resultsSection when available) by NCT ID from ClinicalTrials.gov REST API v2.
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
        const data = (await res.json()) as { protocolSection?: any; resultsSection?: any; hasResults?: boolean };
        return mapProtocolSectionToDocument(
          data?.protocolSection,
          undefined,
          data?.resultsSection,
          Boolean(data?.hasResults)
        );
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
 * queries ClinicalTrials.gov v2 for matching protocol & results records, and fills missing PICO/statistical fields.
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
      new Set([...(reg.linkedPmids || []), ...(doc.linkedPmids || [])].filter(Boolean))
    );
    const mergedSources = Array.from(
      new Set([...(doc.mergedSources || [doc.source]), 'ClinicalTrials.gov'])
    );

    const existingP = Array.isArray(doc.pico?.pValues) ? doc.pico.pValues : [];
    const regP = Array.isArray(reg.pico?.pValues) ? reg.pico.pValues : [];
    const mergedPValues = Array.from(new Set([...existingP, ...regP])).slice(0, 6);

    const mergedMetricType = doc.pico?.effectMetricType || reg.pico.effectMetricType || null;
    const mergedEstimate = doc.pico?.effectEstimate || reg.pico.effectEstimate;
    let mergedRiskRatio = doc.pico?.riskRatio || reg.pico.riskRatio;
    if (mergedMetricType === 'OR' && mergedRiskRatio && /^OR\b/i.test(mergedRiskRatio)) {
      mergedRiskRatio = undefined;
    }

    const updatedPico: PicoData = {
      ...doc.pico,
      sampleSize: doc.pico?.sampleSize && doc.pico.sampleSize > 0 ? doc.pico.sampleSize : reg.pico.sampleSize,
      population: doc.pico?.population && doc.pico.population !== 'Not reported' ? doc.pico.population : reg.pico.population,
      intervention: doc.pico?.intervention && doc.pico.intervention !== 'Not reported' ? doc.pico.intervention : reg.pico.intervention,
      comparator: doc.pico?.comparator && doc.pico.comparator !== 'Not reported' ? doc.pico.comparator : reg.pico.comparator,
      primaryOutcome: doc.pico?.primaryOutcome && doc.pico.primaryOutcome !== 'Not reported' ? doc.pico.primaryOutcome : reg.pico.primaryOutcome,
      pValues: mergedPValues,
      effectMetricType: mergedMetricType,
      effectEstimate: mergedEstimate,
      hazardRatio: doc.pico?.hazardRatio || reg.pico.hazardRatio,
      riskRatio: mergedRiskRatio,
      primaryStatistic:
        doc.pico?.primaryStatistic ||
        reg.pico.primaryStatistic ||
        (mergedMetricType && mergedEstimate ? `${mergedMetricType} ${mergedEstimate}` : undefined) ||
        doc.pico?.hazardRatio ||
        reg.pico.hazardRatio ||
        mergedRiskRatio,
      design: doc.pico?.design === 'Observational / Descriptive Study' ? reg.pico.design : doc.pico.design
    };

    return {
      ...doc,
      year: doc.year ?? reg.year ?? null,
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
  extractCtGovResults,
  mapProtocolSectionToDocument,
  splitClinicalQueryForCtGov,
  doesTrialMatchConceptIntersection,
  computeCtGovSimilarityScore
};
