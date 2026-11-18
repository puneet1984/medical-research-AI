import dotenv from 'dotenv';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

// Load variables directly from .env file so QDRANT_API_KEY and QDRANT_URL are always available
dotenv.config();

export const DEFAULT_QDRANT_CLOUD_URL =
  'https://bd59148a-dfe3-4984-bcd6-795c770f786d.eu-west-2-0.aws.cloud.qdrant.io:6333';
export const DEFAULT_QDRANT_COLLECTION = 'medical_workspace';
export const DEFAULT_QDRANT_EMBEDDING_MODEL = 'sentence-transformers/all-minilm-l6-v2';
export const DEFAULT_QDRANT_VECTOR_DIMENSION = 384;

export interface QdrantCloudOverrides {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  model?: string;
  timeout?: number;
}

export interface QdrantCloudInferenceDocument {
  text: string;
  model: string;
}

export interface QdrantCloudTextPointInput {
  id: number | string;
  text: string;
  payload: Record<string, any>;
  model?: string;
}

export interface QdrantCloudQueryOptions extends QdrantCloudOverrides {
  client?: QdrantClient;
  limit?: number;
  withPayload?: boolean;
  filter?: Record<string, any>;
}

/**
 * Reads Qdrant connection settings directly from `.env` (process.env.QDRANT_API_KEY / QDRANT_URL)
 * with runtime Settings fallback. Never hardcodes API keys.
 */
export function resolveQdrantEnvConfig(overrides?: QdrantCloudOverrides): {
  url: string;
  apiKey: string;
  collectionName: string;
  model: string;
} {
  const url = (
    overrides?.url ||
    process.env.QDRANT_URL ||
    config.qdrantUrl ||
    DEFAULT_QDRANT_CLOUD_URL
  )
    .trim()
    .replace(/\/$/, '');

  const apiKey = (
    overrides?.apiKey !== undefined
      ? overrides.apiKey
      : process.env.QDRANT_API_KEY || config.qdrantApiKey || ''
  ).trim();

  const collectionName = (
    overrides?.collectionName ||
    process.env.QDRANT_COLLECTION ||
    DEFAULT_QDRANT_COLLECTION
  ).trim();

  const model = (
    overrides?.model ||
    process.env.QDRANT_INFERENCE_MODEL ||
    config.qdrantInferenceModel ||
    DEFAULT_QDRANT_EMBEDDING_MODEL
  ).trim();

  return { url, apiKey, collectionName, model };
}

/**
 * Determines whether Qdrant Cloud Inference (server-side 384-d `sentence-transformers/all-minilm-l6-v2`)
 * is enabled for the active cluster.
 */
export function isQdrantCloudInferenceEnabled(overrides?: QdrantCloudOverrides): boolean {
  if (config.qdrantUseCloudInference === false) return false;
  const resolved = resolveQdrantEnvConfig(overrides);
  if (!resolved.apiKey) return false;
  if (process.env.QDRANT_CLOUD_INFERENCE === 'true') return true;
  return resolved.url.includes('cloud.qdrant.io') || resolved.url === DEFAULT_QDRANT_CLOUD_URL;
}

/**
 * Instantiates a QdrantClient reading `apiKey` directly from `.env` (`QDRANT_API_KEY`).
 */
export function createQdrantCloudClient(overrides?: QdrantCloudOverrides): QdrantClient {
  const { url, apiKey } = resolveQdrantEnvConfig(overrides);
  return new QdrantClient({
    url,
    apiKey: apiKey || undefined,
    timeout: overrides?.timeout ?? 8000,
    checkCompatibility: false
  });
}

/**
 * Builds Qdrant Cloud Inference document vector payload for 384-d `sentence-transformers/all-minilm-l6-v2`.
 */
export function buildCloudInferenceDocumentVector(
  text: string,
  model = DEFAULT_QDRANT_EMBEDDING_MODEL
): QdrantCloudInferenceDocument {
  return {
    text: (text || '').slice(0, 6000),
    model
  };
}

/**
 * Ensures the target Qdrant collection (`medical_workspace`) exists with 384-d Cosine vector config
 * matching `sentence-transformers/all-minilm-l6-v2`. Recreates on dimension mismatch.
 */
export async function ensureQdrant384Collection(
  client: QdrantClient,
  collectionName = DEFAULT_QDRANT_COLLECTION,
  dimension = DEFAULT_QDRANT_VECTOR_DIMENSION
): Promise<{ created: boolean; recreated: boolean; dimension: number }> {
  const collectionsRes = await client.getCollections();
  const exists = collectionsRes.collections.some(c => c.name === collectionName);

  if (!exists) {
    await client.createCollection(collectionName, {
      vectors: {
        size: dimension,
        distance: 'Cosine'
      },
      optimizers_config: {
        default_segment_number: 2
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100
      }
    });
    return { created: true, recreated: false, dimension };
  }

  let existingDim: number | null = null;
  try {
    const info = await client.getCollection(collectionName);
    const vParams = (info as any)?.config?.params?.vectors;
    if (typeof vParams?.size === 'number') {
      existingDim = vParams.size;
    } else if (vParams && typeof vParams === 'object') {
      const firstKey = Object.keys(vParams)[0];
      if (firstKey && typeof vParams[firstKey]?.size === 'number') {
        existingDim = vParams[firstKey].size;
      }
    }
  } catch {
    // Ignore inspection error and keep existing collection
  }

  if (existingDim && existingDim !== dimension) {
    await client.deleteCollection(collectionName);
    await client.createCollection(collectionName, {
      vectors: {
        size: dimension,
        distance: 'Cosine'
      },
      optimizers_config: {
        default_segment_number: 2
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100
      }
    });
    return { created: false, recreated: true, dimension };
  }

  return { created: false, recreated: false, dimension: existingDim || dimension };
}

/**
 * Upserts text points directly to Qdrant Cloud Inference (`medical_workspace`) using
 * 384-d `sentence-transformers/all-minilm-l6-v2`:
 * ```ts
 * vector: { text, model: "sentence-transformers/all-minilm-l6-v2" }
 * await client.upsert("medical_workspace", { wait: true, points });
 * ```
 */
export async function upsertDocumentTextsToQdrant(
  items: QdrantCloudTextPointInput[],
  options?: QdrantCloudOverrides & { client?: QdrantClient; batchSize?: number }
): Promise<{ upserted: number; collectionName: string; model: string; dimension: number }> {
  const resolved = resolveQdrantEnvConfig(options);
  const client = options?.client || createQdrantCloudClient(options);
  const batchSize = Math.max(1, options?.batchSize ?? 50);

  if (!items || items.length === 0) {
    return {
      upserted: 0,
      collectionName: resolved.collectionName,
      model: resolved.model,
      dimension: DEFAULT_QDRANT_VECTOR_DIMENSION
    };
  }

  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const points = slice.map(item => ({
      id: item.id,
      payload: item.payload,
      vector: buildCloudInferenceDocumentVector(item.text, item.model || resolved.model)
    }));

    await client.upsert(resolved.collectionName, {
      wait: true,
      points
    });
  }

  return {
    upserted: items.length,
    collectionName: resolved.collectionName,
    model: resolved.model,
    dimension: DEFAULT_QDRANT_VECTOR_DIMENSION
  };
}

/**
 * Queries Qdrant (`medical_workspace`) using Qdrant Cloud Inference (`sentence-transformers/all-minilm-l6-v2`, 384-d):
 * ```ts
 * await client.query("medical_workspace", {
 *   query: { text, model: "sentence-transformers/all-minilm-l6-v2" }
 * });
 * ```
 */
export async function queryQdrantByDocumentText(
  queryText: string,
  options?: QdrantCloudQueryOptions
): Promise<{
  points: Array<{ id: number | string; score: number; payload?: Record<string, any> | null }>;
  collectionName: string;
  model: string;
  dimension: number;
}> {
  const resolved = resolveQdrantEnvConfig(options);
  const client = options?.client || createQdrantCloudClient(options);
  const limit = Math.max(1, options?.limit ?? 25);

  const queryParams: Record<string, any> = {
    query: buildCloudInferenceDocumentVector(queryText, resolved.model),
    limit,
    with_payload: options?.withPayload ?? true
  };
  if (options?.filter) {
    queryParams.filter = options.filter;
  }

  const result = await client.query(resolved.collectionName, queryParams);
  const points = Array.isArray((result as any)?.points) ? (result as any).points : [];

  return {
    points,
    collectionName: resolved.collectionName,
    model: resolved.model,
    dimension: DEFAULT_QDRANT_VECTOR_DIMENSION
  };
}
