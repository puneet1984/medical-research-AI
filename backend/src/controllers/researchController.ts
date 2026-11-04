import { Request, Response } from 'express';
import { expandQuery } from '../agents/queryAgent.js';
import { searchAllAvailableStudies, searchMedicalLiterature, MedicalDocument } from '../services/searchService.js';
import { upsertDocuments, searchSimilar, findCachedSimilar, getVectorStatus, initQdrant } from '../services/vectorService.js';
import { synthesizeLiterature } from '../agents/synthesisAgent.js';

interface SessionQueryStudies {
  query: string;
  allStudies: MedicalDocument[];
  createdAt: number;
}
const sessionStudyRegistry = new Map<string, SessionQueryStudies>();

export async function handleSearchAndIndex(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  try {
    const { query, filters, limit = 28 } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const trimmedQuery = query.trim();
    const searchLimit = Math.max(15, Math.min(Number(limit) || 28, 30));

    // 0. Vector Cache Check: Rapid pre-indexed vector lookup for repeat or similar topics
    const cachedVectorHits = await findCachedSimilar(trimmedQuery, 0.45, searchLimit);

    // 1. Agentic Step 1: Query Expansion (MeSH & UMLS)
    const expansion = await expandQuery(trimmedQuery);

    // 2. Agentic Step 2: Multi-Database Bulk Retrieval (Retrieve all available studies, e.g. 70-120 studies)
    const { allStudies: rawDocuments, totalAvailable } = await searchAllAvailableStudies(expansion.expandedQuery || trimmedQuery, 120);

    // Combine cached vector studies with live fetched documents, deduplicating by DOI/PMID/Title
    const seenMap = new Map<string, MedicalDocument>();
    for (const doc of [...cachedVectorHits.map(c => c.document), ...rawDocuments]) {
      const key = (doc.doi || doc.pmid || doc.title).toLowerCase().trim();
      if (!seenMap.has(key)) {
        seenMap.set(key, doc);
      }
    }
    const combinedPool = Array.from(seenMap.values());

    // Order all available studies strictly recent to past (Year descending)
    combinedPool.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return (b.citationCount || 0) - (a.citationCount || 0);
    });

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
        filteredDocuments = filteredDocuments.filter(d => d.year >= filters.yearFrom);
      }
      if (Array.isArray(filters.sourceDatabases) && filters.sourceDatabases.length > 0) {
        filteredDocuments = filteredDocuments.filter(d => filters.sourceDatabases.includes(d.source));
      }
    }

    const availablePool = filteredDocuments.length > 0 ? filteredDocuments : combinedPool;

    // Show initial batch (e.g. 28-30 studies)
    const initialBatch = availablePool.slice(0, searchLimit);

    // 3. Agentic Step 3: Vector Embedding & Persistent Storage with Rolling FIFO checks
    const upsertResult = await upsertDocuments(initialBatch);

    // 4. Agentic Step 4: Semantic Vector Ranking
    const rankedResults = await searchSimilar(trimmedQuery, searchLimit);
    const rankedDocIds = new Set(rankedResults.map(r => r.document.id));

    // Ensure all items in initialBatch have similarity scores and remain ordered recent to past
    const finalDocuments: MedicalDocument[] = initialBatch.map(doc => {
      const hit = rankedResults.find(r => r.document.id === doc.id || (doc.doi && r.document.doi === doc.doi));
      return {
        ...doc,
        score: hit ? hit.score : doc.score || 0.75
      };
    });

    // Sort extracted sources based on recent to past (Year descending, then score)
    finalDocuments.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return (b.score || 0) - (a.score || 0);
    });

    // 5. Agentic Step 5: Clinical PICO Synthesis with bracket citations
    const synthesis = await synthesizeLiterature(trimmedQuery, finalDocuments);

    const durationMs = Date.now() - startTime;

    res.json({
      success: true,
      query: trimmedQuery,
      expansion,
      documents: finalDocuments,
      totalAvailableStudies: availablePool.length,
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
    const { query, offset = 0, batchSize = 25, filters } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ error: 'Query string is required' });
      return;
    }

    const trimmedQuery = query.trim().toLowerCase();
    let session = sessionStudyRegistry.get(trimmedQuery);

    if (!session || !session.allStudies || session.allStudies.length === 0) {
      // Re-fetch pool if session expired
      const { allStudies } = await searchAllAvailableStudies(query.trim(), 120);
      session = { query: query.trim(), allStudies, createdAt: Date.now() };
      sessionStudyRegistry.set(trimmedQuery, session);
    }

    const currentOffset = Math.max(0, Number(offset) || 0);
    const size = Math.max(5, Math.min(Number(batchSize) || 25, 40));

    let pool = session.allStudies;
    if (filters) {
      if (typeof filters.minSample === 'number' && filters.minSample > 0) {
        pool = pool.filter(d => (d.pico?.sampleSize || 0) >= filters.minSample);
      }
      if (Array.isArray(filters.designs) && filters.designs.length > 0) {
        pool = pool.filter(d => filters.designs.includes(d.pico?.design));
      }
      if (typeof filters.yearFrom === 'number' && filters.yearFrom > 1900) {
        pool = pool.filter(d => d.year >= filters.yearFrom);
      }
      if (Array.isArray(filters.sourceDatabases) && filters.sourceDatabases.length > 0) {
        pool = pool.filter(d => filters.sourceDatabases.includes(d.source));
      }
    }

    const batch = pool.slice(currentOffset, currentOffset + size);

    // Vector embed and upsert this next batch into vector storage with rolling FIFO checks
    const upsertResult = await upsertDocuments(batch);

    // Ensure sorted recent to past
    batch.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return (b.citationCount || 0) - (a.citationCount || 0);
    });

    const newNextOffset = currentOffset + batch.length;
    const hasMore = newNextOffset < pool.length;

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

// -------------------------------------------------------------
// Settings & Runtime Configuration Handlers
// -------------------------------------------------------------

import { getSanitizedConfig, updateRuntimeConfig } from '../config.js';
import { testConnection, fetchOpenRouterModels } from '../services/openRouterService.js';
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

    // If Qdrant settings changed, re-initialize vector connection in background
    if (updates.qdrantUrl !== undefined || updates.qdrantApiKey !== undefined) {
      initQdrant().catch(err => {
        console.warn('[researchController] Qdrant re-init notice:', err);
      });
    }

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
    const { researchQuestion, targetJournal, targetDatabases, citationStyle, mode, clinicalEvidence } = req.body;

    if (!researchQuestion || typeof researchQuestion !== 'string' || !researchQuestion.trim()) {
      res.status(400).json({ error: 'researchQuestion is required' });
      return;
    }

    const draft = await generatePaperDraft({
      researchQuestion: researchQuestion.trim(),
      targetJournal,
      targetDatabases,
      citationStyle,
      mode,
      clinicalEvidence
    });

    res.json({
      success: true,
      draft
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
    const { action, sectionTitle, sectionContent, targetJournal, citationStyle, customPrompt, clinicalEvidence } = req.body;

    if (!action || !sectionContent) {
      res.status(400).json({ error: 'action and sectionContent are required' });
      return;
    }

    const result = await transformSection({
      action,
      sectionTitle: sectionTitle || 'Clinical Section',
      sectionContent,
      targetJournal,
      citationStyle,
      customPrompt,
      clinicalEvidence
    });

    res.json({
      success: true,
      result
    });
  } catch (err) {
    console.error('[researchController] Section action error:', err);
    res.status(500).json({
      error: 'Failed to transform section',
      details: err instanceof Error ? err.message : String(err)
    });
  }
}

export const researchController = {
  handleSearchAndIndex,
  handleVectorSearch,
  handleVectorStatus,
  handleHealth,
  handleGetSettings,
  handleUpdateSettings,
  handleGetOpenRouterModels,
  handleTestConnection,
  handleGeneratePaperDraft,
  handleSectionAction
};
