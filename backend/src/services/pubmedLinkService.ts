import { config } from '../config.js';
import { apiCache } from '../utils/apiCache.js';
import { decodeHtmlEntities, sanitizeDoi, sanitizeJournalField } from './corpusContextBuilder.js';

const NCBI_ELINK_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi';
const NCBI_ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const TOOL_NAME = 'MedResearchAI';

export interface LinkedPubMedArticle {
  pmid: string;
  title: string;
  firstAuthor: string;
  journal: string;
  year: number;
  doi: string;
  webUrl: string;
}

export interface RelatedArticlesResult {
  pmid: string;
  relatedPmids: string[];
  citingPmids: string[];
  relatedArticles: LinkedPubMedArticle[];
  citingArticles: LinkedPubMedArticle[];
  cached: boolean;
}

let lastLinkRequestTime = 0;
function getNcbiCredentials(): { apiKey: string; email: string } {
  const apiKey = (process.env.NCBI_API_KEY || config.ncbiApiKey || '').trim();
  const email = (process.env.SCHOLARLY_USER_AGENT_EMAIL || config.scholarlyEmail || 'researcher@domain.com').trim();
  return { apiKey, email };
}

async function waitForNcbiRateLimit(): Promise<void> {
  const { apiKey } = getNcbiCredentials();
  const minIntervalMs = apiKey ? 115 : 360;
  const now = Date.now();
  const elapsed = now - lastLinkRequestTime;
  if (elapsed < minIntervalMs) {
    await new Promise(resolve => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastLinkRequestTime = Date.now();
}

async function queryElink(pmid: string, linkname: 'pubmed_pubmed' | 'pubmed_pubmed_citedin', limit: number): Promise<string[]> {
  const cleanPmid = String(pmid || '').trim();
  if (!/^\d+$/.test(cleanPmid)) return [];

  const cappedLimit = Math.min(30, Math.max(1, limit));
  const cacheKey = `ncbi:elink:${linkname}:${cleanPmid}:${cappedLimit}`;

  const { value } = await apiCache.getOrFetch<string[]>(
    cacheKey,
    async () => {
      await waitForNcbiRateLimit();
      const { apiKey, email } = getNcbiCredentials();
      const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
      const url = `${NCBI_ELINK_URL}?dbfrom=pubmed&db=pubmed&id=${encodeURIComponent(cleanPmid)}&linkname=${linkname}&retmode=json&tool=${TOOL_NAME}&email=${encodeURIComponent(email)}${keyParam}`;

      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': `${TOOL_NAME}/1.0 (mailto:${email})`
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        console.warn(`[pubmedLinkService] elink HTTP ${res.status} (${linkname} for PMID ${cleanPmid})`);
        return [];
      }

      const data = (await res.json()) as any;
      const linksets: any[] = Array.isArray(data?.linksets) ? data.linksets : [];
      const collected: string[] = [];
      const seen = new Set<string>([cleanPmid]);

      for (const ls of linksets) {
        const dbs: any[] = Array.isArray(ls?.linksetdbs) ? ls.linksetdbs : [];
        for (const db of dbs) {
          if (db?.linkname && db.linkname !== linkname) continue;
          const links: any[] = Array.isArray(db?.links) ? db.links : [];
          for (const rawLink of links) {
            const idStr = String(typeof rawLink === 'object' && rawLink !== null ? rawLink.id : rawLink).trim();
            if (/^\d+$/.test(idStr) && !seen.has(idStr)) {
              seen.add(idStr);
              collected.push(idStr);
              if (collected.length >= cappedLimit) break;
            }
          }
          if (collected.length >= cappedLimit) break;
        }
      }

      return collected;
    },
    { shouldCache: (ids) => Array.isArray(ids) }
  );

  return value;
}

/**
 * Fetches PubMed IDs of similar/related articles using NCBI `elink` (`linkname=pubmed_pubmed`).
 */
export async function fetchRelatedPmids(pmid: string, limit = 10): Promise<string[]> {
  try {
    return await queryElink(pmid, 'pubmed_pubmed', limit);
  } catch (err) {
    console.warn(`[pubmedLinkService] fetchRelatedPmids(${pmid}) notice:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetches PubMed IDs of citing articles using NCBI `elink` (`linkname=pubmed_pubmed_citedin`).
 */
export async function fetchCitingPmids(pmid: string, limit = 10): Promise<string[]> {
  try {
    return await queryElink(pmid, 'pubmed_pubmed_citedin', limit);
  } catch (err) {
    console.warn(`[pubmedLinkService] fetchCitingPmids(${pmid}) notice:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Hydrates lightweight article summaries for a list of PMIDs via NCBI `esummary.fcgi` (cached 24h).
 */
async function hydratePmidSummaries(pmids: string[]): Promise<Record<string, LinkedPubMedArticle>> {
  const unique = Array.from(new Set(pmids.map(p => p.trim()).filter(p => /^\d+$/.test(p)))).slice(0, 20);
  if (unique.length === 0) return {};

  const cacheKey = `ncbi:esummary:${unique.join(',')}`;
  const { value } = await apiCache.getOrFetch<Record<string, LinkedPubMedArticle>>(
    cacheKey,
    async () => {
      await waitForNcbiRateLimit();
      const { apiKey, email } = getNcbiCredentials();
      const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
      const url = `${NCBI_ESUMMARY_URL}?db=pubmed&id=${unique.join(',')}&retmode=json&tool=${TOOL_NAME}&email=${encodeURIComponent(email)}${keyParam}`;

      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': `${TOOL_NAME}/1.0 (mailto:${email})`
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) return {};
      const data = (await res.json()) as any;
      const result = data?.result || {};
      const out: Record<string, LinkedPubMedArticle> = {};

      for (const uid of unique) {
        const item = result[uid];
        if (!item || typeof item !== 'object') continue;
        const title = decodeHtmlEntities(String(item.title || `PubMed Article ${uid}`).replace(/\.$/, ''));
        const firstAuthor = decodeHtmlEntities(String(item.authors?.[0]?.name || ''));
        const journal = sanitizeJournalField(item.fulljournalname || item.source || 'PubMed Indexed Journal');
        const yearMatch = String(item.pubdate || '').match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : new Date().getFullYear();

        let doi = '';
        if (Array.isArray(item.articleids)) {
          const dObj = item.articleids.find((id: any) => id?.idtype === 'doi');
          if (dObj?.value) doi = sanitizeDoi(String(dObj.value));
        }

        out[uid] = {
          pmid: uid,
          title,
          firstAuthor,
          journal,
          year,
          doi,
          webUrl: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`
        };
      }
      return out;
    },
    { shouldCache: (map) => Object.keys(map).length > 0 }
  );

  return value;
}

/**
 * Retrieves both related (`pubmed_pubmed`) and citing (`pubmed_pubmed_citedin`) articles
 * with lightweight hydrated metadata for UI citation network expansion.
 */
export async function fetchRelatedAndCitingArticles(pmid: string, limit = 10): Promise<RelatedArticlesResult> {
  const cleanPmid = String(pmid || '').trim();
  const compositeCacheKey = `ncbi:related-bundle:${cleanPmid}:${limit}`;
  const cachedHit = apiCache.get<RelatedArticlesResult>(compositeCacheKey);
  if (cachedHit) {
    return { ...cachedHit, cached: true };
  }

  const relatedPmids = await fetchRelatedPmids(cleanPmid, limit);
  const citingPmids = await fetchCitingPmids(cleanPmid, limit);
  const summaries = await hydratePmidSummaries([...relatedPmids, ...citingPmids]);

  const toArticle = (id: string): LinkedPubMedArticle =>
    summaries[id] || {
      pmid: id,
      title: `PubMed Record PMID:${id}`,
      firstAuthor: '',
      journal: 'PubMed',
      year: new Date().getFullYear(),
      doi: '',
      webUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
    };

  const bundle: RelatedArticlesResult = {
    pmid: cleanPmid,
    relatedPmids,
    citingPmids,
    relatedArticles: relatedPmids.map(toArticle),
    citingArticles: citingPmids.map(toArticle),
    cached: false
  };

  if (relatedPmids.length > 0 || citingPmids.length > 0) {
    apiCache.set(compositeCacheKey, bundle);
  }
  return bundle;
}

export const pubmedLinkService = {
  fetchRelatedPmids,
  fetchCitingPmids,
  fetchRelatedAndCitingArticles
};
