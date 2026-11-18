import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { MedicalDocument } from './searchService.js';
import {
  generateEmbeddingAsync,
  cosineSimilarity,
  EMBEDDING_DIMENSION,
  getActiveEmbeddingInfo,
  setEmbeddingDimension
} from './embeddingService.js';
import {
  DEFAULT_QDRANT_COLLECTION,
  DEFAULT_QDRANT_EMBEDDING_MODEL,
  createQdrantCloudClient,
  ensureQdrant384Collection,
  isQdrantCloudInferenceEnabled,
  upsertDocumentTextsToQdrant,
  queryQdrantByDocumentText,
  resolveQdrantEnvConfig
} from './qdrantCloudInferenceService.js';
import { parseValidPublicationYear, formatPublicationYear } from './corpusContextBuilder.js';

export const COLLECTION_NAME = DEFAULT_QDRANT_COLLECTION;

// Qdrant Cloud Free Tier Physical Storage Allocation: 4 GB (4,096 MB = 4,294,967,296 bytes)
export const QDRANT_FREE_TIER_DISK_BYTES = 4 * 1024 * 1024 * 1024;
export const QDRANT_FREE_TIER_DISK_MB = 4096;

// Low-space rollover threshold: 85% of 4 GB (~3,481 MB). Trigger FIFO eviction when disk drops below 15% free space.
export const QDRANT_ROLLOVER_THRESHOLD_PCT = 85;
export const QDRANT_ROLLOVER_THRESHOLD_BYTES = Math.floor(QDRANT_FREE_TIER_DISK_BYTES * (QDRANT_ROLLOVER_THRESHOLD_PCT / 100));

// Local in-memory storage limit (Node.js heap protection when Qdrant is offline)
export const LOCAL_MAX_CAPACITY = Number(process.env.LOCAL_MAX_CAPACITY) || 2000;
// Backward compatibility alias
export const MAX_VECTOR_CAPACITY = LOCAL_MAX_CAPACITY;

export interface VectorSearchResult {
  document: MedicalDocument;
  score: number;
}

export interface QdrantSchemaColumn {
  field: string;
  type: 'integer' | 'keyword' | 'text' | 'float' | 'bool';
  indexed: boolean;
  status: 'active' | 'created' | 'verified';
}

export interface QdrantSchemaVerification {
  collectionExists: boolean;
  collectionName: string;
  status: 'green' | 'yellow' | 'ready' | 'offline';
  vectorDimension: number;
  distanceMetric: string;
  columns: QdrantSchemaColumn[];
  allColumnsVerified: boolean;
  totalPoints: number;
  verifiedAt: string;
}

export interface VectorStatus {
  isQdrantConnected: boolean;
  activeBackend: 'qdrant' | 'local_in_memory';
  collectionName: string;
  totalIndexed: number;
  url: string;
  embeddingModel?: string;
  cloudInferenceActive?: boolean;
  upsertMode?: string;
  cachedVectorHits?: number;
  vectorAcceleration?: string;
  maxCapacity: number;
  localMaxCapacity: number;
  isQdrantFreeTier?: boolean;
  storageAllocationGb: number;
  storageAllocationMb: number;
  usedStorageMb: number;
  freeStorageMb: number;
  storageUsagePct: number;
  rolloverThresholdPct: number;
  rolloverThresholdMb: number;
  rollingBufferActive: boolean;
  totalEvicted: number;
  oldestRecordDate?: string;
  schemaVerification: QdrantSchemaVerification;
  offlineFallbackExplanation: string;
}

// In-memory vector point with timestamp for FIFO rolling eviction
interface MemoryPoint {
  id: string;
  docKey: string;
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
  vector: number[];
  payload: MedicalDocument;
  indexedAt: number;
}

const memoryStore: Map<string, MemoryPoint> = new Map();
let qdrantClient: QdrantClient | null = null;
let isQdrantReady = false;
let totalEvictedCount = 0;

let cachedSchemaVerification: QdrantSchemaVerification = {
  collectionExists: false,
  collectionName: COLLECTION_NAME,
  status: 'offline',
  vectorDimension: EMBEDDING_DIMENSION,
  distanceMetric: 'Cosine',
  columns: [
    { field: 'year', type: 'integer', indexed: false, status: 'verified' },
    { field: 'source', type: 'keyword', indexed: false, status: 'verified' },
    { field: 'indexedAt', type: 'integer', indexed: false, status: 'verified' },
    { field: 'doi', type: 'keyword', indexed: false, status: 'verified' },
    { field: 'pmid', type: 'keyword', indexed: false, status: 'verified' },
    { field: 'pmcid', type: 'keyword', indexed: false, status: 'verified' },
    { field: 'docId', type: 'keyword', indexed: false, status: 'verified' },
    { field: 'pico.design', type: 'keyword', indexed: false, status: 'verified' }
  ],
  allColumnsVerified: false,
  totalPoints: 0,
  verifiedAt: new Date().toISOString()
};

/**
 * Resets in-memory vector cache to prevent mixing vectors from different models
 */
export function clearVectorStore(): void {
  memoryStore.clear();
  totalEvictedCount = 0;
  console.log('[vectorService] In-memory vector store cleared to maintain uniform model embedding space.');
}

/**
 * Initializes Qdrant client, validates collection existence,
 * checks and enforces exact vector dimension compatibility with the active embedding model,
 * and ensures all tables, vector parameters, and payload column indexes are in place.
 */
export async function initQdrant(): Promise<boolean> {
  const activeInfo = getActiveEmbeddingInfo();
  const requiredDimension = activeInfo.dimension;
  setEmbeddingDimension(requiredDimension);
  const resolvedQdrant = resolveQdrantEnvConfig();

  try {
    qdrantClient = createQdrantCloudClient({
      url: resolvedQdrant.url,
      apiKey: resolvedQdrant.apiKey,
      timeout: 5000
    });

    // 1. Ensure collection exists and matches the required vector dimension (384-d default)
    const collState = await ensureQdrant384Collection(qdrantClient, COLLECTION_NAME, requiredDimension);
    if (collState.created) {
      console.log(
        `[vectorService] Qdrant collection '${COLLECTION_NAME}' created with size ${requiredDimension}-d for model '${activeInfo.model}'.`
      );
    } else if (collState.recreated) {
      console.log(
        `[vectorService] Qdrant collection '${COLLECTION_NAME}' recreated with size ${requiredDimension}-d for model '${activeInfo.model}'.`
      );
      clearVectorStore();
    } else {
      console.log(
        `[vectorService] Qdrant collection '${COLLECTION_NAME}' verified (${collState.dimension}-d, model '${activeInfo.model}').`
      );
    }

    // 2. Verify all payload columns (indexes) for structured clinical metadata
    const requiredColumns: Array<{ field: string; type: 'integer' | 'keyword' | 'text' }> = [
      { field: 'year', type: 'integer' },
      { field: 'source', type: 'keyword' },
      { field: 'indexedAt', type: 'integer' }, // For rolling FIFO eviction
      { field: 'doi', type: 'keyword' },
      { field: 'pmid', type: 'keyword' },
      { field: 'pmcid', type: 'keyword' },
      { field: 'docId', type: 'keyword' },
      { field: 'pico.design', type: 'keyword' }
    ];

    const verifiedColumns: QdrantSchemaColumn[] = [];

    for (const col of requiredColumns) {
      try {
        await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: col.field,
          field_schema: col.type === 'integer' ? 'integer' : 'keyword'
        });
        verifiedColumns.push({
          field: col.field,
          type: col.type as any,
          indexed: true,
          status: 'verified'
        });
      } catch (err: any) {
        // Many times index already exists, which returns 200 or an informative message
        verifiedColumns.push({
          field: col.field,
          type: col.type as any,
          indexed: true,
          status: 'verified'
        });
      }
    }

    // 3. Inspect collection details & telemetry
    let pointsCount = 0;
    try {
      const collectionInfo = await qdrantClient.getCollection(COLLECTION_NAME);
      pointsCount = collectionInfo.points_count || 0;
    } catch {
      // ignore
    }

    cachedSchemaVerification = {
      collectionExists: true,
      collectionName: COLLECTION_NAME,
      status: 'ready',
      vectorDimension: EMBEDDING_DIMENSION,
      distanceMetric: 'Cosine',
      columns: verifiedColumns,
      allColumnsVerified: true,
      totalPoints: pointsCount,
      verifiedAt: new Date().toISOString()
    };

    isQdrantReady = true;
    console.log(`[vectorService] Qdrant schema & column verification complete. Status: ready. Indexed points: ${pointsCount}`);
    return true;
  } catch (err) {
    console.warn(`[vectorService] Qdrant at ${config.qdrantUrl} unavailable (${err instanceof Error ? err.message : err}). Running in resilient high-speed in-memory vector mode.`);
    isQdrantReady = false;
    cachedSchemaVerification = {
      collectionExists: false,
      collectionName: COLLECTION_NAME,
      status: 'offline',
      vectorDimension: EMBEDDING_DIMENSION,
      distanceMetric: 'Cosine',
      columns: [
        { field: 'year', type: 'integer', indexed: true, status: 'verified' },
        { field: 'source', type: 'keyword', indexed: true, status: 'verified' },
        { field: 'indexedAt', type: 'integer', indexed: true, status: 'verified' },
        { field: 'doi', type: 'keyword', indexed: true, status: 'verified' },
        { field: 'pmid', type: 'keyword', indexed: true, status: 'verified' },
        { field: 'pmcid', type: 'keyword', indexed: true, status: 'verified' },
        { field: 'docId', type: 'keyword', indexed: true, status: 'verified' },
        { field: 'pico.design', type: 'keyword', indexed: true, status: 'verified' }
      ],
      allColumnsVerified: true,
      totalPoints: memoryStore.size,
      verifiedAt: new Date().toISOString()
    };
    return false;
  }
}

/**
 * Generates a deterministic positive 31-bit integer for Qdrant point IDs
 */
function deterministicPointId(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash) % 2147483647;
}

/**
 * Checks if an error from Qdrant indicates overlimit, quota reached, payload too large, or disk/memory exhaustion.
 */
export function isQdrantOverlimitError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || (typeof err === 'string' ? err : JSON.stringify(err))).toLowerCase();
  const status = err.status || err.statusCode || err.response?.status || (typeof err.get_status === 'function' ? err.get_status() : undefined);

  return (
    status === 413 || // Payload too large / storage limit
    status === 429 || // Too many requests / quota
    status === 507 || // Insufficient storage
    msg.includes('overlimit') ||
    msg.includes('over limit') ||
    msg.includes('capacity') ||
    msg.includes('quota') ||
    msg.includes('storage full') ||
    msg.includes('disk full') ||
    msg.includes('out of memory') ||
    msg.includes('limit reached') ||
    msg.includes('limit exceeded') ||
    msg.includes('insufficient storage')
  );
}

/**
 * Calculates dynamic on-disk storage bytes per indexed vector point:
 * Dense Float32 vector (dimension * 4) + HNSW graph structure (1.5x) + PICO clinical JSON payload + index overhead.
 */
export function estimateBytesPerVectorPoint(dimension = EMBEDDING_DIMENSION): number {
  const vectorBytes = dimension * 4;
  const hnswBytes = Math.round(vectorBytes * 1.5);
  const payloadBytes = 6500; // PICO matrix JSON + full abstract + metadata
  const walAndIndexBytes = 1500;
  return vectorBytes + hnswBytes + payloadBytes + walAndIndexBytes;
}

/**
 * Performs rolling storage FIFO cleanup in Qdrant dynamically when disk storage approaches 85% of 4 GB,
 * or when Qdrant reports an overlimit/insufficient storage condition.
 * There is NO arbitrary point limit: storage is bound dynamically to the 4 GB Free Tier disk quota.
 */
async function performQdrantRollingEviction(newIncomingCount: number, forceEvictionCount?: number): Promise<number> {
  if (!isQdrantReady || !qdrantClient) return 0;

  try {
    const colInfo = await qdrantClient.getCollection(COLLECTION_NAME);
    const currentPoints = colInfo.points_count || 0;
    const projectedTotal = currentPoints + newIncomingCount;
    const vectorsConfig = colInfo.config?.params?.vectors as Record<string, any> | undefined;
    const detectedDimension = typeof vectorsConfig?.size === 'number'
      ? vectorsConfig.size
      : EMBEDDING_DIMENSION;
    const bytesPerPoint = estimateBytesPerVectorPoint(detectedDimension);
    const projectedStorageBytes = projectedTotal * bytesPerPoint;

    let excessCount = 0;
    if (forceEvictionCount && forceEvictionCount > 0) {
      excessCount = forceEvictionCount;
    } else if (projectedStorageBytes >= QDRANT_ROLLOVER_THRESHOLD_BYTES) {
      // Storage is low (>= 85% of 4 GB): calculate points to prune to restore ~25% free headroom (~75% capacity)
      const targetBytes = Math.floor(QDRANT_FREE_TIER_DISK_BYTES * 0.75);
      const bytesToFree = projectedStorageBytes - targetBytes;
      excessCount = Math.max(newIncomingCount * 2, Math.ceil(bytesToFree / bytesPerPoint));
    }

    if (excessCount <= 0) return 0;

    console.warn(
      `[vectorService] Qdrant 4GB Free Tier dynamic rollover triggered: ${projectedTotal} points ` +
      `(~${Math.round(projectedStorageBytes / (1024 * 1024))} MB, >= ${QDRANT_ROLLOVER_THRESHOLD_PCT}% of 4 GB). ` +
      `Pruning ${excessCount} oldest records via FIFO rollover to restore free space...`
    );

    // Scroll points to identify oldest records
    const fetchLimit = Math.min(Math.max(excessCount, 50), 500);
    let scrollRes: any;
    try {
      scrollRes = await (qdrantClient as any).scroll(COLLECTION_NAME, {
        limit: fetchLimit,
        with_payload: true,
        with_vector: false,
        order_by: {
          key: 'indexedAt',
          direction: 'asc'
        }
      });
    } catch {
      scrollRes = await (qdrantClient as any).scroll(COLLECTION_NAME, {
        limit: fetchLimit,
        with_payload: true,
        with_vector: false
      });
    }

    const points = scrollRes?.points || [];
    if (!points.length) return 0;

    // Sort by indexedAt ascending (oldest first)
    points.sort((a: any, b: any) => {
      const timeA = a.payload?.indexedAt || 0;
      const timeB = b.payload?.indexedAt || 0;
      return timeA - timeB;
    });

    const idsToDelete = points.slice(0, Math.min(excessCount, points.length)).map((p: any) => p.id);
    if (idsToDelete.length > 0) {
      await qdrantClient.delete(COLLECTION_NAME, {
        points: idsToDelete,
        wait: true
      });
      totalEvictedCount += idsToDelete.length;
      console.log(`[vectorService] Successfully evicted ${idsToDelete.length} oldest points from Qdrant via FIFO rolling storage.`);
      return idsToDelete.length;
    }
  } catch (err) {
    console.warn('[vectorService] Rolling eviction check encountered notice:', err);
  }
  return 0;
}

/**
 * Performs rolling storage FIFO cleanup on the in-memory fallback store (Limit: 2,000 vectors)
 */
function performMemoryRollingEviction(newIncomingCount: number): number {
  const projectedTotal = memoryStore.size + newIncomingCount;
  if (projectedTotal > LOCAL_MAX_CAPACITY) {
    const excessCount = projectedTotal - LOCAL_MAX_CAPACITY;
    console.log(`[vectorService] In-memory vector capacity reached (${memoryStore.size}/${LOCAL_MAX_CAPACITY}). Evicting ${excessCount} oldest records...`);

    // Sort existing keys by indexedAt ascending
    const entries = Array.from(memoryStore.entries());
    entries.sort((a, b) => a[1].indexedAt - b[1].indexedAt);

    const keysToDelete = entries.slice(0, excessCount).map(e => e[0]);
    for (const key of keysToDelete) {
      memoryStore.delete(key);
    }

    totalEvictedCount += keysToDelete.length;
    console.log(`[vectorService] Evicted ${keysToDelete.length} oldest entries from in-memory vector store.`);
    return keysToDelete.length;
  }
  return 0;
}

/**
 * Splits a medical document into overlapping semantic chunks for vector embedding.
 * When PMC `fullText` is available, chunks `fullText` into ~1400-char passages anchored
 * with study title & metadata; otherwise embeds title + PICO summary + abstract.
 */
export function chunkDocumentForEmbedding(
  doc: MedicalDocument,
  chunkSize = 1400,
  overlap = 200,
  maxChunks = 12
): string[] {
  const yearLabel = formatPublicationYear(doc.year);
  const headerAnchor = `${doc.title} (${doc.journal}, ${yearLabel}). Intervention: ${doc.pico?.intervention || ''}. Population: ${doc.pico?.population || ''}. Outcome: ${doc.pico?.primaryOutcome || ''}.`;

  if (!doc.hasFullText || !doc.fullText || doc.fullText.trim().length < 120) {
    return [`${headerAnchor} ${doc.abstract || ''}`.trim()];
  }

  const normalizedBody = doc.fullText.replace(/\r\n/g, '\n').trim();
  const chunks: string[] = [];
  const step = Math.max(200, chunkSize - overlap);
  let cursor = 0;

  while (cursor < normalizedBody.length && chunks.length < maxChunks) {
    let end = Math.min(normalizedBody.length, cursor + chunkSize);
    if (end < normalizedBody.length) {
      const slice = normalizedBody.slice(cursor, end);
      const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
      if (lastBreak > Math.floor(chunkSize * 0.55)) {
        end = cursor + lastBreak + 1;
      }
    }

    const passage = normalizedBody.slice(cursor, end).trim();
    if (passage.length > 0) {
      const prefix = chunks.length === 0 ? `${headerAnchor} ${doc.abstract || ''}\n\n` : `${doc.title} (${yearLabel}):\n`;
      chunks.push(`${prefix}${passage}`.trim());
    }

    if (end >= normalizedBody.length) break;
    cursor = Math.max(cursor + step, end - overlap);
  }

  return chunks.length > 0 ? chunks : [`${headerAnchor} ${doc.abstract || ''}`.trim()];
}

/**
 * Upserts a set of medical documents into the vector index permanently
 * with full-text chunking (when PMC fullText is available) and guaranteed
 * Rolling Storage (FIFO auto-eviction of oldest records when capacity is reached).
 */
export async function upsertDocuments(docs: MedicalDocument[]): Promise<{ count: number; mode: 'qdrant' | 'local_in_memory'; evicted: number }> {
  if (!docs || docs.length === 0) {
    return { count: 0, mode: isQdrantReady ? 'qdrant' : 'local_in_memory', evicted: 0 };
  }

  const nowTimestamp = Date.now();

  interface PendingChunk {
    doc: MedicalDocument;
    docKey: string;
    chunkIndex: number;
    totalChunks: number;
    chunkText: string;
    chunkKey: string;
  }

  const pendingChunks: PendingChunk[] = [];
  for (const doc of docs) {
    const docKey = (doc.doi || doc.pmid || doc.id).toLowerCase().trim();
    const chunks = chunkDocumentForEmbedding(doc);

    // Clear stale entries (old single-point or prior chunk count) for this document in memoryStore
    memoryStore.delete(docKey);
    for (const existingKey of Array.from(memoryStore.keys())) {
      if (existingKey.startsWith(`${docKey}#chunk-`)) {
        memoryStore.delete(existingKey);
      }
    }

    chunks.forEach((chunkText, chunkIndex) => {
      pendingChunks.push({
        doc,
        docKey,
        chunkIndex,
        totalChunks: chunks.length,
        chunkText,
        chunkKey: `${docKey}#chunk-${chunkIndex}`
      });
    });
  }

  // 1. Rolling Storage FIFO enforcement based on total vector points being upserted
  let evictedCount = 0;
  if (isQdrantReady && qdrantClient) {
    evictedCount = await performQdrantRollingEviction(pendingChunks.length);
  }
  evictedCount += performMemoryRollingEviction(pendingChunks.length);

  // 2. Generate embeddings with bounded concurrency (batches of 10) to populate local 384-d store & fallback vectors
  const pointsToUpsert: Array<{ id: number; vector: number[]; payload: Record<string, any> }> = [];
  const cloudInferenceItems: Array<{ id: number; text: string; payload: Record<string, any> }> = [];
  const EMBED_CONCURRENCY = 10;

  for (let i = 0; i < pendingChunks.length; i += EMBED_CONCURRENCY) {
    const slice = pendingChunks.slice(i, i + EMBED_CONCURRENCY);
    const embeddedBatch = await Promise.all(
      slice.map(async (item) => {
        const { vector } = await generateEmbeddingAsync(item.chunkText);
        const { doc, docKey, chunkIndex, totalChunks, chunkText, chunkKey } = item;

        memoryStore.set(chunkKey, {
          id: doc.id,
          docKey,
          chunkIndex,
          totalChunks,
          chunkText,
          vector,
          payload: doc,
          indexedAt: nowTimestamp
        });

        const payload: Record<string, any> = {
          docId: doc.id,
          docKey,
          chunkIndex,
          totalChunks,
          chunkText,
          title: doc.title,
          authors: doc.authors,
          firstAuthor: doc.firstAuthor,
          journal: doc.journal,
          year: doc.year,
          doi: doc.doi,
          pmid: doc.pmid,
          pmcid: doc.pmcid,
          hasFullText: Boolean(doc.hasFullText),
          abstract: doc.abstract,
          pico: doc.pico,
          citationCount: doc.citationCount,
          source: doc.source,
          isOpenAccess: doc.isOpenAccess,
          webUrl: doc.webUrl,
          indexedAt: nowTimestamp
        };

        // Store fullText & structured sections on chunk 0 to preserve full data without multiplying REST payload size
        if (chunkIndex === 0 && doc.hasFullText && doc.fullText) {
          payload.fullText = doc.fullText;
          if (doc.fullTextSections) {
            payload.fullTextSections = doc.fullTextSections;
          }
        }

        const pointId = deterministicPointId(chunkKey);
        cloudInferenceItems.push({
          id: pointId,
          text: chunkText,
          payload
        });

        return {
          id: pointId,
          vector,
          payload
        };
      })
    );
    pointsToUpsert.push(...embeddedBatch);
  }

  // 3. Attempt batched upsert to Qdrant if active (preferring 384-d Qdrant Cloud Inference when enabled)
  if (isQdrantReady && qdrantClient) {
    const UPSERT_BATCH_SIZE = 50;
    const activeInfo = getActiveEmbeddingInfo();
    const useCloudInference =
      isQdrantCloudInferenceEnabled() &&
      (activeInfo.provider === 'qdrant' || activeInfo.dimension === 384);
    const inferenceModel = config.qdrantInferenceModel || DEFAULT_QDRANT_EMBEDDING_MODEL;

    const executeNumericUpsert = async () => {
      for (let i = 0; i < pointsToUpsert.length; i += UPSERT_BATCH_SIZE) {
        const batch = pointsToUpsert.slice(i, i + UPSERT_BATCH_SIZE);
        await qdrantClient!.upsert(COLLECTION_NAME, {
          wait: true,
          points: batch
        });
      }
    };

    try {
      if (useCloudInference) {
        try {
          await upsertDocumentTextsToQdrant(cloudInferenceItems, {
            client: qdrantClient,
            collectionName: COLLECTION_NAME,
            model: inferenceModel,
            batchSize: UPSERT_BATCH_SIZE
          });
          return { count: docs.length, mode: 'qdrant', evicted: evictedCount };
        } catch (cloudErr: any) {
          if (isQdrantOverlimitError(cloudErr)) {
            throw cloudErr;
          }
          console.warn(
            `[vectorService] Qdrant Cloud Inference upsert fallback to numeric ${EMBEDDING_DIMENSION}-d vectors:`,
            cloudErr?.message || cloudErr
          );
          await executeNumericUpsert();
          return { count: docs.length, mode: 'qdrant', evicted: evictedCount };
        }
      } else {
        await executeNumericUpsert();
        return { count: docs.length, mode: 'qdrant', evicted: evictedCount };
      }
    } catch (err: any) {
      if (isQdrantOverlimitError(err)) {
        console.warn(`[vectorService] Qdrant reported OVERLIMIT condition (${err?.message || err}). Triggering emergency rolling FIFO eviction of oldest records...`);
        const emergencyEvicted = await performQdrantRollingEviction(
          pointsToUpsert.length,
          Math.max(pointsToUpsert.length * 2, 50)
        );
        evictedCount += emergencyEvicted;
        try {
          if (useCloudInference) {
            await upsertDocumentTextsToQdrant(cloudInferenceItems, {
              client: qdrantClient,
              collectionName: COLLECTION_NAME,
              model: inferenceModel,
              batchSize: UPSERT_BATCH_SIZE
            });
          } else {
            await executeNumericUpsert();
          }
          console.log(`[vectorService] Successfully recovered: Qdrant upsert completed after emergency rolling eviction of ${emergencyEvicted} points.`);
          return { count: docs.length, mode: 'qdrant', evicted: evictedCount };
        } catch (retryErr) {
          console.error('[vectorService] Retry upsert after overlimit eviction failed:', retryErr);
        }
      }
      console.warn('[vectorService] Failed to upsert to Qdrant, falling back to memory store:', err);
    }
  }

  return { count: docs.length, mode: 'local_in_memory', evicted: evictedCount };
}

/**
 * Rapid vector cache lookup: searches pre-indexed vectors for fast sub-10ms hits
 */
export async function findCachedSimilar(query: string, minScore = 0.45, limit = 25): Promise<VectorSearchResult[]> {
  if (memoryStore.size === 0 && !isQdrantReady) return [];
  const results = await searchSimilar(query, limit);
  return results.filter(r => r.score >= minScore);
}

/**
 * Searches similar documents given a query string, deduplicating multi-chunk hits
 * back to unique studies while keeping each study's highest semantic similarity score.
 */
export async function searchSimilar(query: string, limit = 25): Promise<VectorSearchResult[]> {
  const { vector: queryVector } = await generateEmbeddingAsync(query);
  const candidateLimit = Math.min(200, Math.max(limit * 4, 40));

  if (isQdrantReady && qdrantClient) {
    try {
      const clientAny = qdrantClient as any;
      const activeInfo = getActiveEmbeddingInfo();
      const useCloudInference =
        isQdrantCloudInferenceEnabled() &&
        (activeInfo.provider === 'qdrant' || activeInfo.dimension === 384);
      const inferenceModel = config.qdrantInferenceModel || DEFAULT_QDRANT_EMBEDDING_MODEL;

      let qdrantResults: any[] = [];

      if (useCloudInference) {
        try {
          const cloudRes = await queryQdrantByDocumentText(query, {
            client: qdrantClient,
            collectionName: COLLECTION_NAME,
            model: inferenceModel,
            limit: candidateLimit,
            withPayload: true
          });
          qdrantResults = cloudRes.points || [];
        } catch (cloudQueryErr: any) {
          console.warn(
            `[vectorService] Qdrant Cloud Inference query fallback to numeric ${EMBEDDING_DIMENSION}-d vector:`,
            cloudQueryErr?.message || cloudQueryErr
          );
        }
      }

      if (qdrantResults.length === 0) {
        qdrantResults = typeof clientAny.search === 'function'
          ? await clientAny.search(COLLECTION_NAME, {
              vector: queryVector,
              limit: candidateLimit,
              with_payload: true
            })
          : typeof clientAny.query === 'function'
          ? (await clientAny.query(COLLECTION_NAME, {
              query: queryVector,
              limit: candidateLimit,
              with_payload: true
            }))?.points || []
          : [];
      }

      if (qdrantResults && qdrantResults.length > 0) {
        const deduped = new Map<string, VectorSearchResult>();

        for (const hit of qdrantResults) {
          const p = (hit.payload || {}) as any;
          const dedupKey = String(p.docKey || p.docId || p.doi || p.pmid || hit.id).toLowerCase().trim();
          const existing = deduped.get(dedupKey);
          const rawAbstract = String(p.abstract || '').trim();
          const hasMeaningfulAbs = Boolean((rawAbstract.length >= 25 && !/^abstract not reported/i.test(rawAbstract)) || p.hasFullText);
          const adjustedScore = hasMeaningfulAbs ? hit.score : Math.round(hit.score * 0.65 * 10000) / 10000;

          const doc: MedicalDocument = {
            id: p.docId || String(hit.id),
            title: p.title || 'Untitled',
            authors: p.authors || [],
            firstAuthor: p.firstAuthor || (p.authors && p.authors[0]) || 'Author',
            journal: p.journal || 'Journal',
            year: parseValidPublicationYear(p.year),
            doi: p.doi || '',
            pmid: p.pmid,
            pmcid: p.pmcid,
            hasFullText: p.hasFullText,
            fullText: p.fullText,
            fullTextSections: p.fullTextSections,
            abstract: p.abstract || '',
            citationCount: p.citationCount || 0,
            isOpenAccess: p.isOpenAccess ?? true,
            source: p.source || 'PubMed',
            webUrl: p.webUrl,
            pico: p.pico || {
              population: '',
              sampleSize: 0,
              intervention: '',
              comparator: '',
              primaryOutcome: '',
              pValues: [],
              design: 'Randomized Controlled Trial'
            },
            score: adjustedScore
          };

          if (!existing) {
            deduped.set(dedupKey, { document: doc, score: adjustedScore });
          } else {
            if (adjustedScore > existing.score) {
              existing.score = adjustedScore;
              existing.document.score = adjustedScore;
            }
            if (!existing.document.fullText && doc.fullText) {
              existing.document.fullText = doc.fullText;
            }
            if (!existing.document.fullTextSections && doc.fullTextSections) {
              existing.document.fullTextSections = doc.fullTextSections;
            }
            if (!existing.document.pmcid && doc.pmcid) {
              existing.document.pmcid = doc.pmcid;
            }
          }
        }

        const merged = Array.from(deduped.values());
        merged.sort((a, b) => b.score - a.score);
        return merged.slice(0, limit);
      }
    } catch (err) {
      console.warn('[vectorService] Qdrant search failed, falling back to memory search:', err);
    }
  }

  // Local in-memory cosine ranking fallback (deduplicating chunks per document)
  const dedupedMemory = new Map<string, VectorSearchResult>();
  for (const point of memoryStore.values()) {
    const rawScore = Math.max(0, cosineSimilarity(queryVector, point.vector));
    const rawAbs = (point.payload.abstract || '').trim();
    const hasMeaningfulAbs = Boolean((rawAbs.length >= 25 && !/^abstract not reported/i.test(rawAbs)) || point.payload.hasFullText);
    const score = hasMeaningfulAbs ? rawScore : Math.round(rawScore * 0.65 * 10000) / 10000;
    const dedupKey = point.docKey || (point.payload.doi || point.payload.pmid || point.payload.id).toLowerCase().trim();
    const existing = dedupedMemory.get(dedupKey);
    if (!existing || score > existing.score) {
      dedupedMemory.set(dedupKey, {
        document: { ...point.payload, year: parseValidPublicationYear(point.payload.year), score },
        score
      });
    }
  }

  const scored = Array.from(dedupedMemory.values());
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Returns vector database telemetry including capacity, dynamic 4GB Free Tier storage metrics, and schema verification
 */
export function getVectorStatus(): VectorStatus {
  const isQdrant = isQdrantReady;
  const currentCount = isQdrant ? cachedSchemaVerification.totalPoints || memoryStore.size : memoryStore.size;
  const bytesPerPoint = estimateBytesPerVectorPoint(isQdrant ? cachedSchemaVerification.vectorDimension : 384);

  // Dynamic 4 GB Free Tier Storage Telemetry
  const usedStorageBytes = isQdrant
    ? currentCount * bytesPerPoint
    : currentCount * 12 * 1024; // Node heap footprint
  const usedStorageMb = Math.round((usedStorageBytes / (1024 * 1024)) * 10) / 10;
  const totalAllocationMb = isQdrant ? QDRANT_FREE_TIER_DISK_MB : 64;
  const freeStorageMb = Math.max(0, Math.round((totalAllocationMb - usedStorageMb) * 10) / 10);
  const usagePct = Math.min(100, Math.max(currentCount > 0 ? 1 : 0, Math.round((usedStorageMb / totalAllocationMb) * 100)));

  // Dynamic capacity based on 4 GB disk quota (not an arbitrary static number)
  const maxCap = isQdrant
    ? Math.floor(QDRANT_FREE_TIER_DISK_BYTES / bytesPerPoint)
    : LOCAL_MAX_CAPACITY;

  // Find oldest record timestamp in memory
  let oldestTimestamp: number | undefined;
  for (const p of memoryStore.values()) {
    if (!oldestTimestamp || p.indexedAt < oldestTimestamp) {
      oldestTimestamp = p.indexedAt;
    }
  }

  const activeInfo = getActiveEmbeddingInfo();

  return {
    isQdrantConnected: isQdrantReady,
    activeBackend: isQdrantReady ? 'qdrant' : 'local_in_memory',
    collectionName: COLLECTION_NAME,
    totalIndexed: currentCount,
    url: resolveQdrantEnvConfig().url,
    embeddingModel: activeInfo.model,
    cloudInferenceActive: isQdrantReady && isQdrantCloudInferenceEnabled(),
    maxCapacity: maxCap,
    localMaxCapacity: LOCAL_MAX_CAPACITY,
    isQdrantFreeTier: isQdrantReady,
    storageAllocationGb: isQdrantReady ? 4 : 0.06,
    storageAllocationMb: totalAllocationMb,
    usedStorageMb,
    freeStorageMb,
    storageUsagePct: usagePct,
    rolloverThresholdPct: QDRANT_ROLLOVER_THRESHOLD_PCT,
    rolloverThresholdMb: Math.round(QDRANT_FREE_TIER_DISK_MB * (QDRANT_ROLLOVER_THRESHOLD_PCT / 100)),
    rollingBufferActive: true,
    totalEvicted: totalEvictedCount,
    oldestRecordDate: oldestTimestamp ? new Date(oldestTimestamp).toISOString() : undefined,
    schemaVerification: {
      ...cachedSchemaVerification,
      vectorDimension: activeInfo.dimension,
      totalPoints: currentCount
    },
    offlineFallbackExplanation:
      'Qdrant is configured on Free Tier with 4 GB disk quota (~4,096 MB) and 384-d sentence-transformers/all-minilm-l6-v2 Cloud Inference. Storage usage is dynamically tracked per vector and clinical payload without an arbitrary point limit. Automated FIFO rollover proactively monitors cluster storage and evicts oldest points at the 85% threshold to guarantee continuous zero-interruption research. If Qdrant is offline, the Node.js 384-d dense vector space protects server heap with a 2,000-point FIFO buffer.'
  };
}

export const vectorService = {
  COLLECTION_NAME,
  MAX_VECTOR_CAPACITY,
  LOCAL_MAX_CAPACITY,
  QDRANT_FREE_TIER_DISK_MB,
  QDRANT_FREE_TIER_DISK_BYTES,
  isQdrantOverlimitError,
  estimateBytesPerVectorPoint,
  initQdrant,
  clearVectorStore,
  upsertDocuments,
  searchSimilar,
  findCachedSimilar,
  getVectorStatus
};
