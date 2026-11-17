import { config } from '../config.js';
import { apiCache } from '../utils/apiCache.js';

export interface FullTextSections {
  methods?: string;
  results?: string;
  tables?: string;
  discussion?: string;
}

export interface PmcEnrichmentResult {
  pmid: string;
  pmcid?: string;
  hasFullText: boolean;
  fullText?: string;
  fullTextSections?: FullTextSections;
}

const NCBI_ID_CONVERTER_URL = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/';
const NCBI_EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const TOOL_NAME = 'MedResearchAI';

/**
 * NBK25497-compliant sequential rate limiter for NCBI Entrez / PMC API requests:
 * - ~115ms spacing when NCBI_API_KEY is configured (<= 10 req/s)
 * - ~360ms spacing when no API key is set (<= 3 req/s)
 */
let lastNcbiPmcRequestTime = 0;

function getNcbiCredentials(): { apiKey: string; email: string } {
  const apiKey = (process.env.NCBI_API_KEY || config.ncbiApiKey || '').trim();
  const email = (process.env.SCHOLARLY_USER_AGENT_EMAIL || config.scholarlyEmail || 'researcher@domain.com').trim();
  return { apiKey, email };
}

async function waitForNcbiPmcRateLimit(): Promise<void> {
  const { apiKey } = getNcbiCredentials();
  const minIntervalMs = apiKey ? 115 : 360;
  const now = Date.now();
  const elapsed = now - lastNcbiPmcRequestTime;
  if (elapsed < minIntervalMs) {
    await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastNcbiPmcRequestTime = Date.now();
}

/**
 * Decodes common XML/HTML entities into readable characters.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#xa0;|&#160;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : ' ';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : ' ';
    });
}

/**
 * Strips <xref> citation tags, formatting tags, and all remaining XML markup cleanly.
 */
export function stripPmcXmlMarkup(xmlFragment: string): string {
  if (!xmlFragment) return '';

  const cleaned = xmlFragment
    // Strip <xref> citation & cross-reference tags completely
    .replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/gi, ' ')
    .replace(/<xref\b[^>]*\/>/gi, ' ')
    // Strip embedded mathml/tex markup noise that produces fragmented token spam
    .replace(/<tex-math\b[^>]*>[\s\S]*?<\/tex-math>/gi, ' ')
    .replace(/<mml:math\b[^>]*>[\s\S]*?<\/mml:math>/gi, ' ')
    // Preserve cell/row/paragraph boundaries as readable delimiters
    .replace(/<\/(?:th|td)>/gi, ' | ')
    .replace(/<\/(?:tr|p|title|caption|label|li)>/gi, '\n')
    .replace(/<break\s*\/?>/gi, '\n')
    // Strip all remaining XML tags
    .replace(/<[^>]+>/g, ' ');

  return decodeXmlEntities(cleaned)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\|\s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts readable table text from <table-wrap> elements across an <article>.
 */
function extractTablesFromArticleXml(articleXml: string): string {
  const tableMatches = articleXml.matchAll(/<table-wrap\b[^>]*>([\s\S]*?)<\/table-wrap>/gi);
  const tables: string[] = [];

  for (const match of tableMatches) {
    const tableBlock = match[1];
    if (!tableBlock) continue;

    const labelMatch = tableBlock.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
    const captionMatch = tableBlock.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const label = labelMatch ? stripPmcXmlMarkup(labelMatch[1]) : '';
    const caption = captionMatch ? stripPmcXmlMarkup(captionMatch[1]) : '';

    // Extract rows with pipe-separated cells
    const rows: string[] = [];
    const rowMatches = tableBlock.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const rowMatch of rowMatches) {
      const cells: string[] = [];
      const cellMatches = rowMatch[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi);
      for (const cellMatch of cellMatches) {
        const cellText = stripPmcXmlMarkup(cellMatch[1]).replace(/\n+/g, ' ').trim();
        if (cellText) cells.push(cellText);
      }
      if (cells.length > 0) {
        rows.push(cells.join(' | '));
      }
    }

    // Also include table footnote if present (often has p-value definitions / sample notes)
    const footMatch = tableBlock.match(/<table-wrap-foot[^>]*>([\s\S]*?)<\/table-wrap-foot>/i);
    const footText = footMatch ? stripPmcXmlMarkup(footMatch[1]) : '';

    const parts: string[] = [];
    const headerLine = [label, caption].filter(Boolean).join(': ');
    if (headerLine) parts.push(headerLine);
    if (rows.length > 0) parts.push(rows.join('\n'));
    if (footText) parts.push(footText);

    const assembled = parts.join('\n').trim();
    if (assembled.length > 15) {
      tables.push(assembled);
    }
  }

  return tables.join('\n\n').trim();
}

interface TopLevelSec {
  secType: string;
  title: string;
  innerXml: string;
}

/**
 * Balanced tag-depth parser for top-level <sec> elements inside PMC <body>.
 * Correctly keeps nested subsections (<sec> inside <sec>) grouped with their parent section.
 */
function extractTopLevelBodySections(bodyXml: string): TopLevelSec[] {
  const sections: TopLevelSec[] = [];
  const secTagRegex = /<\/?sec\b([^>]*)>/gi;

  let depth = 0;
  let currentStart = -1;
  let currentAttrs = '';
  let contentStart = -1;

  let match: RegExpExecArray | null;
  while ((match = secTagRegex.exec(bodyXml)) !== null) {
    const fullTag = match[0];
    const isClosing = fullTag.startsWith('</');
    const isSelfClosing = !isClosing && fullTag.endsWith('/>');

    if (isSelfClosing) continue;

    if (!isClosing) {
      if (depth === 0) {
        currentStart = match.index;
        currentAttrs = match[1] || '';
        contentStart = match.index + fullTag.length;
      }
      depth++;
    } else {
      depth--;
      if (depth === 0 && currentStart !== -1 && contentStart !== -1) {
        const innerXml = bodyXml.slice(contentStart, match.index);
        const secTypeMatch = currentAttrs.match(/\bsec-type\s*=\s*["']([^"']+)["']/i);
        const titleMatch = innerXml.match(/^\s*(?:<label[^>]*>[\s\S]*?<\/label>\s*)?<title\b[^>]*>([\s\S]*?)<\/title>/i);

        sections.push({
          secType: (secTypeMatch?.[1] || '').trim().toLowerCase(),
          title: titleMatch ? stripPmcXmlMarkup(titleMatch[1]).toLowerCase() : '',
          innerXml
        });

        currentStart = -1;
        contentStart = -1;
        currentAttrs = '';
      } else if (depth < 0) {
        depth = 0;
      }
    }
  }

  return sections;
}

/**
 * Parses a single PMC <article>...</article> XML string into structured sections and prioritized fullText.
 */
export function parsePmcArticleXml(articleXml: string, maxCharsPerArticle = 14000): {
  hasFullText: boolean;
  fullText?: string;
  fullTextSections?: FullTextSections;
} {
  if (!articleXml || /<error\b[^>]*>/i.test(articleXml)) {
    return { hasFullText: false };
  }

  const bodyMatch = articleXml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch || !bodyMatch[1]) {
    return { hasFullText: false };
  }

  const bodyXml = bodyMatch[1];
  const topSections = extractTopLevelBodySections(bodyXml);

  const methodsParts: string[] = [];
  const resultsParts: string[] = [];
  const discussionParts: string[] = [];

  for (const sec of topSections) {
    // Exclude tables from prose sections since <table-wrap> is extracted cleanly into `tables`
    const proseOnlyXml = sec.innerXml.replace(/<table-wrap\b[^>]*>[\s\S]*?<\/table-wrap>/gi, ' ');
    const cleanText = stripPmcXmlMarkup(proseOnlyXml);
    if (!cleanText || cleanText.length < 20) continue;

    const hint = `${sec.secType} ${sec.title}`.trim();

    if (/supplementary|acknowledg|funding|conflict|disclosure|competing|ethics|consent|author\s*contribution|availability|abbreviation|reference/i.test(hint)) {
      continue;
    }

    if (/\b(introduction|background)\b/i.test(hint) && !/\b(method|methods|methodology|material|materials|study\s*design|protocol)\b/i.test(hint)) {
      continue;
    }

    if (/\b(method|methods|methodology|material|materials|patient|patients|subject|subjects|participant|participants|study\s*design|protocol|surgical|operative|statistical)\b/i.test(hint)) {
      methodsParts.push(cleanText);
    } else if (/\b(result|results|finding|findings|outcome|outcomes)\b/i.test(hint)) {
      resultsParts.push(cleanText);
    } else if (/\b(discussion|conclusion|conclusions|interpretation|limitation|limitations|comment)\b/i.test(hint)) {
      discussionParts.push(cleanText);
    }
  }

  const tables = extractTablesFromArticleXml(articleXml);
  const methods = methodsParts.join('\n\n').trim() || undefined;
  const results = resultsParts.join('\n\n').trim() || undefined;
  const discussion = discussionParts.join('\n\n').trim() || undefined;
  const tablesSection = tables || undefined;

  // Fallback for open-access articles whose <body> lacks labeled <sec> tags (single narrative body)
  let unstructuredFallback = '';
  if (!methods && !results && !discussion) {
    const rawBodyClean = stripPmcXmlMarkup(
      bodyXml.replace(/<table-wrap\b[^>]*>[\s\S]*?<\/table-wrap>/gi, ' ')
    );
    if (rawBodyClean.length >= 120 && !/^supporting information available\b/i.test(rawBodyClean)) {
      unstructuredFallback = rawBodyClean;
    }
  }

  const fullTextSections: FullTextSections = {
    ...(methods ? { methods } : {}),
    ...(results ? { results } : {}),
    ...(tablesSection ? { tables: tablesSection } : {}),
    ...(discussion ? { discussion } : {})
  };

  // Prioritize assembled fullText in strict clinical order: Methods -> Results -> Tables -> Discussion
  const orderedBlocks: Array<{ header: string; content?: string }> = [
    { header: 'METHODS', content: methods },
    { header: 'RESULTS', content: results },
    { header: 'TABLES', content: tablesSection },
    { header: 'DISCUSSION', content: discussion }
  ];

  const assembledBlocks: string[] = [];
  let remainingBudget = Math.max(500, maxCharsPerArticle);

  for (const block of orderedBlocks) {
    if (!block.content || remainingBudget <= 40) continue;
    const prefix = `[${block.header}]\n`;
    const available = remainingBudget - prefix.length;
    if (available <= 30) break;

    const slice = block.content.length > available
      ? `${block.content.slice(0, available - 3).trimEnd()}...`
      : block.content;

    const formatted = `${prefix}${slice}`;
    assembledBlocks.push(formatted);
    remainingBudget -= formatted.length + 2; // +2 for "\n\n" separator
  }

  let fullText = assembledBlocks.join('\n\n').trim();
  if (!fullText && unstructuredFallback) {
    fullText = unstructuredFallback.slice(0, maxCharsPerArticle).trim();
  }

  if (!fullText || fullText.length < 80) {
    return { hasFullText: false };
  }

  return {
    hasFullText: true,
    fullText,
    fullTextSections
  };
}

/**
 * Resolves a batch of PubMed IDs (PMIDs) to PubMed Central IDs (PMCIDs)
 * via the official NCBI ID Converter API.
 */
export async function resolvePmcIds(pmids: string[]): Promise<Record<string, string>> {
  const uniquePmids = Array.from(
    new Set(pmids.map(p => String(p || '').trim()).filter(p => /^\d+$/.test(p)))
  );
  if (uniquePmids.length === 0) return {};

  const pmidToPmcid: Record<string, string> = {};
  const uncachedPmids: string[] = [];

  for (const pmid of uniquePmids) {
    const cached = apiCache.get<{ pmcid: string | null }>(`pmc:idconv:${pmid}`);
    if (cached !== undefined) {
      if (cached.pmcid) {
        pmidToPmcid[pmid] = cached.pmcid;
      }
    } else {
      uncachedPmids.push(pmid);
    }
  }

  if (uncachedPmids.length === 0) {
    return pmidToPmcid;
  }

  const { apiKey, email } = getNcbiCredentials();
  const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';

  // NCBI ID Converter API accepts up to 200 IDs per batch
  const BATCH_SIZE = 150;
  for (let i = 0; i < uncachedPmids.length; i += BATCH_SIZE) {
    const batch = uncachedPmids.slice(i, i + BATCH_SIZE);
    try {
      await waitForNcbiPmcRateLimit();
      const url = `${NCBI_ID_CONVERTER_URL}?ids=${batch.join(',')}&format=json&tool=${TOOL_NAME}&email=${encodeURIComponent(email)}${keyParam}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': `${TOOL_NAME}/1.0 (mailto:${email})`
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        console.warn(`[pmcFullTextService] ID Converter HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as { records?: any[] };
      const records = Array.isArray(data?.records) ? data.records : [];
      const resolvedInBatch = new Set<string>();
      for (const rec of records) {
        if (rec && rec.pmcid && rec.status !== 'error') {
          const requestedId = String(rec['requested-id'] || rec.pmid || '').trim();
          const pmcid = String(rec.pmcid).trim();
          if (requestedId && /^PMC\d+$/i.test(pmcid)) {
            const upperPmc = pmcid.toUpperCase();
            pmidToPmcid[requestedId] = upperPmc;
            resolvedInBatch.add(requestedId);
            apiCache.set(`pmc:idconv:${requestedId}`, { pmcid: upperPmc });
          }
        }
      }
      // Negatively cache non-PMC PMIDs from successful API batches for 24h to avoid redundant hits
      for (const pmid of batch) {
        if (!resolvedInBatch.has(pmid)) {
          apiCache.set(`pmc:idconv:${pmid}`, { pmcid: null });
        }
      }
    } catch (err) {
      console.warn('[pmcFullTextService] resolvePmcIds batch warning:', err instanceof Error ? err.message : err);
    }
  }

  return pmidToPmcid;
}

/**
 * Enriches an array of PMIDs with open-access PMC full-text XML parsed into
 * structured clinical sections (`methods`, `results`, `tables`, `discussion`)
 * and a prioritized `fullText` string capped at `maxCharsPerArticle`.
 *
 * Strictly complies with NCBI Entrez Usage Guidelines (NBK25497) and 24h apiCache.
 * Gracefully handles paywalled, non-PMC, or HTTP-failed articles with `hasFullText: false`.
 */
export async function enrichArticlesWithFullText(
  pmids: string[],
  maxCharsPerArticle = 14000
): Promise<Record<string, PmcEnrichmentResult>> {
  const uniquePmids = Array.from(
    new Set(pmids.map(p => String(p || '').trim()).filter(p => /^\d+$/.test(p)))
  );

  const results: Record<string, PmcEnrichmentResult> = {};
  for (const pmid of uniquePmids) {
    results[pmid] = { pmid, hasFullText: false };
  }

  if (uniquePmids.length === 0) return results;

  // 1. Batch-map PMIDs -> PMCIDs (backed by 24h TTL cache)
  const pmidToPmcid = await resolvePmcIds(uniquePmids);
  const pmcidToPmid: Record<string, string> = {};
  const pmcIdsToFetch: string[] = [];

  for (const [pmid, pmcid] of Object.entries(pmidToPmcid)) {
    const upperPmc = pmcid.toUpperCase();
    const cachedArticle = apiCache.get<PmcEnrichmentResult>(`pmc:efetch:${upperPmc}:${maxCharsPerArticle}`);
    if (cachedArticle) {
      results[pmid] = { ...cachedArticle, pmid, pmcid: cachedArticle.pmcid || upperPmc };
      continue;
    }

    results[pmid] = { pmid, pmcid: upperPmc, hasFullText: false };
    pmcidToPmid[upperPmc] = pmid;
    pmcIdsToFetch.push(upperPmc);
  }

  if (pmcIdsToFetch.length === 0) {
    return results;
  }

  // 2. Batch-fetch full-text XML via Entrez efetch (db=pmc, retmode=xml)
  // Using small batches (5 PMCIDs/request) keeps XML payloads fast and reliable
  const EFETCH_BATCH_SIZE = 5;
  const { apiKey, email } = getNcbiCredentials();
  const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';

  for (let i = 0; i < pmcIdsToFetch.length; i += EFETCH_BATCH_SIZE) {
    const pmcBatch = pmcIdsToFetch.slice(i, i + EFETCH_BATCH_SIZE);
    try {
      await waitForNcbiPmcRateLimit();
      const efetchUrl = `${NCBI_EFETCH_URL}?db=pmc&id=${pmcBatch.join(',')}&retmode=xml&tool=${TOOL_NAME}&email=${encodeURIComponent(email)}${keyParam}`;
      const res = await fetch(efetchUrl, {
        headers: {
          'Accept': 'application/xml,text/xml',
          'User-Agent': `${TOOL_NAME}/1.0 (mailto:${email})`
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!res.ok) {
        console.warn(`[pmcFullTextService] PMC efetch HTTP ${res.status} for batch ${pmcBatch.join(',')}`);
        continue;
      }

      const xmlText = await res.text();
      if (!xmlText || !xmlText.includes('<article')) {
        continue;
      }

      const cachedInBatch = new Set<string>();
      const articleMatches = xmlText.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi);
      for (const artMatch of articleMatches) {
        const articleXml = artMatch[0];
        if (!articleXml) continue;

        const pmidMatch = articleXml.match(/<article-id\b[^>]*pub-id-type\s*=\s*["']pmid["'][^>]*>(\d+)<\/article-id>/i);
        const pmcidMatch = articleXml.match(/<article-id\b[^>]*pub-id-type\s*=\s*["'](?:pmcid|pmc)["'][^>]*>(?:PMC)?(\d+)<\/article-id>/i);

        const parsedPmid = pmidMatch ? pmidMatch[1].trim() : undefined;
        const parsedPmcid = pmcidMatch ? `PMC${pmcidMatch[1].trim()}` : undefined;

        const targetPmid =
          (parsedPmid && results[parsedPmid] ? parsedPmid : undefined) ||
          (parsedPmcid ? pmcidToPmid[parsedPmcid] : undefined);

        if (!targetPmid) continue;

        const resolvedPmcid = parsedPmcid || results[targetPmid].pmcid;
        const parsed = parsePmcArticleXml(articleXml, maxCharsPerArticle);
        if (parsed.hasFullText && parsed.fullText) {
          const enrichedObj: PmcEnrichmentResult = {
            pmid: targetPmid,
            pmcid: resolvedPmcid,
            hasFullText: true,
            fullText: parsed.fullText,
            fullTextSections: parsed.fullTextSections
          };
          results[targetPmid] = enrichedObj;
          if (resolvedPmcid) {
            apiCache.set(`pmc:efetch:${resolvedPmcid.toUpperCase()}:${maxCharsPerArticle}`, enrichedObj);
            cachedInBatch.add(resolvedPmcid.toUpperCase());
          }
        } else if (resolvedPmcid) {
          const emptyObj: PmcEnrichmentResult = {
            pmid: targetPmid,
            pmcid: resolvedPmcid,
            hasFullText: false
          };
          apiCache.set(`pmc:efetch:${resolvedPmcid.toUpperCase()}:${maxCharsPerArticle}`, emptyObj);
          cachedInBatch.add(resolvedPmcid.toUpperCase());
        }
      }

      // Negatively cache any PMCID in batch whose XML had no extractable body
      for (const reqPmcid of pmcBatch) {
        if (!cachedInBatch.has(reqPmcid)) {
          const pmid = pmcidToPmid[reqPmcid];
          if (pmid) {
            apiCache.set(`pmc:efetch:${reqPmcid}:${maxCharsPerArticle}`, {
              pmid,
              pmcid: reqPmcid,
              hasFullText: false
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[pmcFullTextService] PMC efetch batch warning (${pmcBatch.join(',')}):`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

export const pmcFullTextService = {
  resolvePmcIds,
  enrichArticlesWithFullText,
  parsePmcArticleXml,
  stripPmcXmlMarkup
};
