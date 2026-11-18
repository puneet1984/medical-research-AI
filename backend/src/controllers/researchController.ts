import { Request, Response } from 'express';
import { expandQuery } from '../agents/queryAgent.js';
import {
  searchAllAvailableStudies,
  searchMedicalLiterature,
  filterAndRankByClinicalRelevance,
  MedicalDocument
} from '../services/searchService.js';
import { upsertDocuments, searchSimilar, findCachedSimilar, getVectorStatus, initQdrant } from '../services/vectorService.js';
import { synthesizeLiterature } from '../agents/synthesisAgent.js';
import { deduplicateAndMergeStudies } from '../utils/deduplicateStudies.js';
import { fetchRelatedAndCitingArticles } from '../services/pubmedLinkService.js';
import { generateLocalEmbedding, cosineSimilarity } from '../services/embeddingService.js';

interface SessionQueryStudies {
  query: string;
  allStudies: MedicalDocument[];
  createdAt: number;
}
const sessionStudyRegistry = new Map<string, SessionQueryStudies>();

function computeTrueSimilarityScore(doc: MedicalDocument, queryVector: number[]): number {
  const rawAbstract = (doc.abstract || '').trim();
  const hasMeaningfulAbstract =
    (rawAbstract.length >= 25 && !/^abstract not reported/i.test(rawAbstract)) ||
    Boolean(doc.hasFullText && doc.fullText && doc.fullText.trim().length >= 50);

  const docText = hasMeaningfulAbstract
    ? `${doc.title || ''} ${rawAbstract} ${doc.fullText ? doc.fullText.slice(0, 2500) : ''}`.trim()
    : (doc.title || '').trim();

  if (!docText) return 0.05;
  const docVec = generateLocalEmbedding(docText, queryVector.length);
  const rawSim = Math.max(0, cosineSimilarity(queryVector, docVec));
  const penalized = hasMeaningfulAbstract ? rawSim : rawSim * 0.65;
  return Math.round(Math.min(0.99, Math.max(0.01, penalized)) * 10000) / 10000;
}

function compareByRelevanceThenRecency(a: MedicalDocument, b: MedicalDocument): number {
  const scoreDiff = (b.score || 0) - (a.score || 0);
  if (Math.abs(scoreDiff) > 0.002) return scoreDiff;
  if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
  return (b.citationCount || 0) - (a.citationCount || 0);
}

export async function handleSearchAndIndex(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  try {
    const { query, filters, limit = 0, retrieveAll = true } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const trimmedQuery = query.trim();
    const shouldRetrieveAll = retrieveAll !== false && (!limit || Number(limit) <= 0);
    const searchLimit = shouldRetrieveAll ? 500 : Math.max(15, Number(limit) || 200);

    // 0. Vector Cache Check: Rapid pre-indexed vector lookup with high similarity threshold (0.78)
    const rawCachedHits = await findCachedSimilar(trimmedQuery, 0.78, Math.min(searchLimit, 200));
    const cachedVectorHits = filterAndRankByClinicalRelevance(rawCachedHits.map(c => c.document), trimmedQuery);

    // 1. Agentic Step 1: Dynamic Query Expansion (NLM MetaMap & LLM)
    const expansion = await expandQuery(trimmedQuery);

    // 2. Agentic Step 2: Multi-Database Bulk Retrieval across PubMed, OpenAlex, Crossref, DOAJ
    const { allStudies: rawDocuments, totalAvailable } = await searchAllAvailableStudies(trimmedQuery, 500, 0);

    // Combine cached vector studies with live fetched documents, deduplicating & merging across PubMed, registries, and scholarly DBs
    const queryVector = generateLocalEmbedding(trimmedQuery, 384);
    const combinedPool = deduplicateAndMergeStudies([...cachedVectorHits, ...rawDocuments]).map(d => ({
      ...d,
      score: typeof d.score === 'number' && d.score > 0 ? d.score : computeTrueSimilarityScore(d, queryVector)
    }));

    // Order all available studies primarily by clinical relevance (similarity descending), then recency
    combinedPool.sort(compareByRelevanceThenRecency);

    // Save in session registry for on-demand lazy hydration and pagination ("load more")
    sessionStudyRegistry.set(trimmedQuery.toLowerCase(), {
      query: trimmedQuery,
      allStudies: combinedPool,
      createdAt: Date.now()
    });

    // Apply any initial user study filters if specified
    let filteredDocuments = combinedPool;
    if (filters) {
      if (typeof filters.minSample === 'number' && filters.minSample > 0) {
        filteredDocuments = filteredDocuments.filter(d => (d.pico?.sampleSize || 0) >= filters.minSample);
      }
      if (Array.isArray(filters.designs) && filters.designs.length > 0) {
        filteredDocuments = filteredDocuments.filter(d => filters.designs.includes(d.pico?.design));
      }
      if (typeof filters.yearFrom === 'number' && filters.yearFrom > 1900) {
        filteredDocuments = filteredDocuments.filter(d => typeof d.year === 'number' && d.year >= filters.yearFrom);
      }
      if (Array.isArray(filters.sourceDatabases) && filters.sourceDatabases.length > 0) {
        filteredDocuments = filteredDocuments.filter(d => filters.sourceDatabases.includes(d.source));
      }
    }

    const availablePool = filteredDocuments.length > 0 ? filteredDocuments : combinedPool;

    // Return all available studies when retrieveAll is active, otherwise slice to requested limit
    const initialBatch = shouldRetrieveAll ? availablePool : availablePool.slice(0, searchLimit);

    // 3. Agentic Step 3: Vector Embedding & Persistent Storage with Rolling FIFO checks
    const upsertResult = await upsertDocuments(initialBatch);

    // 4. Agentic Step 4: Semantic Vector Ranking
    const rankedResults = await searchSimilar(trimmedQuery, Math.max(initialBatch.length, 40));

    // Ensure all items in initialBatch carry uniform 384-d real similarity scores across every source (never a flat 0.75 fallback)
    const finalDocuments: MedicalDocument[] = initialBatch.map(doc => {
      const hit = rankedResults.find(r => r.document.id === doc.id || (doc.doi && r.document.doi === doc.doi));
      const trueScore =
        typeof doc.score === 'number' && doc.score > 0
          ? doc.score
          : (hit && typeof hit.score === 'number' && hit.score > 0 ? hit.score : computeTrueSimilarityScore(doc, queryVector));
      return {
        ...doc,
        score: trueScore
      };
    });

    // Sort extracted sources primarily by Relevance Score (sim descending), tie-breaking by Year descending
    finalDocuments.sort(compareByRelevanceThenRecency);

    // User-Requested Behavior: Do NOT autogenerate clinical report in the initial pipeline.
    // Execute MeSH & UMLS query expansion, multi-database retrieval, and PICO data matrix extraction.
    // The user triggers clinical report synthesis on-demand via the UI.
    const synthesis = null;

    const durationMs = Date.now() - startTime;
    const totalRetrieved = Math.max(availablePool.length, totalAvailable);

    res.json({
      success: true,
      query: trimmedQuery,
      expansion,
      documents: finalDocuments,
      totalAvailableStudies: totalRetrieved,
      totalRetrievedStudies: totalRetrieved,
      currentOffset: finalDocuments.length,
      hasMore: availablePool.length > finalDocuments.length,
      nextOffset: finalDocuments.length,
      synthesis,
      vectorStatus: {
        ...getVectorStatus(),
        upsertMode: upsertResult.mode,
        cachedVectorHits: cachedVectorHits.length,
        vectorAcceleration: cachedVectorHits.length > 0 ? 'Vector Cache Hit (Sub-10ms)' : 'Live Multidisciplinary Fetch',
        evictedCount: upsertResult.evicted
      },
      durationMs,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[researchController] Search & Index error:', err);
    res.status(500).json({
      error: 'Failed to process clinical research search',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Lazy hydration pagination endpoint: loads the next batch of studies on user demand
 */
export async function handleLoadMoreStudies(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  try {
    const { query, offset = 0, batchSize = 40, filters } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const trimmedQuery = query.trim().toLowerCase();
    let session = sessionStudyRegistry.get(trimmedQuery);

    if (!session || !session.allStudies || session.allStudies.length === 0) {
      // Re-fetch pool if session expired
      const { allStudies } = await searchAllAvailableStudies(query.trim(), 160, 0);
      session = { query: query.trim(), allStudies, createdAt: Date.now() };
      sessionStudyRegistry.set(trimmedQuery, session);
    }

    const currentOffset = Math.max(0, Number(offset) || 0);
    const size = Math.max(10, Number(batchSize) || 40);

    let pool = session.allStudies;

    const queryVector = generateLocalEmbedding(query.trim(), 384);

    // Check if remaining in pool is less than requested batch size
    const remainingInPool = pool.length - currentOffset;
    if (remainingInPool < size) {
      // Dynamically fetch next batch of 40-80 studies from live scholarly APIs with offset!
      try {
        const fetchAmount = Math.max(60, size * 2);
        console.log(`[researchController] Fetching next ${fetchAmount} studies from live scholarly APIs with offset ${currentOffset}...`);
        const { allStudies: nextLiveStudies } = await searchAllAvailableStudies(query.trim(), fetchAmount, currentOffset);

        if (nextLiveStudies && nextLiveStudies.length > 0) {
          const prevCount = pool.length;
          pool = deduplicateAndMergeStudies([...pool, ...nextLiveStudies]).map(d => ({
            ...d,
            score: typeof d.score === 'number' && d.score > 0 ? d.score : computeTrueSimilarityScore(d, queryVector)
          }));
          if (pool.length > prevCount) {
            pool.sort(compareByRelevanceThenRecency);
            session.allStudies = pool;
            sessionStudyRegistry.set(trimmedQuery, session);
            console.log(`[researchController] Added ${pool.length - prevCount} new unique studies to session pool. Total pool: ${pool.length}`);
          }
        }
      } catch (liveFetchErr) {
        console.warn('[researchController] Live fetch during pagination warning:', liveFetchErr);
      }
    }

    if (filters) {
      if (typeof filters.minSample === 'number' && filters.minSample > 0) {
        pool = pool.filter(d => (d.pico?.sampleSize || 0) >= filters.minSample);
      }
      if (Array.isArray(filters.designs) && filters.designs.length > 0) {
        pool = pool.filter(d => filters.designs.includes(d.pico?.design));
      }
      if (typeof filters.yearFrom === 'number' && filters.yearFrom > 1900) {
        pool = pool.filter(d => typeof d.year === 'number' && d.year >= filters.yearFrom);
      }
      if (Array.isArray(filters.sourceDatabases) && filters.sourceDatabases.length > 0) {
        pool = pool.filter(d => filters.sourceDatabases.includes(d.source));
      }
    }

    const batch = pool.slice(currentOffset, currentOffset + size).map(d => ({
      ...d,
      score: typeof d.score === 'number' && d.score > 0 ? d.score : computeTrueSimilarityScore(d, queryVector)
    }));

    // Vector embed and upsert this next batch into vector storage with rolling FIFO checks
    const upsertResult = await upsertDocuments(batch);

    // Keep ordered primarily by Relevance (score descending)
    batch.sort(compareByRelevanceThenRecency);

    const newNextOffset = currentOffset + batch.length;
    // Allow more if pool has more OR if batch returned full size (live APIs can provide even more)
    const hasMore = newNextOffset < pool.length || batch.length >= size;

    res.json({
      success: true,
      query: query.trim(),
      newDocuments: batch,
      totalAvailableStudies: pool.length,
      currentOffset: newNextOffset,
      hasMore,
      nextOffset: newNextOffset,
      vectorStatus: {
        ...getVectorStatus(),
        upsertMode: upsertResult.mode,
        evictedCount: upsertResult.evicted
      },
      durationMs: Date.now() - startTime
    });
  } catch (err) {
    console.error('[researchController] Load more error:', err);
    res.status(500).json({ error: 'Failed to load more studies', details: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleVectorSearch(req: Request, res: Response): Promise<void> {
  try {
    const { query, limit = 8 } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const results = await searchSimilar(query.trim(), Number(limit));
    res.json({
      success: true,
      query,
      results,
      vectorStatus: getVectorStatus()
    });
  } catch (err) {
    console.error('[researchController] Vector search error:', err);
    res.status(500).json({ error: 'Failed to perform vector similarity search' });
  }
}

export function handleVectorStatus(_req: Request, res: Response): void {
  res.json({
    success: true,
    status: getVectorStatus()
  });
}

export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'MedResearch AI Engine'
  });
}

import { extractMetaMapLiteConcepts } from '../services/metaMapLiteService.js';

export async function handleMetaMapExtract(req: Request, res: Response): Promise<void> {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const result = await extractMetaMapLiteConcepts(query.trim());
    res.json({
      success: true,
      result
    });
  } catch (err) {
    console.error('[researchController] MetaMapLite extraction error:', err);
    res.status(500).json({
      error: 'Failed to extract MetaMapLite concepts',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

// -------------------------------------------------------------
// Settings & Runtime Configuration Handlers
// -------------------------------------------------------------

import { getSanitizedConfig, updateRuntimeConfig, config } from '../config.js';
import { testConnection, fetchOpenRouterModels, resetGeminiClient } from '../services/openRouterService.js';
import { getActiveEmbeddingInfo, setEmbeddingDimension } from '../services/embeddingService.js';
import {
  generatePaperDraft,
  transformSection
} from '../services/paperDraftService.js';

export function handleGetSettings(_req: Request, res: Response): void {
  res.json({
    success: true,
    settings: getSanitizedConfig()
  });
}

export function handleUpdateSettings(req: Request, res: Response): void {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'Settings object required' });
      return;
    }

    const updated = updateRuntimeConfig(updates);

    // If embedding provider or models changed, dynamically re-calculate dimension
    if (
      updates.embeddingProvider !== undefined ||
      updates.geminiEmbeddingModel !== undefined ||
      updates.openRouterEmbeddingModel !== undefined ||
      updates.huggingFaceEmbeddingModel !== undefined ||
      updates.ollamaEmbeddingModel !== undefined
    ) {
      const activeEmb = getActiveEmbeddingInfo();
      setEmbeddingDimension(activeEmb.dimension);
      console.log(`[researchController] Synchronized vector dimension for active model (${activeEmb.provider}/${activeEmb.model}): ${activeEmb.dimension}-d`);
    }

    if (updates.geminiApiKey !== undefined) {
      resetGeminiClient();
    }

    // If Qdrant or embedding provider settings changed, re-initialize vector connection in background
    if (
      updates.qdrantUrl !== undefined ||
      updates.qdrantApiKey !== undefined ||
      updates.qdrantInferenceModel !== undefined ||
      updates.qdrantUseCloudInference !== undefined ||
      updates.embeddingProvider !== undefined
    ) {
      initQdrant().catch(err => {
        console.warn('[researchController] Qdrant re-init notice:', err);
      });
    }

    console.log(`[researchController] Settings & models updated. Reasoning: "${config.llmReasoningModel}", Synthesis: "${config.llmSynthesisModel}", Provider: "${config.llmProvider}"`);

    res.json({
      success: true,
      message: 'Runtime environment settings successfully applied',
      settings: getSanitizedConfig()
    });
  } catch (err) {
    console.error('[researchController] Update settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
}

export async function handleGetOpenRouterModels(req: Request, res: Response): Promise<void> {
  try {
    const refresh = req.query.refresh === 'true';
    const modality = typeof req.query.modality === 'string' ? req.query.modality : undefined;
    const variant = typeof req.query.variant === 'string' ? req.query.variant : undefined;

    const data = await fetchOpenRouterModels(refresh);

    let filtered = data.all;
    if (modality === 'embeddings') {
      filtered = variant === 'free' ? data.freeEmbeddings : data.allEmbeddings;
    } else if (modality === 'text') {
      filtered = variant === 'free' ? data.freeText : data.allText;
    } else if (variant === 'free') {
      filtered = filtered.filter(m => m.isFree);
    }

    res.json({
      success: true,
      count: filtered.length,
      models: filtered,
      categories: {
        freeText: data.freeText,
        allText: data.allText,
        freeEmbeddings: data.freeEmbeddings,
        allEmbeddings: data.allEmbeddings,
        reasoning: data.reasoning
      }
    });
  } catch (err) {
    console.error('[researchController] Get OpenRouter models error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch OpenRouter models',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function handleTestConnection(req: Request, res: Response): Promise<void> {
  try {
    const { target, params } = req.body;
    if (!target) {
      res.status(400).json({ error: 'Target service required (ollama, omniroute, openrouter, gemini, huggingface, qdrant, ncbi)' });
      return;
    }

    const result = await testConnection(target, params);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Connection test failed'
    });
  }
}

// -------------------------------------------------------------
// AI Editor & Writer Handlers
// -------------------------------------------------------------

export async function handleGeneratePaperDraft(req: Request, res: Response): Promise<void> {
  try {
    const {
      researchQuestion,
      targetJournal,
      targetDatabases,
      citationStyle,
      mode,
      clinicalEvidence,
      retrievalStats
    } = req.body;

    if (!researchQuestion || typeof researchQuestion !== 'string' || !researchQuestion.trim()) {
      res.status(400).json({ error: 'researchQuestion is required' });
      return;
    }

    const trimmedQuestion = researchQuestion.trim();
    const session = sessionStudyRegistry.get(trimmedQuestion.toLowerCase());
    const resolvedEvidence: MedicalDocument[] =
      Array.isArray(clinicalEvidence) && clinicalEvidence.length > 0
        ? clinicalEvidence
        : (session?.allStudies || []);

    const vectorStatus = getVectorStatus();
    const mergedStats = {
      ...(retrievalStats && typeof retrievalStats === 'object' ? retrievalStats : {}),
      totalIndexed: Math.max(
        Number(retrievalStats?.totalIndexed) || 0,
        session?.allStudies?.length || 0,
        vectorStatus?.totalIndexed || 0,
        resolvedEvidence.length
      ),
      uniqueIncluded: resolvedEvidence.length
    };

    const draft = await generatePaperDraft({
      researchQuestion: trimmedQuestion,
      targetJournal,
      targetDatabases,
      citationStyle,
      mode,
      clinicalEvidence: resolvedEvidence,
      retrievalStats: mergedStats
    });

    res.json({
      success: true,
      draft,
      groundingVerification: draft.groundingVerification
    });
  } catch (err) {
    console.error('[researchController] Paper draft generation error:', err);
    res.status(500).json({
      error: 'Failed to generate paper draft',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function handleSectionAction(req: Request, res: Response): Promise<void> {
  try {
    const {
      action,
      sectionTitle,
      sectionType,
      sectionContent,
      researchQuestion,
      targetJournal,
      citationStyle,
      customPrompt,
      clinicalEvidence,
      retrievalStats
    } = req.body;

    if (!action || !sectionContent) {
      res.status(400).json({ error: 'action and sectionContent are required' });
      return;
    }

    const trimmedQuestion = typeof researchQuestion === 'string' ? researchQuestion.trim() : '';
    const session = trimmedQuestion ? sessionStudyRegistry.get(trimmedQuestion.toLowerCase()) : undefined;
    const resolvedEvidence: MedicalDocument[] =
      Array.isArray(clinicalEvidence) && clinicalEvidence.length > 0
        ? clinicalEvidence
        : (session?.allStudies || []);

    const vectorStatus = getVectorStatus();
    const mergedStats = {
      ...(retrievalStats && typeof retrievalStats === 'object' ? retrievalStats : {}),
      totalIndexed: Math.max(
        Number(retrievalStats?.totalIndexed) || 0,
        session?.allStudies?.length || 0,
        vectorStatus?.totalIndexed || 0,
        resolvedEvidence.length
      ),
      uniqueIncluded: resolvedEvidence.length
    };

    const result = await transformSection({
      action,
      sectionTitle: sectionTitle || 'Clinical Section',
      sectionType,
      sectionContent,
      researchQuestion: trimmedQuestion,
      targetJournal,
      citationStyle,
      customPrompt,
      clinicalEvidence: resolvedEvidence,
      retrievalStats: mergedStats
    });

    res.json({
      success: true,
      result,
      groundingVerification: result.groundingVerification
    });
  } catch (err) {
    console.error('[researchController] Section action error:', err);
    res.status(500).json({
      error: 'Failed to transform section',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function handleSynthesizeReport(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  try {
    const { query, documents } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const trimmedQuery = query.trim();
    const candidateDocs: MedicalDocument[] = Array.isArray(documents) && documents.length > 0
      ? documents
      : (sessionStudyRegistry.get(trimmedQuery.toLowerCase())?.allStudies || []);

    if (candidateDocs.length === 0) {
      res.status(400).json({ error: 'No clinical documents available to synthesize. Please search literature first.' });
      return;
    }

    const synthesis = await synthesizeLiterature(trimmedQuery, candidateDocs);

    res.json({
      success: true,
      query: trimmedQuery,
      synthesis,
      durationMs: Date.now() - startTime
    });
  } catch (err) {
    console.error('[researchController] Clinical report synthesis error:', err);
    res.status(500).json({
      error: 'Failed to synthesize clinical report',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function handleGetRelatedArticles(req: Request, res: Response): Promise<void> {
  try {
    const pmid = String(req.params.pmid || '').trim();
    if (!/^\d+$/.test(pmid)) {
      res.status(400).json({ error: 'Valid numeric PMID parameter is required' });
      return;
    }

    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));
    const result = await fetchRelatedAndCitingArticles(pmid, limit);

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('[researchController] Related articles lookup error:', err);
    res.status(500).json({
      error: 'Failed to fetch related and citing PubMed articles',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

export const researchController = {
  handleSearchAndIndex,
  handleSynthesizeReport,
  handleVectorSearch,
  handleVectorStatus,
  handleHealth,
  handleMetaMapExtract,
  handleGetSettings,
  handleUpdateSettings,
  handleGetOpenRouterModels,
  handleTestConnection,
  handleGeneratePaperDraft,
  handleSectionAction,
  handleGetRelatedArticles
};
