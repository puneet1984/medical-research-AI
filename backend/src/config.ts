import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const SETTINGS_FILE_PATH = path.join(DATA_DIR, 'persistent-settings.json');

export const config = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: DATA_DIR,
  settingsFilePath: SETTINGS_FILE_PATH,
  llmProvider: process.env.LLM_PROVIDER || 'auto', // 'auto' | 'omniroute' | 'ollama' | 'openrouter' | 'gemini'
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  llmReasoningModel: process.env.LLM_REASONING_MODEL || 'deepseek/deepseek-r1',
  llmSynthesisModel: process.env.LLM_SYNTHESIS_MODEL || 'meta-llama/llama-3.3-70b-instruct',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // Ollama configuration
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  ollamaLlmModel: process.env.OLLAMA_LLM_MODEL || 'llama3:latest',
  ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
  // OmniRoute configuration
  omniRouteUrl: process.env.OMNIROUTE_URL || '',
  omniRouteApiKey: process.env.OMNIROUTE_API_KEY || '',
  omniRouteLlmModel: process.env.OMNIROUTE_LLM_MODEL || 'deepseek/deepseek-r1',
  // Qdrant vector store
  qdrantHost: process.env.QDRANT_HOST || 'localhost',
  qdrantPort: Number(process.env.QDRANT_PORT) || 6333,
  qdrantUrl: process.env.QDRANT_URL || `http://${process.env.QDRANT_HOST || 'localhost'}:${process.env.QDRANT_PORT || 6333}`,
  qdrantApiKey: process.env.QDRANT_API_KEY || '',
  // Scholarly APIs
  scholarlyEmail: process.env.SCHOLARLY_USER_AGENT_EMAIL || 'researcher@domain.com',
  ncbiApiKey: process.env.NCBI_API_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // Embeddings configuration
  embeddingProvider: process.env.EMBEDDING_PROVIDER || 'auto', // 'auto' | 'openrouter' | 'huggingface' | 'ollama' | 'local'
  openRouterEmbeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small',
  huggingFaceApiKey: process.env.HUGGINGFACE_API_KEY || '',
  huggingFaceEmbeddingModel: process.env.HUGGINGFACE_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2'
};

// Initialize persistent volume data directory
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (err) {
  console.warn('[config] Notice creating data directory:', err);
}

// Load persistent settings on startup from mounted volume if file exists
function loadPersistentSettings(): void {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved)) {
          if (k in config && v !== undefined && v !== null && v !== '') {
            (config as Record<string, unknown>)[k] = v;
          }
        }
        console.log(`[config] Loaded persistent variables & API keys from volume mount at: ${SETTINGS_FILE_PATH}`);
      }
    }
  } catch (err) {
    console.warn('[config] Could not read persistent settings file:', err);
  }
}

loadPersistentSettings();

function maskKey(key: string): string {
  if (!key || key.trim().length === 0) return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/**
 * Saves variables and API keys to the persistent volume mounted file
 */
export function savePersistentSettings(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const toSave: Record<string, unknown> = {
      llmProvider: config.llmProvider,
      openRouterApiKey: config.openRouterApiKey,
      llmReasoningModel: config.llmReasoningModel,
      llmSynthesisModel: config.llmSynthesisModel,
      geminiApiKey: config.geminiApiKey,
      ollamaUrl: config.ollamaUrl,
      ollamaLlmModel: config.ollamaLlmModel,
      ollamaEmbeddingModel: config.ollamaEmbeddingModel,
      omniRouteUrl: config.omniRouteUrl,
      omniRouteApiKey: config.omniRouteApiKey,
      omniRouteLlmModel: config.omniRouteLlmModel,
      qdrantHost: config.qdrantHost,
      qdrantPort: config.qdrantPort,
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey,
      scholarlyEmail: config.scholarlyEmail,
      ncbiApiKey: config.ncbiApiKey,
      embeddingProvider: config.embeddingProvider,
      openRouterEmbeddingModel: config.openRouterEmbeddingModel,
      huggingFaceApiKey: config.huggingFaceApiKey,
      huggingFaceEmbeddingModel: config.huggingFaceEmbeddingModel,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
    console.log(`[config] Variables and API keys saved to persistent volume: ${SETTINGS_FILE_PATH}`);
  } catch (err) {
    console.warn('[config] Failed to write persistent settings to volume:', err);
  }
}

/**
 * Updates configuration in memory and writes to persistent volume storage
 */
export function updateRuntimeConfig(updates: Record<string, unknown>): typeof config {
  for (const [k, v] of Object.entries(updates)) {
    if (k in config && v !== undefined && v !== null) {
      // If it's a masked key and hasn't changed, don't overwrite with mask
      if (typeof v === 'string' && (v.includes('...') || v.includes('***')) && (k.toLowerCase().includes('key') || k.toLowerCase().includes('secret'))) {
        continue;
      }
      (config as Record<string, unknown>)[k] = v;
    }
  }
  savePersistentSettings();
  return config;
}

/**
 * Returns safe view of config for the Settings UI including persistent volume status
 */
export function getSanitizedConfig() {
  return {
    llmProvider: config.llmProvider,
    llmReasoningModel: config.llmReasoningModel,
    llmSynthesisModel: config.llmSynthesisModel,
    openRouterApiKeyMasked: maskKey(config.openRouterApiKey),
    isOpenRouterConfigured: Boolean(config.openRouterApiKey),
    geminiApiKeyMasked: maskKey(config.geminiApiKey || process.env.GEMINI_API_KEY || ''),
    isGeminiConfigured: Boolean(config.geminiApiKey || process.env.GEMINI_API_KEY),
    ollamaUrl: config.ollamaUrl,
    ollamaLlmModel: config.ollamaLlmModel,
    ollamaEmbeddingModel: config.ollamaEmbeddingModel,
    omniRouteUrl: config.omniRouteUrl,
    omniRouteApiKeyMasked: maskKey(config.omniRouteApiKey),
    isOmniRouteConfigured: Boolean(config.omniRouteApiKey),
    omniRouteLlmModel: config.omniRouteLlmModel,
    embeddingProvider: config.embeddingProvider,
    openRouterEmbeddingModel: config.openRouterEmbeddingModel,
    huggingFaceApiKeyMasked: maskKey(config.huggingFaceApiKey),
    isHuggingFaceConfigured: Boolean(config.huggingFaceApiKey),
    huggingFaceEmbeddingModel: config.huggingFaceEmbeddingModel,
    scholarlyEmail: config.scholarlyEmail,
    ncbiApiKeyMasked: maskKey(config.ncbiApiKey),
    isNcbiConfigured: Boolean(config.ncbiApiKey),
    qdrantHost: config.qdrantHost,
    qdrantPort: config.qdrantPort,
    qdrantUrl: config.qdrantUrl,
    qdrantApiKeyMasked: maskKey(config.qdrantApiKey),
    isQdrantConfigured: Boolean(config.qdrantApiKey),
    persistentVolumePath: config.settingsFilePath,
    isVolumeMounted: fs.existsSync(DATA_DIR)
  };
}
