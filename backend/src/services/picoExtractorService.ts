import type { MedicalDocument, PicoData } from './searchService.js';
import { executeInference } from './openRouterService.js';
import { config } from '../config.js';
import { apiCache } from '../utils/apiCache.js';
import { decodeHtmlEntities } from './corpusContextBuilder.js';

export type EffectMetricType = 'HR' | 'OR' | 'RR' | 'MD';

export interface StructuredLlmPicoResult {
  population: string;
  intervention: string;
  comparator: string;
  outcome: string;
  sampleSize: number | null;
  effectMetricType: EffectMetricType | null;
  effectEstimate: string | null;
  pValue: string | null;
}

/**
 * Extracts strictly the allowed scope for cohort sample size (N) extraction:
 * - Structured Abstract sections: Aims / Objective / Purpose, Methods / Patients, Results
 *   (explicitly stripping Introduction, Background, Discussion, Conclusion, and References blocks)
 * - PMC full-text Methods section ONLY (NEVER Introduction, Results, Tables, Discussion, or References)
 */
export function extractAbstractScopeForSampleSize(abstract: string, pmcMethods?: string): string {
  const cleanAbs = decodeHtmlEntities(abstract || '').trim();
  let scopedAbstract = cleanAbs;

  if (cleanAbs) {
    // Detect structured uppercase/labeled abstract headings such as "AIMS: ... METHODS: ... RESULTS: ..."
    const sectionHeaderRe =
      /(?:^|\s)(AIMS?|OBJECTIVES?|PURPOSE|BACKGROUND|INTRODUCTION|METHODS?|METHODOLOGY|PATIENTS(?:\s+AND\s+METHODS)?|MATERIALS(?:\s+AND\s+METHODS)?|DESIGN|SETTING|PARTICIPANTS|INTERVENTIONS?|MAIN\s+OUTCOME\s+MEASURES?|RESULTS?|FINDINGS|DISCUSSION|CONCLUSIONS?|TRIAL\s+REGISTRATION|REFERENCES?)\s*:\s*/gi;

    const matches = [...cleanAbs.matchAll(sectionHeaderRe)];
    if (matches.length >= 2) {
      const keptParts: string[] = [];
      for (let i = 0; i < matches.length; i++) {
        const label = (matches[i][1] || '').trim().toUpperCase();
        const startIdx = (matches[i].index || 0) + matches[i][0].length;
        const endIdx = i + 1 < matches.length ? (matches[i + 1].index || cleanAbs.length) : cleanAbs.length;
        const body = cleanAbs.slice(startIdx, endIdx).trim();
        if (!body) continue;

        // Explicitly exclude Introduction, Background, Discussion, Conclusions, References
        if (/^(?:BACKGROUND|INTRODUCTION|DISCUSSION|CONCLUSIONS?|REFERENCES?)$/i.test(label)) {
          continue;
        }
        keptParts.push(`${label}: ${body}`);
      }
      if (keptParts.length > 0) {
        scopedAbstract = keptParts.join(' ');
      }
    } else {
      // Unstructured abstract: strip any trailing References block if present
      scopedAbstract = cleanAbs.replace(/\bREFERENCES?\s*:[\s\S]*$/i, '').trim();
    }
  }

  const cleanMethods = decodeHtmlEntities(pmcMethods || '').trim();
  return [scopedAbstract, cleanMethods ? `PMC_METHODS: ${cleanMethods.slice(0, 4500)}` : '']
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function isLlmPicoExtractionEnabled(): boolean {
  if (process.env.DISABLE_LLM_PICO_EXTRACTION === 'true') return false;
  const preferred = config.llmProvider;
  if (preferred === 'omniroute') return Boolean(config.omniRouteUrl);
  if (preferred === 'ollama') return true;
  if (preferred === 'openrouter') return Boolean(config.openRouterApiKey || process.env.OPENROUTER_API_KEY);
  if (preferred === 'gemini') return Boolean(config.geminiApiKey || process.env.GEMINI_API_KEY);
  return Boolean(
    config.omniRouteUrl ||
    config.openRouterApiKey ||
    process.env.OPENROUTER_API_KEY ||
    config.geminiApiKey ||
    process.env.GEMINI_API_KEY ||
    (config.ollamaUrl && config.ollamaUrl !== 'http://localhost:11434')
  );
}

function normalizeEffectMetricType(raw: unknown): EffectMetricType | null {
  if (!raw || typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'HR' || upper === 'AHR' || upper === 'HAZARD RATIO') return 'HR';
  if (upper === 'OR' || upper === 'AOR' || upper === 'ODDS RATIO') return 'OR';
  if (upper === 'RR' || upper === 'ARR' || upper === 'RISK RATIO' || upper === 'RELATIVE RISK') return 'RR';
  if (upper === 'MD' || upper === 'WMD' || upper === 'SMD' || upper === 'MEAN DIFFERENCE') return 'MD';
  return null;
}

function cleanEffectEstimateString(raw: unknown, metricType: EffectMetricType | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned || /^(?:null|none|n\/?a|not\s+reported)$/i.test(cleaned)) return null;
  if (metricType) {
    cleaned = cleaned.replace(new RegExp(`^(?:a?${metricType}|odds\\s+ratio|hazard\\s+ratio|risk\\s+ratio|relative\\s+risk|mean\\s+difference)\\s*[:=]?\\s*`, 'i'), '').trim();
  }
  return cleaned || null;
}

function cleanLlmTextField(raw: unknown, allowNotApplicable = false): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned || /^(?:null|none|n\/?a|unknown|not\s+reported)$/i.test(cleaned)) {
    return null;
  }
  if (allowNotApplicable && /^not\s+applicable\b/i.test(cleaned)) {
    return 'Not applicable (observational cohort)';
  }
  return cleaned.length > 260 ? `${cleaned.slice(0, 257).trimEnd()}...` : cleaned;
}

function normalizeLlmPValue(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned || /^(?:null|none|n\/?a|not\s+reported)$/i.test(cleaned)) return null;
  const match = cleaned.match(/\b(?:p|P)?\s*([<>]=?|=)\s*(0?\.\d{1,5}|0001|001|01|05)\b/);
  if (match) {
    return `p ${match[1]} ${match[2]}`;
  }
  return null;
}

function parseJsonResponse(rawText: string): StructuredLlmPicoResult | null {
  if (!rawText) return null;
  const stripped = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object') return null;

    const metricType = normalizeEffectMetricType(parsed.effectMetricType);
    const effectEstimate = cleanEffectEstimateString(parsed.effectEstimate, metricType);
    let sampleSize: number | null = null;
    if (typeof parsed.sampleSize === 'number' && Number.isFinite(parsed.sampleSize)) {
      const rounded = Math.round(parsed.sampleSize);
      if (rounded > 0 && rounded < 10_000_000) {
        sampleSize = rounded;
      }
    } else if (typeof parsed.sampleSize === 'string') {
      const numeric = parseInt(parsed.sampleSize.replace(/,/g, ''), 10);
      if (Number.isFinite(numeric) && numeric > 0 && numeric < 10_000_000) {
        sampleSize = numeric;
      }
    }

    return {
      population: cleanLlmTextField(parsed.population) || 'Not reported',
      intervention: cleanLlmTextField(parsed.intervention) || 'Not reported',
      comparator: cleanLlmTextField(parsed.comparator, true) || 'Not reported',
      outcome: cleanLlmTextField(parsed.outcome) || 'Not reported',
      sampleSize,
      effectMetricType: metricType,
      effectEstimate,
      pValue: normalizeLlmPValue(parsed.pValue)
    };
  } catch {
    return null;
  }
}

export async function extractStructuredPicoWithLlm(doc: MedicalDocument): Promise<StructuredLlmPicoResult | null> {
  if (!isLlmPicoExtractionEnabled()) return null;

  const rawAbstract = (doc.abstract || '').trim();
  const hasMeaningfulAbs = rawAbstract.length >= 40 && !/^abstract not reported/i.test(rawAbstract);
  if (!hasMeaningfulAbs && !doc.hasFullText) {
    return null;
  }

  const cacheKey = `pico:llm:v1:${doc.pmid || doc.doi || doc.nctId || doc.id}:${doc.hasFullText ? 'ft' : 'abs'}`;
  const cached = apiCache.get<StructuredLlmPicoResult>(cacheKey);
  if (cached) return cached;

  const scopedForSampleSize = extractAbstractScopeForSampleSize(
    rawAbstract,
    doc.hasFullText ? doc.fullTextSections?.methods : undefined
  );
  const resultsSnippet =
    doc.hasFullText && doc.fullTextSections?.results
      ? decodeHtmlEntities(doc.fullTextSections.results).slice(0, 1800)
      : '';

  const prompt = `Extract structured clinical PICO and statistical data strictly from the text below.

STUDY TITLE: ${doc.title}
STUDY DESIGN: ${doc.pico?.design || 'Observational / Descriptive Study'}

ABSTRACT & METHODS (USE THIS SECTION ONLY FOR sampleSize N):
${scopedForSampleSize.slice(0, 4000)}
${resultsSnippet ? `\nPMC RESULTS EXCERPT (FOR OUTCOME / EFFECT ESTIMATE / P-VALUE ONLY — DO NOT TAKE CITED BACKGROUND NUMBERS FOR sampleSize):\n${resultsSnippet}` : ''}

RULES:
1. Extract "sampleSize" (total study cohort N) STRICTLY from the Abstract (Aims, Methods, Results) and PMC Methods text above. NEVER use background epidemiology numbers or cited studies' sample sizes. Return null if the study's own cohort size is not explicitly stated.
2. If the study is an observational risk-factor, descriptive, or single-arm cohort study without a two-arm comparator, set "comparator" to "Not applicable (observational cohort)" and list the primary exposure or risk factors in "intervention".
3. Choose "effectMetricType" strictly from: "HR" (Hazard Ratio), "OR" (Odds Ratio), "RR" (Risk Ratio / Relative Risk), "MD" (Mean Difference), or null. Put the numeric value and CI in "effectEstimate" WITHOUT repeating the "OR"/"HR"/"RR"/"MD" label (e.g. "4.85 (95% CI 1.00 to 23.36)").
4. Keep "population", "intervention", "comparator", and "outcome" concise, faithful clinical phrases (< 180 chars each). Use "Not reported" if absent.

Return ONLY valid raw JSON with this exact schema:
{ "population": string, "intervention": string, "comparator": string, "outcome": string, "sampleSize": number | null, "effectMetricType": "HR" | "OR" | "RR" | "MD" | null, "effectEstimate": string | null, "pValue": string | null }`;

  try {
    const inferencePromise = executeInference(prompt, {
      ...(config.llmProvider === 'openrouter' ? { model: config.llmSynthesisModel } : {}),
      temperature: 0.1,
      maxTokens: 450,
      systemPrompt: 'You are a clinical epidemiology data extraction engine. Output strictly valid raw JSON with no markdown fences or commentary.'
    });

    const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), 8500));
    const response = await Promise.race([inferencePromise, timeoutPromise]);
    if (!response || response.provider === 'clinical_rule_engine' || !response.text) {
      return null;
    }

    const parsed = parseJsonResponse(response.text);
    if (parsed) {
      apiCache.set(cacheKey, parsed);
    }
    return parsed;
  } catch (err) {
    console.warn('[picoExtractorService] LLM PICO extraction fallback notice:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function mergeStructuredPicoOntoDocument(doc: MedicalDocument, llmPico: StructuredLlmPicoResult): MedicalDocument {
  const existing = doc.pico;
  const population = llmPico.population && llmPico.population !== 'Not reported'
    ? llmPico.population
    : (existing?.population || 'Not reported');
  const intervention = llmPico.intervention && llmPico.intervention !== 'Not reported'
    ? llmPico.intervention
    : (existing?.intervention || 'Not reported');
  const comparator = llmPico.comparator && llmPico.comparator !== 'Not reported'
    ? llmPico.comparator
    : (existing?.comparator || 'Not reported');
  const primaryOutcome = llmPico.outcome && llmPico.outcome !== 'Not reported'
    ? llmPico.outcome
    : (existing?.primaryOutcome || 'Not reported');

  // Preserve verified registry sample size if present; otherwise prefer LLM scoped cohort size when valid, else regex scoped size
  const resolvedSampleSize =
    (doc.source === 'ClinicalTrials.gov' || doc.source === 'ISRCTN') && existing?.sampleSize > 0
      ? existing.sampleSize
      : llmPico.sampleSize && llmPico.sampleSize > 0
      ? llmPico.sampleSize
      : (existing?.sampleSize || 0);

  const pValues = [...(existing?.pValues || [])];
  if (llmPico.pValue && !pValues.includes(llmPico.pValue)) {
    pValues.unshift(llmPico.pValue);
  }

  const effectMetricType = llmPico.effectMetricType || existing?.effectMetricType || null;
  const effectEstimate = llmPico.effectEstimate || existing?.effectEstimate;

  let hazardRatio = existing?.hazardRatio;
  let riskRatio = existing?.riskRatio;
  if (effectMetricType === 'HR' && effectEstimate) {
    hazardRatio = effectEstimate;
  } else if (effectMetricType === 'RR' && effectEstimate) {
    riskRatio = effectEstimate;
  } else if (effectMetricType === 'OR') {
    // Never mislabel an Odds Ratio as Risk Ratio
    if (riskRatio && /^OR\b/i.test(riskRatio)) {
      riskRatio = undefined;
    }
  }

  const primaryStatistic =
    effectMetricType && effectEstimate
      ? `${effectMetricType} ${effectEstimate}`
      : pValues[0] || existing?.primaryStatistic;

  const updatedPico: PicoData = {
    ...existing,
    population,
    sampleSize: resolvedSampleSize,
    intervention,
    comparator,
    primaryOutcome,
    pValues: pValues.slice(0, 6),
    effectMetricType,
    effectEstimate,
    hazardRatio,
    riskRatio,
    primaryStatistic
  };

  return {
    ...doc,
    pico: updatedPico
  };
}

/**
 * Enriches the top ranked studies (default: top 25) using structured LLM JSON PICO extraction,
 * running with bounded concurrency and gracefully retaining regex-extracted PICO if disabled or unavailable.
 */
export async function enrichTopStudiesPicoWithLlm(
  studies: MedicalDocument[],
  maxStudies = 25
): Promise<MedicalDocument[]> {
  if (!studies || studies.length === 0 || !isLlmPicoExtractionEnabled()) {
    return studies;
  }

  const targetCount = Math.min(maxStudies, studies.length);
  const result = [...studies];
  const CONCURRENCY = 5;

  for (let i = 0; i < targetCount; i += CONCURRENCY) {
    const batchIndices = Array.from(
      { length: Math.min(CONCURRENCY, targetCount - i) },
      (_, offset) => i + offset
    );
    const settled = await Promise.allSettled(
      batchIndices.map(async idx => {
        const doc = result[idx];
        const llmPico = await extractStructuredPicoWithLlm(doc);
        if (llmPico) {
          result[idx] = mergeStructuredPicoOntoDocument(doc, llmPico);
        }
      })
    );
    // Individual failures silently preserve existing regex PICO
    void settled;
  }

  return result;
}
