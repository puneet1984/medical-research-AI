import { config } from '../config.js';
import { GoogleGenAI } from '@google/genai';

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

/**
 * Calls Gemini as native server-side inference engine
 */
async function callGemini(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
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

  const response = await geminiClient.models.generateContent({
    model: 'gemini-3.8-flash',
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
  const geminiKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
  if (preferred === 'gemini' || (geminiKey && geminiKey.trim() !== '')) {
    try {
      const text = await callGemini(prompt, options);
      return { text, provider: 'gemini', modelUsed: 'gemini-3.8-flash' };
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
 * Service connection diagnostics
 */
export async function testConnection(target: 'ollama' | 'omniroute' | 'openrouter' | 'gemini', params?: Record<string, string>): Promise<{ success: boolean; message: string; details?: unknown }> {
  try {
    if (target === 'ollama') {
      const url = (params?.url || config.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map((m: { name: string }) => m.name);
        return { success: true, message: `Ollama connected successfully at ${url}`, details: { models } };
      }
      return { success: false, message: `Ollama returned HTTP ${res.status}` };
    }

    if (target === 'omniroute') {
      let url = (params?.url || config.omniRouteUrl || '').replace(/\/$/, '');
      const apiKey = params?.apiKey || config.omniRouteApiKey;
      if (!url) return { success: false, message: 'OmniRoute URL is required' };
      if (!url.endsWith('/models')) {
        url = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;
      }
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        return { success: true, message: `OmniRoute endpoint reachable`, details: data };
      }
      return { success: false, message: `OmniRoute returned HTTP ${res.status}` };
    }

    if (target === 'openrouter') {
      const apiKey = params?.apiKey || config.openRouterApiKey;
      if (!apiKey) return { success: false, message: 'OpenRouter API Key is empty' };
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, message: 'OpenRouter API key is valid', details: data };
      }
      return { success: false, message: `OpenRouter returned HTTP ${res.status}` };
    }

    if (target === 'gemini') {
      const apiKey = params?.apiKey || process.env.GEMINI_API_KEY || config.geminiApiKey;
      if (!apiKey) return { success: false, message: 'GEMINI_API_KEY is not set' };
      const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
      const resp = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: 'Ping test. Reply with pong.'
      });
      return { success: Boolean(resp.text), message: 'Gemini 3.8 Flash operational' };
    }

    if (target === 'huggingface') {
      const model = params?.model || config.huggingFaceEmbeddingModel || 'monologg/biobert_v1.1_pubmed';
      const apiKey = params?.apiKey || config.huggingFaceApiKey;
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

    return { success: false, message: `Unknown target ${target}` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Connection test failed'
    };
  }
}

export const openRouterService = {
  callOpenRouter,
  callOllama,
  callOmniRoute,
  callGemini,
  executeInference,
  testConnection
};
