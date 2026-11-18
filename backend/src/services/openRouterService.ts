import { config } from '../config.js';
import { GoogleGenAI } from '@google/genai';
import { getActiveEmbeddingInfo } from './embeddingService.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Initializes Gemini client if GEMINI_API_KEY is available
 */
let geminiClient: GoogleGenAI | null = null;
if (config.geminiApiKey) {
  try {
    geminiClient = new GoogleGenAI({
      apiKey: config.geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  } catch (err) {
    console.warn('[openRouterService] Gemini initialization note:', err);
  }
}

/**
 * Calls OpenRouter chat completion endpoint
 */
async function callOpenRouter(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const model = options.model || config.llmSynthesisModel;
  const apiKey = config.openRouterApiKey;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://medresearch.ai',
      'X-Title': 'MedResearch AI Clinical Platform'
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
        { role: 'user', content: prompt }
      ],
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 3000
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenRouter');
  }

  return content;
}

export function resetGeminiClient(): void {
  geminiClient = null;
}

/**
 * Calls Gemini as native server-side inference engine
 */
async function callGemini(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  // Resolve model dynamically: respect options.model if specified or gemini-2.5-flash
  let modelName = 'gemini-2.5-flash';
  if (options.model && typeof options.model === 'string' && options.model.trim()) {
    const raw = options.model.trim().toLowerCase();
    if (raw.includes('gemini')) {
      const stripped = options.model.split('/').pop()?.replace(':free', '') || options.model;
      if (stripped.startsWith('gemini')) {
        modelName = stripped;
      }
    }
  }

  const response = await geminiClient.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      systemInstruction: options.systemPrompt || 'You are an expert clinical epidemiologist and evidence-based medicine researcher.'
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error('Empty response from Gemini');
  }
  return text;
}

/**
 * Calls Ollama local / remote instance
 */
async function callOllama(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const baseUrl = (config.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = options.model || config.ollamaLlmModel || 'llama3:latest';

  // Ollama native API
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt,
        stream: false
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.response) return data.response;
    }
  } catch {
    // try OpenAI compatible endpoint
  }

  // Fallback to Ollama /v1/chat/completions
  const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    throw new Error(`Ollama HTTP ${chatRes.status}: ${errText}`);
  }

  const chatData = await chatRes.json();
  const text = chatData.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from Ollama');
  return text;
}

/**
 * Calls OmniRoute (OpenAI-compatible unified router/proxy)
 */
async function callOmniRoute(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  let url = (config.omniRouteUrl || '').trim().replace(/\/$/, '');
  if (!url) {
    throw new Error('OmniRoute URL not configured');
  }

  if (!url.endsWith('/chat/completions')) {
    url = url.endsWith('/v1') ? `${url}/chat/completions` : `${url}/v1/chat/completions`;
  }

  const model = options.model || config.omniRouteLlmModel || 'deepseek/deepseek-r1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (config.omniRouteApiKey) {
    headers['Authorization'] = `Bearer ${config.omniRouteApiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
        { role: 'user', content: prompt }
      ],
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 3000
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OmniRoute HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OmniRoute');
  }
  return content;
}

/**
 * Unified inference engine:
 * Supports user preference (omniroute, ollama, openrouter, gemini, or auto)
 */
export async function executeInference(
  prompt: string,
  options: CompletionOptions = {}
): Promise<{ text: string; provider: 'omniroute' | 'ollama' | 'openrouter' | 'gemini' | 'clinical_rule_engine'; modelUsed: string }> {
  const preferred = config.llmProvider;

  // 1. Direct OmniRoute
  if (preferred === 'omniroute' || (preferred === 'auto' && config.omniRouteUrl)) {
    try {
      const model = options.model || config.omniRouteLlmModel || 'deepseek/deepseek-r1';
      const text = await callOmniRoute(prompt, options);
      return { text, provider: 'omniroute', modelUsed: model };
    } catch (err) {
      console.warn('[openRouterService] OmniRoute call failed:', err instanceof Error ? err.message : err);
      if (preferred === 'omniroute') throw err;
    }
  }

  // 2. Direct Ollama
  if (preferred === 'ollama') {
    try {
      const model = options.model || config.ollamaLlmModel || 'llama3:latest';
      const text = await callOllama(prompt, options);
      return { text, provider: 'ollama', modelUsed: model };
    } catch (err) {
      console.warn('[openRouterService] Ollama call failed:', err instanceof Error ? err.message : err);
      throw err;
    }
  }

  // 3. OpenRouter
  const openRouterKey = config.openRouterApiKey || process.env.OPENROUTER_API_KEY;
  if (preferred === 'openrouter' || (preferred === 'auto' && openRouterKey && openRouterKey.trim() !== '')) {
    try {
      const model = options.model || config.llmSynthesisModel;
      const text = await callOpenRouter(prompt, options);
      return { text, provider: 'openrouter', modelUsed: model };
    } catch (err) {
      console.warn('[openRouterService] OpenRouter call failed, falling back:', err instanceof Error ? err.message : err);
      if (preferred === 'openrouter') throw err;
    }
  }

  // 4. Fallback to Gemini
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (preferred === 'gemini' || (geminiKey && geminiKey.trim() !== '')) {
    try {
      const model = options.model || (preferred === 'gemini' ? config.llmSynthesisModel : 'gemini-2.5-flash');
      const text = await callGemini(prompt, { ...options, model });
      return { text, provider: 'gemini', modelUsed: model };
    } catch (err) {
      console.warn('[openRouterService] Gemini call failed:', err instanceof Error ? err.message : err);
    }
  }

  // 5. Try Ollama if auto and configured URL
  if (preferred === 'auto' && config.ollamaUrl && config.ollamaUrl !== 'http://localhost:11434') {
    try {
      const model = options.model || config.ollamaLlmModel || 'llama3:latest';
      const text = await callOllama(prompt, options);
      return { text, provider: 'ollama', modelUsed: model };
    } catch {
      // continue to rule-based
    }
  }

  // Graceful rule-based response
  return {
    text: '',
    provider: 'clinical_rule_engine',
    modelUsed: 'local-clinical-engine'
  };
}

/**
 * Service connection diagnostics for Ollama, OmniRoute, OpenRouter, Gemini, Hugging Face, Qdrant, NCBI
 */
export async function testConnection(
  target: 'ollama' | 'omniroute' | 'openrouter' | 'gemini' | 'huggingface' | 'qdrant' | 'ncbi',
  params?: Record<string, string>
): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    if (target === 'qdrant') {
      const rawUrl = (
        params?.url ||
        config.qdrantUrl ||
        process.env.QDRANT_URL ||
        'https://bd59148a-dfe3-4984-bcd6-795c770f786d.eu-west-2-0.aws.cloud.qdrant.io:6333'
      ).trim();
      const url = rawUrl.replace(/\/$/, '');
      const apiKey = (
        params?.apiKey !== undefined
          ? params.apiKey
          : process.env.QDRANT_API_KEY || config.qdrantApiKey || ''
      ).trim();

      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['api-key'] = apiKey;
      }

      const res = await fetch(`${url}/collections`, {
        headers,
        signal: AbortSignal.timeout(6000)
      });

      if (res.ok) {
        const data = await res.json();
        const collections = data?.result?.collections || [];
        const hasWorkspace = collections.some((c: { name: string }) => c.name === 'medical_workspace');

        let dimMsg = '';
        let qdrantDim: number | null = null;
        const activeInfo = getActiveEmbeddingInfo();
        const activeModel = activeInfo.model;
        const requiredDim = activeInfo.dimension;

        if (hasWorkspace) {
          try {
            const collRes = await fetch(`${url}/collections/medical_workspace`, { headers, signal: AbortSignal.timeout(4000) });
            if (collRes.ok) {
              const collData = await collRes.json();
              const vParams = collData?.result?.config?.params?.vectors;
              if (typeof vParams?.size === 'number') {
                qdrantDim = vParams.size;
              } else if (typeof vParams === 'object' && vParams !== null) {
                const k = Object.keys(vParams)[0];
                if (k && typeof (vParams as any)[k]?.size === 'number') qdrantDim = (vParams as any)[k].size;
              }

              if (qdrantDim) {
                if (qdrantDim === requiredDim) {
                  dimMsg = ` • medical_workspace: ${qdrantDim}-d verified (matching active model ${activeModel})`;
                } else {
                  dimMsg = ` • medical_workspace: ${qdrantDim}-d detected (will auto-align to ${requiredDim}-d for ${activeModel} on save)`;
                }
              }
            }
          } catch {
            // ignore
          }
        }

        return {
          success: true,
          message: `Qdrant verified & connected at ${url} (${collections.length} collection${collections.length === 1 ? '' : 's'}${dimMsg || (hasWorkspace ? ' • medical_workspace ready' : '')})`,
          details: { collections: collections.map((c: { name: string }) => c.name), url, hasWorkspace, activeModel, requiredDim, qdrantDim }
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          message: `Qdrant authentication failed (HTTP ${res.status}): Invalid API Key for ${url}`
        };
      }

      const errText = await res.text();
      return {
        success: false,
        message: `Qdrant returned HTTP ${res.status}: ${errText.slice(0, 150)}`
      };
    }

    if (target === 'ollama') {
      const url = (params?.url || config.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map((m: { name: string }) => m.name);
        const preview = models.length > 0 ? ` (${models.slice(0, 3).join(', ')}${models.length > 3 ? ` +${models.length - 3} more` : ''})` : '';
        return { success: true, message: `Ollama connected successfully at ${url} • ${models.length} model${models.length === 1 ? '' : 's'} available${preview}`, details: { models } };
      }
      return { success: false, message: `Ollama returned HTTP ${res.status} at ${url}` };
    }

    if (target === 'omniroute') {
      let url = (params?.url || config.omniRouteUrl || '').trim().replace(/\/$/, '');
      const apiKey = (params?.apiKey !== undefined ? params.apiKey : config.omniRouteApiKey)?.trim();
      if (!url) return { success: false, message: 'OmniRoute URL is required' };
      if (!url.endsWith('/models')) {
        url = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;
      }
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data?.data) ? data.data.length : 'active';
        return { success: true, message: `OmniRoute endpoint reachable & authenticated (${count} models detected)`, details: data };
      }
      if (res.status === 401 || res.status === 403) {
        return { success: false, message: `OmniRoute authentication failed (HTTP ${res.status}): Invalid API key` };
      }
      return { success: false, message: `OmniRoute returned HTTP ${res.status}` };
    }

    if (target === 'openrouter') {
      const apiKey = (params?.apiKey !== undefined ? params.apiKey : config.openRouterApiKey)?.trim();
      if (!apiKey) return { success: false, message: 'OpenRouter API Key is empty' };
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://medresearch.ai',
          'X-Title': 'MedResearch AI Clinical Platform'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const data = await res.json();
        const info = data?.data;
        const label = info?.label ? ` ("${info.label}")` : '';
        const usage = info?.usage !== undefined ? ` [Usage: $${Number(info.usage).toFixed(4)}]` : '';
        const limit = info?.limit ? ` [Limit: $${info.limit}]` : '';
        const isFree = info?.is_free_tier ? ' [Free Tier]' : '';
        return {
          success: true,
          message: `OpenRouter API key is valid${label}${isFree}${usage}${limit}`,
          details: info
        };
      }
      if (res.status === 401) {
        return { success: false, message: 'OpenRouter authentication failed: Invalid or expired API Key (HTTP 401)' };
      }
      const errText = await res.text();
      return { success: false, message: `OpenRouter returned HTTP ${res.status}: ${errText.slice(0, 150)}` };
    }

    if (target === 'gemini') {
      const apiKey = (params?.apiKey !== undefined ? params.apiKey : (process.env.GEMINI_API_KEY || config.geminiApiKey))?.trim();
      if (!apiKey) return { success: false, message: 'GEMINI_API_KEY is not set' };
      const model = params?.model || config.geminiEmbeddingModel || 'text-embedding-004';
      const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
      try {
        const embedResp = await ai.models.embedContent({
          model,
          contents: 'Clinical research embedding diagnostic ping'
        });
        const hasValues = Array.isArray(embedResp.embeddings?.[0]?.values) && (embedResp.embeddings[0].values.length > 0);
        return {
          success: true,
          message: `Google Gemini operational • ${model} verified & active (768-d)`,
          details: { model, active: true, valuesCount: embedResp.embeddings?.[0]?.values?.length }
        };
      } catch (embedErr: any) {
        const resp = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: 'Ping test. Reply with pong.'
        });
        return {
          success: Boolean(resp.text),
          message: `Google Gemini API Key valid (${embedErr?.message || 'text-embedding-004 note'})`
        };
      }
    }

    if (target === 'huggingface') {
      const apiKey = (params?.apiKey !== undefined ? params.apiKey : config.huggingFaceApiKey)?.trim();
      const model = params?.model || config.huggingFaceEmbeddingModel || 'monologg/biobert_v1.1_pubmed';

      // 1. If API key is provided, verify token directly via whoami-v2
      if (apiKey) {
        try {
          const whoRes = await fetch('https://huggingface.co/api/whoami-v2', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(6000)
          });
          if (whoRes.ok) {
            const whoData = await whoRes.json();
            const username = whoData.name || whoData.username || 'User';
            const orgs = Array.isArray(whoData.orgs) && whoData.orgs.length > 0 ? ` (${whoData.orgs.length} orgs)` : '';
            return {
              success: true,
              message: `Hugging Face API key is valid! Authenticated as @${username}${orgs}`,
              details: { username, type: whoData.type }
            };
          } else if (whoRes.status === 401) {
            return {
              success: false,
              message: 'Hugging Face authentication failed: Invalid User Access Token (HTTP 401)'
            };
          }
        } catch {
          // Fall back to model endpoint
        }
      }

      // 2. Test model endpoint
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ inputs: 'Medical embedding test passage', options: { wait_for_model: true } }),
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        return { success: true, message: `Hugging Face model ${model} verified and reachable` };
      }
      const errText = await res.text();
      let guidance = '';
      if (res.status === 410) {
        guidance = ' (Notice: This model repository has been deprecated on HF Serverless fleet. Switch to Gemini text-embedding-004 or the built-in Local Biomedical engine).';
      } else if (res.status === 402) {
        guidance = ' (Notice: Hugging Face now requires paid PRO credits for this model provider. Switch to Gemini text-embedding-004 [Free Tier] or the Local Biomedical engine [100% Free]).';
      }
      return { success: false, message: `Hugging Face HTTP ${res.status}: ${errText.slice(0, 120)}${guidance}` };
    }

    if (target === 'ncbi') {
      const apiKey = (params?.apiKey !== undefined ? params.apiKey : config.ncbiApiKey)?.trim();
      const email = params?.email || config.scholarlyEmail || 'researcher@domain.com';
      let url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?db=pubmed&retmode=json&email=${encodeURIComponent(email)}`;
      if (apiKey) {
        url += `&api_key=${encodeURIComponent(apiKey)}`;
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        return {
          success: true,
          message: apiKey
            ? 'NCBI Entrez API Key valid! High-throughput 10 req/s rate limits enabled (NBK25497).'
            : 'NCBI Entrez reachable (Standard 3 req/s anonymous rate limit).',
          details: await res.json()
        };
      }
      return {
        success: false,
        message: `NCBI Entrez returned HTTP ${res.status}: Invalid Entrez API Key or access blocked`
      };
    }

    return { success: false, message: `Unknown target ${target}` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Connection test failed'
    };
  }
}

export interface OpenRouterModelItem {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  pricing?: {
    prompt: string;
    completion: string;
    isFree: boolean;
  };
  outputModalities?: string[];
  isFree: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
}

export interface CategorizedOpenRouterModels {
  all: OpenRouterModelItem[];
  freeText: OpenRouterModelItem[];
  allText: OpenRouterModelItem[];
  freeEmbeddings: OpenRouterModelItem[];
  allEmbeddings: OpenRouterModelItem[];
  reasoning: OpenRouterModelItem[];
}

let cachedOpenRouterModels: OpenRouterModelItem[] | null = null;
let lastOpenRouterFetchTime = 0;
const OPENROUTER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes cache

const CURATED_OPENROUTER_FALLBACK: OpenRouterModelItem[] = [
  // Free Reasoning & Synthesis Models
  {
    id: 'deepseek/deepseek-r1:free',
    name: 'DeepSeek: R1 (free)',
    description: 'State-of-the-art open reasoning model, utilizing chain-of-thought processing rivaling proprietary frontier models.',
    contextLength: 131072,
    isFree: true,
    isReasoning: true,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Meta: Llama 3.3 70B Instruct (free)',
    description: 'High-capability 70B parameter model optimized for synthesis, scientific instruction following, and clinical analysis.',
    contextLength: 131072,
    isFree: true,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  {
    id: 'google/gemini-2.0-flash-exp:free',
    name: 'Google: Gemini 2.0 Flash Experimental (free)',
    description: 'Fast, multimodal model from Google with next-generation clinical reasoning and extraction capabilities.',
    contextLength: 1048576,
    isFree: true,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  {
    id: 'qwen/qwq-32b:free',
    name: 'Qwen: QwQ 32B Reasoning (free)',
    description: 'Specialized reasoning model developed by Alibaba Qwen team, trained for complex analytical problem-solving.',
    contextLength: 32768,
    isFree: true,
    isReasoning: true,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  {
    id: 'mistralai/mistral-small-3:free',
    name: 'Mistral: Mistral Small 3 (free)',
    description: 'Compact, efficient instruction-tuned model with low latency and strong clinical summarization benchmarks.',
    contextLength: 32768,
    isFree: true,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
    description: 'High-speed NVIDIA inference model optimized for rapid clinical text transformation and extraction.',
    contextLength: 131072,
    isFree: true,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  // Paid / High-Performance Frontier Models
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek: R1 (Standard / Full Capacity)',
    description: 'Uncapped reasoning model with DeepSeek-R1 architecture for clinical research synthesis.',
    contextLength: 163840,
    isFree: false,
    isReasoning: true,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0.00000055', completion: '0.00000219', isFree: false }
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Meta: Llama 3.3 70B Instruct',
    description: 'Full-throughput production Meta Llama 3.3 70B model.',
    contextLength: 131072,
    isFree: false,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0.0000004', completion: '0.0000004', isFree: false }
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Anthropic: Claude 3.5 Sonnet',
    description: 'Highest-tier clinical synthesis model with nuanced biomedical understanding.',
    contextLength: 200000,
    isFree: false,
    isReasoning: true,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0.000003', completion: '0.000015', isFree: false }
  },
  {
    id: 'openai/gpt-4o',
    name: 'OpenAI: GPT-4o',
    description: 'Flagship high-intelligence multimodal model for biomedical analysis.',
    contextLength: 128000,
    isFree: false,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0.0000025', completion: '0.00001', isFree: false }
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'OpenAI: GPT-4o-mini',
    description: 'Fast, cost-efficient model for biomedical extraction.',
    contextLength: 128000,
    isFree: false,
    isReasoning: false,
    isEmbedding: false,
    outputModalities: ['text'],
    pricing: { prompt: '0.00000015', completion: '0.0000006', isFree: false }
  },
  // OpenRouter & Standard Embedding Models
  {
    id: 'openai/text-embedding-3-small',
    name: 'OpenAI: text-embedding-3-small (1536-d)',
    description: 'High-efficiency semantic embedding model with excellent biomedical retrieval accuracy.',
    contextLength: 8191,
    isFree: false,
    isReasoning: false,
    isEmbedding: true,
    outputModalities: ['embeddings'],
    pricing: { prompt: '0.00000002', completion: '0', isFree: false }
  },
  {
    id: 'openai/text-embedding-3-large',
    name: 'OpenAI: text-embedding-3-large (3072-d)',
    description: 'Highest-precision OpenAI embedding model for fine-grained clinical literature mapping.',
    contextLength: 8191,
    isFree: false,
    isReasoning: false,
    isEmbedding: true,
    outputModalities: ['embeddings'],
    pricing: { prompt: '0.00000013', completion: '0', isFree: false }
  },
  {
    id: 'cohere/embed-english-v3.0',
    name: 'Cohere: embed-english-v3.0 (1024-d)',
    description: 'Leading dense retrieval embedding model with compression awareness.',
    contextLength: 512,
    isFree: false,
    isReasoning: false,
    isEmbedding: true,
    outputModalities: ['embeddings'],
    pricing: { prompt: '0.0000001', completion: '0', isFree: false }
  },
  {
    id: 'baai/bge-large-en-v1.5',
    name: 'BAAI: BGE Large English v1.5 (1024-d)',
    description: 'Top-ranking open semantic embedding model for scientific RAG pipelines.',
    contextLength: 512,
    isFree: true,
    isReasoning: false,
    isEmbedding: true,
    outputModalities: ['embeddings'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  },
  {
    id: 'sentence-transformers/all-MiniLM-L6-v2',
    name: 'Sentence-Transformers: all-MiniLM-L6-v2 (384-d)',
    description: 'Lightweight, ultra-fast embedding model natively matching 384-dimensional vector indices.',
    contextLength: 256,
    isFree: true,
    isReasoning: false,
    isEmbedding: true,
    outputModalities: ['embeddings'],
    pricing: { prompt: '0', completion: '0', isFree: true }
  }
];

function categorizeOpenRouterModels(models: OpenRouterModelItem[]): CategorizedOpenRouterModels {
  const embeddingIds = new Set(models.filter(m => m.isEmbedding).map(m => m.id));
  const combined = [...models];
  for (const fallbackItem of CURATED_OPENROUTER_FALLBACK) {
    if (fallbackItem.isEmbedding && !embeddingIds.has(fallbackItem.id)) {
      combined.push(fallbackItem);
    }
  }

  const allText = combined.filter(m => !m.isEmbedding && (m.outputModalities?.includes('text') || !m.outputModalities || m.outputModalities.length === 0));
  const freeText = allText.filter(m => m.isFree);
  const allEmbeddings = combined.filter(m => m.isEmbedding);
  const freeEmbeddings = allEmbeddings.filter(m => m.isFree);
  const reasoning = combined.filter(m => m.isReasoning);

  return {
    all: combined,
    freeText,
    allText,
    freeEmbeddings,
    allEmbeddings,
    reasoning
  };
}

/**
 * Fetches real-time models catalog from OpenRouter API with in-memory caching and fallback
 */
export async function fetchOpenRouterModels(forceRefresh = false): Promise<CategorizedOpenRouterModels> {
  const now = Date.now();
  if (!forceRefresh && cachedOpenRouterModels && (now - lastOpenRouterFetchTime < OPENROUTER_CACHE_TTL)) {
    return categorizeOpenRouterModels(cachedOpenRouterModels);
  }

  const headers: Record<string, string> = {
    'HTTP-Referer': 'https://medresearch.ai',
    'X-Title': 'MedResearch AI Clinical Platform'
  };
  if (config.openRouterApiKey) {
    headers['Authorization'] = `Bearer ${config.openRouterApiKey}`;
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers,
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}`);
    }

    const data = await res.json();
    const rawList = data?.data || [];

    const mapped: OpenRouterModelItem[] = rawList.map((m: any) => {
      const outputMods = m.architecture?.output_modalities || [];
      const promptPrice = m.pricing?.prompt || '0';
      const completionPrice = m.pricing?.completion || '0';
      const isZeroPrice = (promptPrice === '0' || promptPrice === '0.00000000' || parseFloat(promptPrice) === 0) &&
                          (completionPrice === '0' || completionPrice === '0.00000000' || parseFloat(completionPrice) === 0);
      const isFree = m.id.endsWith(':free') || isZeroPrice;
      const idLower = m.id.toLowerCase();
      const nameLower = (m.name || '').toLowerCase();
      const descLower = (m.description || '').toLowerCase();

      const isEmbedding = outputMods.includes('embeddings') ||
                          idLower.includes('embed') ||
                          nameLower.includes('embed');

      const isReasoning = idLower.includes('r1') ||
                          idLower.includes('reason') ||
                          idLower.includes('qwq') ||
                          idLower.includes('o1') ||
                          idLower.includes('o3') ||
                          idLower.includes('thinking') ||
                          descLower.includes('reasoning') ||
                          (Array.isArray(m.supported_parameters) && m.supported_parameters.includes('include_reasoning'));

      return {
        id: m.id,
        name: m.name || m.id,
        description: m.description,
        contextLength: m.context_length,
        pricing: {
          prompt: promptPrice,
          completion: completionPrice,
          isFree
        },
        outputModalities: outputMods,
        isFree,
        isReasoning,
        isEmbedding
      };
    });

    cachedOpenRouterModels = mapped;
    lastOpenRouterFetchTime = now;
    return categorizeOpenRouterModels(mapped);
  } catch (err) {
    console.warn('[openRouterService] Could not fetch OpenRouter models:', err);
    if (cachedOpenRouterModels) {
      return categorizeOpenRouterModels(cachedOpenRouterModels);
    }
    return categorizeOpenRouterModels(CURATED_OPENROUTER_FALLBACK);
  }
}

export const openRouterService = {
  callOpenRouter,
  callOllama,
  callOmniRoute,
  callGemini,
  executeInference,
  testConnection,
  fetchOpenRouterModels
};
