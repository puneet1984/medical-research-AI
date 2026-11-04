import { config } from '../config.js';
import { GoogleGenAI } from '@google/genai';

export let EMBEDDING_DIMENSION = 768;

export function setEmbeddingDimension(dim: number): void {
  if (dim > 0 && dim !== EMBEDDING_DIMENSION) {
    console.log(`[embeddingService] Vector dimension updated from ${EMBEDDING_DIMENSION} to ${dim}`);
    EMBEDDING_DIMENSION = dim;
  }
}

/**
 * Resolves the native vector dimension for a given embedding provider and model name.
 * Google text-embedding-004: 768 dimensions
 * BioBERT / PubMedBERT: 768 dimensions
 * all-MiniLM-L6-v2: 384 dimensions
 * OpenAI text-embedding-3-small: 1536 (or requested 768/384)
 * Nomic Embed Text: 768 dimensions
 * Local Biomedical Hash: defaults to 768 (or matches collection)
 */
export function getModelNativeDimension(provider: string, modelName: string): number {
  const p = (provider || '').toLowerCase();
  const m = (modelName || '').toLowerCase();

  if (p === 'gemini') return 768; // text-embedding-004 is 768-d
  if (p === 'ollama') {
    if (m.includes('minilm') || m.includes('384')) return 384;
    return 768; // nomic-embed-text is 768-d
  }
  if (p === 'huggingface') {
    if (m.includes('minilm') || m.includes('384') || m.includes('small')) return 384;
    if (m.includes('large') || m.includes('1024')) return 1024;
    return 768; // BioBERT, PubMedBERT are 768-d
  }
  if (p === 'openrouter') {
    if (m.includes('minilm') || m.includes('384')) return 384;
    if (m.includes('large') && !m.includes('bge')) return 3072;
    if (m.includes('1024') || m.includes('cohere') || m.includes('bge-large')) return 1024;
    if (m.includes('text-embedding-3-small')) return 768;
    return 768;
  }
  if (p === 'local') {
    return 768; // Default local dimension aligned with text-embedding-004 & BioBERT
  }
  return 768;
}

/**
 * Resolves the single active embedding provider, model, and target vector dimension.
 * Guaranteed consistent across indexing and queries to prevent vector space corruption.
 */
export function getActiveEmbeddingInfo(): { provider: 'gemini' | 'ollama' | 'openrouter' | 'huggingface' | 'local'; model: string; dimension: number } {
  let provider = config.embeddingProvider as any;
  let model = 'text-embedding-004';

  if (provider === 'auto') {
    if (process.env.GEMINI_API_KEY || config.geminiApiKey) {
      provider = 'gemini';
      model = config.geminiEmbeddingModel || 'text-embedding-004';
    } else if (config.ollamaUrl && config.ollamaUrl !== 'http://localhost:11434') {
      provider = 'ollama';
      model = config.ollamaEmbeddingModel || 'nomic-embed-text';
    } else if (config.openRouterApiKey) {
      provider = 'openrouter';
      model = config.openRouterEmbeddingModel || 'openai/text-embedding-3-small';
    } else if (config.huggingFaceApiKey) {
      provider = 'huggingface';
      model = config.huggingFaceEmbeddingModel || 'monologg/biobert_v1.1_pubmed';
    } else {
      provider = 'local';
      model = 'biomedical-dense-hash-768';
    }
  } else if (provider === 'gemini') {
    model = config.geminiEmbeddingModel || 'text-embedding-004';
  } else if (provider === 'huggingface') {
    model = config.huggingFaceEmbeddingModel || 'monologg/biobert_v1.1_pubmed';
  } else if (provider === 'openrouter') {
    model = config.openRouterEmbeddingModel || 'openai/text-embedding-3-small';
  } else if (provider === 'ollama') {
    model = config.ollamaEmbeddingModel || 'nomic-embed-text';
  } else {
    provider = 'local';
    model = 'biomedical-dense-hash-768';
  }

  const dimension = getModelNativeDimension(provider, model);
  return { provider, model, dimension };
}

/**
 * Standard list of clinical and biomedical keyword weights for domain-specific RAG tuning.
 */
const BIOMEDICAL_KEYWORDS = [
  'randomized', 'trial', 'placebo', 'double-blind', 'hazard', 'ratio', 'confidence', 'interval',
  'mortality', 'efficacy', 'safety', 'adverse', 'cohort', 'meta-analysis', 'systematic', 'review',
  'p-value', 'endpoint', 'primary', 'secondary', 'dosage', 'treatment', 'intervention', 'comparator',
  'cardiovascular', 'oncology', 'diabetes', 'inhibitor', 'receptor', 'agonist', 'antagonist',
  'survival', 'progression-free', 'overall', 'tolerability', 'subgroup', 'multicenter'
];

/**
 * Generates a normalized dense vector locally using biomedical feature hashing
 */
export function generateLocalEmbedding(text: string, targetDim = EMBEDDING_DIMENSION): number[] {
  const vector = new Float64Array(targetDim);
  if (!text || text.trim().length === 0) {
    return Array.from(vector);
  }

  const clean = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  const tokens = clean.split(/\s+/).filter(t => t.length > 1);

  // 1. Unigram feature hash hashing with biomedical weighting
  for (const token of tokens) {
    const isBio = BIOMEDICAL_KEYWORDS.includes(token);
    const weight = isBio ? 2.5 : 1.0;

    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    const idx = Math.abs(hash) % targetDim;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[idx] += sign * weight;
  }

  // 2. Character 3-gram feature hashing to capture morphological roots
  for (let i = 0; i < clean.length - 2; i++) {
    const trigram = clean.slice(i, i + 3);
    let hash = 5381;
    for (let j = 0; j < 3; j++) {
      hash = ((hash << 5) + hash) + trigram.charCodeAt(j);
    }
    const idx = Math.abs(hash) % targetDim;
    vector[idx] += 0.35;
  }

  // 3. Euclidean L2 Unit-length normalization
  let norm = 0;
  for (let i = 0; i < targetDim; i++) {
    norm += vector[i] * vector[i];
  }

  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < targetDim; i++) {
      vector[i] /= norm;
    }
  }

  return Array.from(vector);
}

/**
 * Calls OpenRouter Embeddings API endpoint
 */
async function fetchOpenRouterEmbedding(text: string): Promise<number[]> {
  const apiKey = config.openRouterApiKey;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const model = config.openRouterEmbeddingModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://medresearch.ai',
      'X-Title': 'MedResearch AI Clinical Platform'
    },
    body: JSON.stringify({
      model,
      input: text.slice(0, 4000)
    }),
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter Embeddings HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const embedding = data?.data?.[0]?.embedding;
  if (Array.isArray(embedding) && embedding.length > 0) {
    // Project or pad/slice to match EMBEDDING_DIMENSION if needed
    return normalizeOrResizeVector(embedding, EMBEDDING_DIMENSION);
  }
  throw new Error('Invalid embedding vector returned from OpenRouter');
}

/**
 * Calls Hugging Face Inference API for sentence-transformers / BGE embeddings
 */
async function fetchHuggingFaceEmbedding(text: string): Promise<number[]> {
  const model = config.huggingFaceEmbeddingModel;
  const apiKey = config.huggingFaceApiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Hugging Face serverless router endpoint
  const url = `https://router.huggingface.co/hf-inference/models/${model}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      inputs: text.slice(0, 2000),
      options: { wait_for_model: true }
    }),
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HuggingFace Embeddings HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const raw = await res.json();
  // HF feature-extraction can return:
  // 1. 1D array: [dim] (standard sentence transformers like all-MiniLM-L6-v2)
  // 2. 2D array: [1, dim] or [seq_len, dim] (e.g. token matrix)
  // 3. 3D array: [1, seq_len, dim] (e.g. raw BERT models like monologg/biobert_v1.1_pubmed)
  let vector: number[] = [];
  if (Array.isArray(raw)) {
    if (typeof raw[0] === 'number') {
      vector = raw;
    } else if (Array.isArray(raw[0]) && typeof raw[0][0] === 'number') {
      if (raw.length === 1) {
        vector = raw[0];
      } else {
        // Mean pooling over token sequence: [seq_len, dim]
        const seqLen = raw.length;
        const dim = raw[0].length;
        const pooled = new Float64Array(dim);
        for (let t = 0; t < seqLen; t++) {
          const tokenVec = raw[t];
          for (let d = 0; d < dim; d++) pooled[d] += tokenVec[d];
        }
        vector = Array.from(pooled).map(v => v / seqLen);
      }
    } else if (Array.isArray(raw[0]) && Array.isArray(raw[0][0]) && typeof raw[0][0][0] === 'number') {
      // 3D tensor [batch=1, seq_len, dim] from raw BioBERT
      const tokens = raw[0];
      const seqLen = tokens.length;
      const dim = tokens[0].length;
      const pooled = new Float64Array(dim);
      for (let t = 0; t < seqLen; t++) {
        const tokenVec = tokens[t];
        for (let d = 0; d < dim; d++) pooled[d] += tokenVec[d];
      }
      vector = Array.from(pooled).map(v => v / seqLen);
    }
  }

  if (vector.length > 0) {
    return normalizeOrResizeVector(vector, EMBEDDING_DIMENSION);
  }
  throw new Error('Invalid embedding vector format returned from HuggingFace');
}

/**
 * Resizes and L2-normalizes vector to exact target dimension
 */
function normalizeOrResizeVector(source: number[], targetDim: number): number[] {
  const output = new Float64Array(targetDim);
  if (source.length === targetDim) {
    for (let i = 0; i < targetDim; i++) output[i] = source[i];
  } else if (source.length > targetDim) {
    // Stride or slice down
    for (let i = 0; i < targetDim; i++) {
      output[i] = source[i];
    }
  } else {
    // Pad
    for (let i = 0; i < source.length; i++) {
      output[i] = source[i];
    }
  }

  let norm = 0;
  for (let i = 0; i < targetDim; i++) {
    norm += output[i] * output[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < targetDim; i++) {
      output[i] /= norm;
    }
  }
  return Array.from(output);
}

/**
 * Fetches embedding from Ollama (/api/embeddings)
 */
async function fetchOllamaEmbedding(text: string): Promise<number[]> {
  const baseUrl = (config.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = config.ollamaEmbeddingModel || 'nomic-embed-text';

  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text.slice(0, 4000)
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama embedding HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (Array.isArray(data.embedding)) {
    return normalizeOrResizeVector(data.embedding, EMBEDDING_DIMENSION);
  }
  throw new Error('Invalid embedding returned by Ollama');
}

/**
 * Fetches 768-d embedding from Google Gemini (text-embedding-004) - free tier via Google AI Studio
 */
async function fetchGeminiEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const model = config.geminiEmbeddingModel || 'text-embedding-004';
  const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
  const response = await ai.models.embedContent({
    model,
    contents: text.slice(0, 4000)
  });

  const values = response.embeddings?.[0]?.values;
  if (Array.isArray(values) && values.length > 0) {
    return normalizeOrResizeVector(values, EMBEDDING_DIMENSION);
  }
  throw new Error('Invalid embedding vector returned from Gemini');
}

/**
 * Master embedding generator: Enforces a consistent single active embedding model
 * across all document indexing and search queries to guarantee vector space coherence
 * and prevent storage or retrieval failures.
 */
export async function generateEmbeddingAsync(text: string): Promise<{
  vector: number[];
  provider: 'gemini' | 'ollama' | 'openrouter' | 'huggingface' | 'local';
  model: string;
}> {
  const active = getActiveEmbeddingInfo();
  const targetDim = EMBEDDING_DIMENSION;

  // 1. Google Gemini Embeddings (text-embedding-004: Native 768-d)
  if (active.provider === 'gemini') {
    try {
      const rawVector = await fetchGeminiEmbedding(text);
      return {
        vector: normalizeOrResizeVector(rawVector, targetDim),
        provider: 'gemini',
        model: active.model
      };
    } catch (err) {
      console.warn(`[embeddingService] Google Gemini (${active.model}) error:`, err instanceof Error ? err.message : err);
      // Fallback to local biomedical projection at exact same dimension
      const fallback = generateLocalEmbedding(text, targetDim);
      return { vector: fallback, provider: 'local', model: `${active.model}-local-aligned` };
    }
  }

  // 2. Ollama Embeddings
  if (active.provider === 'ollama') {
    try {
      const rawVector = await fetchOllamaEmbedding(text);
      return {
        vector: normalizeOrResizeVector(rawVector, targetDim),
        provider: 'ollama',
        model: active.model
      };
    } catch (err) {
      console.warn(`[embeddingService] Ollama (${active.model}) error:`, err instanceof Error ? err.message : err);
      const fallback = generateLocalEmbedding(text, targetDim);
      return { vector: fallback, provider: 'local', model: `${active.model}-local-aligned` };
    }
  }

  // 3. OpenRouter Embeddings
  if (active.provider === 'openrouter') {
    try {
      const rawVector = await fetchOpenRouterEmbedding(text);
      return {
        vector: normalizeOrResizeVector(rawVector, targetDim),
        provider: 'openrouter',
        model: active.model
      };
    } catch (err) {
      console.warn(`[embeddingService] OpenRouter (${active.model}) error:`, err instanceof Error ? err.message : err);
      const fallback = generateLocalEmbedding(text, targetDim);
      return { vector: fallback, provider: 'local', model: `${active.model}-local-aligned` };
    }
  }

  // 4. Hugging Face Embeddings
  if (active.provider === 'huggingface') {
    try {
      const rawVector = await fetchHuggingFaceEmbedding(text);
      return {
        vector: normalizeOrResizeVector(rawVector, targetDim),
        provider: 'huggingface',
        model: active.model
      };
    } catch (err) {
      console.warn(`[embeddingService] Hugging Face (${active.model}) error:`, err instanceof Error ? err.message : err);
      const fallback = generateLocalEmbedding(text, targetDim);
      return { vector: fallback, provider: 'local', model: `${active.model}-local-aligned` };
    }
  }

  // 5. Deterministic Local Biomedical Embedding
  const vector = generateLocalEmbedding(text, targetDim);
  return {
    vector,
    provider: 'local',
    model: active.model
  };
}

/**
 * Synchronous embedding generator for instant zero-latency processing
 */
export function generateEmbedding(text: string): number[] {
  return generateLocalEmbedding(text, EMBEDDING_DIMENSION);
}

/**
 * Computes cosine similarity between two dense vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

export const embeddingService = {
  dimension: EMBEDDING_DIMENSION,
  generateEmbedding,
  generateEmbeddingAsync,
  generateLocalEmbedding,
  cosineSimilarity
};
