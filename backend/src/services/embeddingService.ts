import { config } from '../config.js';

export const EMBEDDING_DIMENSION = 384;

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
  // HF feature-extraction can return 1D array or 2D array [1, dim]
  let vector: number[] = [];
  if (Array.isArray(raw)) {
    if (typeof raw[0] === 'number') {
      vector = raw;
    } else if (Array.isArray(raw[0]) && typeof raw[0][0] === 'number') {
      vector = raw[0];
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
 * Async master embedding generator: Ollama -> OpenRouter -> Hugging Face -> Local Fallback
 */
export async function generateEmbeddingAsync(text: string): Promise<{
  vector: number[];
  provider: 'ollama' | 'openrouter' | 'huggingface' | 'local';
  model: string;
}> {
  const providerPref = config.embeddingProvider;

  // 1. Ollama Embeddings
  if (providerPref === 'ollama') {
    try {
      const vector = await fetchOllamaEmbedding(text);
      return {
        vector,
        provider: 'ollama',
        model: config.ollamaEmbeddingModel
      };
    } catch (err) {
      console.warn('[embeddingService] Ollama embeddings failed:', err instanceof Error ? err.message : err);
    }
  }

  // 2. OpenRouter Embeddings
  if (providerPref === 'openrouter' || (providerPref === 'auto' && config.openRouterApiKey)) {
    try {
      const vector = await fetchOpenRouterEmbedding(text);
      return {
        vector,
        provider: 'openrouter',
        model: config.openRouterEmbeddingModel
      };
    } catch (err) {
      console.warn('[embeddingService] OpenRouter embeddings notice, trying secondary provider:', err instanceof Error ? err.message : err);
    }
  }

  // 3. Hugging Face Embeddings
  if (providerPref === 'huggingface' || (providerPref === 'auto' && config.huggingFaceApiKey)) {
    try {
      const vector = await fetchHuggingFaceEmbedding(text);
      return {
        vector,
        provider: 'huggingface',
        model: config.huggingFaceEmbeddingModel
      };
    } catch (err) {
      console.warn('[embeddingService] HuggingFace embeddings notice, using local pipeline:', err instanceof Error ? err.message : err);
    }
  }

  // 4. Deterministic Local Biomedical Embedding
  const vector = generateLocalEmbedding(text, EMBEDDING_DIMENSION);
  return {
    vector,
    provider: 'local',
    model: 'biomedical-dense-hash-384'
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
