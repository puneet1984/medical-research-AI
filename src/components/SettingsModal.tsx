import React, { useState, useEffect } from 'react';
import {
  X,
  Settings,
  Server,
  Key,
  Database,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Cpu,
  Layers,
  Mail,
  ShieldCheck,
  ExternalLink,
  Save,
  Radio,
  Eye,
  EyeOff,
  Sparkles,
  ChevronDown,
  Search,
  Filter
} from 'lucide-react';
import { SettingsData, OpenRouterModelOption } from '../types/research';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved?: () => void;
}

// Built-in curated models so dropdowns are immediately usable before remote fetch
const CURATED_REASONING_PRESETS = [
  { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (Free)', isFree: true, context: '131k' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Full Uncapped)', isFree: false, context: '163k' },
  { id: 'qwen/qwq-32b:free', name: 'Qwen QwQ 32B (Free Reasoning)', isFree: true, context: '32k' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)', isFree: true, context: '131k' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isFree: false, context: '200k' }
];

const CURATED_SYNTHESIS_PRESETS = [
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta Llama 3.3 70B Instruct', isFree: false, context: '131k' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta Llama 3.3 70B Instruct (Free)', isFree: true, context: '131k' },
  { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Exp (Free)', isFree: true, context: '1048k' },
  { id: 'mistralai/mistral-small-3:free', name: 'Mistral Small 3 (Free)', isFree: true, context: '32k' },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA Nemotron 3.5 (Free)', isFree: true, context: '131k' }
];

const CURATED_EMBEDDING_PRESETS = [
  { id: 'text-embedding-004', name: 'Google: text-embedding-004 (768-d Official Free Tier)', isFree: true },
  { id: 'openai/text-embedding-3-small', name: 'OpenAI text-embedding-3-small (1536-d)', isFree: false },
  { id: 'openai/text-embedding-3-large', name: 'OpenAI text-embedding-3-large (3072-d)', isFree: false },
  { id: 'cohere/embed-english-v3.0', name: 'Cohere embed-english-v3.0 (1024-d)', isFree: false },
  { id: 'baai/bge-large-en-v1.5', name: 'BAAI BGE Large EN v1.5 (1024-d)', isFree: true },
  { id: 'sentence-transformers/all-MiniLM-L6-v2', name: 'Sentence Transformers all-MiniLM-L6-v2 (384-d)', isFree: true },
  { id: 'voyageai/voyage-3-lite', name: 'Voyage 3 Lite (512-d)', isFree: false }
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onSettingsSaved
}) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form states
  const [llmProvider, setLlmProvider] = useState<'auto' | 'omniroute' | 'ollama' | 'openrouter' | 'gemini'>('auto');
  const [llmReasoningModel, setLlmReasoningModel] = useState('deepseek/deepseek-r1');
  const [llmSynthesisModel, setLlmSynthesisModel] = useState('meta-llama/llama-3.3-70b-instruct');
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [openRouterMasked, setOpenRouterMasked] = useState('');

  // Ollama
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaLlmModel, setOllamaLlmModel] = useState('llama3:latest');
  const [ollamaEmbeddingModel, setOllamaEmbeddingModel] = useState('nomic-embed-text');

  // OmniRoute
  const [omniRouteUrl, setOmniRouteUrl] = useState('');
  const [omniRouteApiKey, setOmniRouteApiKey] = useState('');
  const [omniRouteMasked, setOmniRouteMasked] = useState('');
  const [omniRouteLlmModel, setOmniRouteLlmModel] = useState('deepseek/deepseek-r1');

  // Embeddings & Google Gemini text-embedding-004
  const [embeddingProvider, setEmbeddingProvider] = useState<'auto' | 'qdrant' | 'gemini' | 'openrouter' | 'huggingface' | 'ollama' | 'local'>('auto');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiMasked, setGeminiMasked] = useState('');
  const [geminiEmbeddingModel, setGeminiEmbeddingModel] = useState('text-embedding-004');
  const [openRouterEmbeddingModel, setOpenRouterEmbeddingModel] = useState('sentence-transformers/all-MiniLM-L6-v2');
  const [huggingFaceApiKey, setHuggingFaceApiKey] = useState('');
  const [huggingFaceMasked, setHuggingFaceMasked] = useState('');
  const [huggingFaceEmbeddingModel, setHuggingFaceEmbeddingModel] = useState('sentence-transformers/all-MiniLM-L6-v2');

  // Scholarly / NCBI
  const [scholarlyEmail, setScholarlyEmail] = useState('researcher@domain.com');
  const [ncbiApiKey, setNcbiApiKey] = useState('');
  const [ncbiMasked, setNcbiMasked] = useState('');

  // Qdrant Vector DB (URL & API Key)
  const [qdrantUrl, setQdrantUrl] = useState('https://bd59148a-dfe3-4984-bcd6-795c770f786d.eu-west-2-0.aws.cloud.qdrant.io:6333');
  const [qdrantApiKey, setQdrantApiKey] = useState('');
  const [qdrantMasked, setQdrantMasked] = useState('');

  // Password visibility toggles
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  // OpenRouter Models State
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModelOption[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelFilterVariant, setModelFilterVariant] = useState<'all' | 'free'>('all');
  const [modelsLoadedAt, setModelsLoadedAt] = useState<string | null>(null);

  // Dropdown combobox states
  const [reasoningDropdownOpen, setReasoningDropdownOpen] = useState(false);
  const [synthesisDropdownOpen, setSynthesisDropdownOpen] = useState(false);
  const [embedDropdownOpen, setEmbedDropdownOpen] = useState(false);
  const [reasoningSearch, setReasoningSearch] = useState('');
  const [synthesisSearch, setSynthesisSearch] = useState('');

  // Connection test statuses
  const [testStatus, setTestStatus] = useState<Record<string, { loading: boolean; success?: boolean; message?: string }>>({});
  const [isCheckingAll, setIsCheckingAll] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
      fetchModels(false);
    }
  }, [isOpen]);

  const toggleShowKey = (keyName: string) => {
    setShowKeys(prev => ({ ...prev, [keyName]: !prev[keyName] }));
  };

  const loadSettings = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.settings) {
        const s: SettingsData = data.settings;
        setLlmProvider(s.llmProvider || 'auto');
        setLlmReasoningModel(s.llmReasoningModel || 'deepseek/deepseek-r1');
        setLlmSynthesisModel(s.llmSynthesisModel || 'meta-llama/llama-3.3-70b-instruct');
        setOpenRouterMasked(s.openRouterApiKeyMasked || '');

        setOllamaUrl(s.ollamaUrl || 'http://localhost:11434');
        setOllamaLlmModel(s.ollamaLlmModel || 'llama3:latest');
        setOllamaEmbeddingModel(s.ollamaEmbeddingModel || 'nomic-embed-text');

        setOmniRouteUrl(s.omniRouteUrl || '');
        setOmniRouteMasked(s.omniRouteApiKeyMasked || '');
        setOmniRouteLlmModel(s.omniRouteLlmModel || 'deepseek/deepseek-r1');

        setEmbeddingProvider(s.embeddingProvider || 'auto');
        setGeminiMasked(s.geminiApiKeyMasked || '');
        setGeminiEmbeddingModel(s.geminiEmbeddingModel || 'text-embedding-004');
        setOpenRouterEmbeddingModel(s.openRouterEmbeddingModel || 'sentence-transformers/all-MiniLM-L6-v2');
        setHuggingFaceMasked(s.huggingFaceApiKeyMasked || '');
        setHuggingFaceEmbeddingModel(s.huggingFaceEmbeddingModel || 'sentence-transformers/all-MiniLM-L6-v2');

        setScholarlyEmail(s.scholarlyEmail || 'researcher@domain.com');
        setNcbiMasked(s.ncbiApiKeyMasked || '');

        setQdrantUrl(s.qdrantUrl || 'https://bd59148a-dfe3-4984-bcd6-795c770f786d.eu-west-2-0.aws.cloud.qdrant.io:6333');
        setQdrantMasked(s.qdrantApiKeyMasked || '');
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
      setErrorMsg('Failed to load active environment settings');
    } finally {
      setLoading(false);
    }
  };

  // Fetch real-time model catalog from OpenRouter
  const fetchModels = async (forceRefresh = false) => {
    setIsLoadingModels(true);
    try {
      const url = `/api/openrouter/models?refresh=${forceRefresh}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.models) && data.models.length > 0) {
          setOpenRouterModels(data.models);
          setModelsLoadedAt(new Date().toLocaleTimeString());
        }
      }
    } catch (err) {
      console.warn('Could not fetch OpenRouter models:', err);
    } finally {
      setIsLoadingModels(false);
    }
  };

  // Test individual provider credentials or connection
  const handleTest = async (target: 'ollama' | 'omniroute' | 'openrouter' | 'gemini' | 'huggingface' | 'qdrant' | 'ncbi') => {
    setTestStatus(prev => ({ ...prev, [target]: { loading: true } }));
    try {
      const params: Record<string, string> = {};
      if (target === 'ollama') params.url = ollamaUrl;
      if (target === 'omniroute') {
        params.url = omniRouteUrl;
        if (omniRouteApiKey) params.apiKey = omniRouteApiKey;
      }
      if (target === 'openrouter') {
        if (openRouterApiKey) params.apiKey = openRouterApiKey;
      }
      if (target === 'gemini') {
        params.model = geminiEmbeddingModel || 'text-embedding-004';
        if (geminiApiKey) params.apiKey = geminiApiKey;
      }
      if (target === 'huggingface') {
        params.model = huggingFaceEmbeddingModel;
        if (huggingFaceApiKey) params.apiKey = huggingFaceApiKey;
      }
      if (target === 'qdrant') {
        params.url = qdrantUrl;
        if (qdrantApiKey) params.apiKey = qdrantApiKey;
      }
      if (target === 'ncbi') {
        params.email = scholarlyEmail;
        if (ncbiApiKey) params.apiKey = ncbiApiKey;
      }

      const res = await fetch('/api/settings/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, params })
      });
      const data = await res.json();
      setTestStatus(prev => ({
        ...prev,
        [target]: { loading: false, success: data.success, message: data.message }
      }));
    } catch (err) {
      setTestStatus(prev => ({
        ...prev,
        [target]: {
          loading: false,
          success: false,
          message: err instanceof Error ? err.message : 'Connection test failed'
        }
      }));
    }
  };

  // Check all configured API keys & endpoints concurrently
  const handleCheckAll = async () => {
    setIsCheckingAll(true);
    const targets: Array<'qdrant' | 'openrouter' | 'gemini' | 'huggingface' | 'ollama' | 'omniroute' | 'ncbi'> = [
      'qdrant',
      'openrouter',
      'gemini',
      'huggingface',
      'ollama',
      'omniroute',
      'ncbi'
    ];

    try {
      await Promise.allSettled(targets.map(t => handleTest(t)));
    } finally {
      setIsCheckingAll(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);
    setSaveSuccess(false);

    const payload: Record<string, unknown> = {
      llmProvider,
      llmReasoningModel: (llmReasoningModel || '').trim() || 'deepseek/deepseek-r1',
      llmSynthesisModel: (llmSynthesisModel || '').trim() || 'meta-llama/llama-3.3-70b-instruct',
      ollamaUrl: (ollamaUrl || '').trim() || 'http://localhost:11434',
      ollamaLlmModel: (ollamaLlmModel || '').trim() || 'llama3:latest',
      ollamaEmbeddingModel: (ollamaEmbeddingModel || '').trim() || 'nomic-embed-text',
      omniRouteUrl: (omniRouteUrl || '').trim(),
      omniRouteLlmModel: (omniRouteLlmModel || '').trim() || 'deepseek/deepseek-r1',
      embeddingProvider,
      geminiEmbeddingModel: (geminiEmbeddingModel || '').trim() || 'text-embedding-004',
      openRouterEmbeddingModel: (openRouterEmbeddingModel || '').trim() || 'sentence-transformers/all-MiniLM-L6-v2',
      huggingFaceEmbeddingModel: (huggingFaceEmbeddingModel || '').trim() || 'sentence-transformers/all-MiniLM-L6-v2',
      scholarlyEmail: (scholarlyEmail || '').trim() || 'researcher@domain.com',
      qdrantUrl: (qdrantUrl || '').trim() || 'https://bd59148a-dfe3-4984-bcd6-795c770f786d.eu-west-2-0.aws.cloud.qdrant.io:6333'
    };

    if (geminiApiKey.trim()) payload.geminiApiKey = geminiApiKey.trim();
    if (openRouterApiKey.trim()) payload.openRouterApiKey = openRouterApiKey.trim();
    if (omniRouteApiKey.trim()) payload.omniRouteApiKey = omniRouteApiKey.trim();
    if (huggingFaceApiKey.trim()) payload.huggingFaceApiKey = huggingFaceApiKey.trim();
    if (ncbiApiKey.trim()) payload.ncbiApiKey = ncbiApiKey.trim();
    if (qdrantApiKey.trim()) payload.qdrantApiKey = qdrantApiKey.trim();

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        if (data.settings) {
          const s: SettingsData = data.settings;
          if (s.llmProvider) setLlmProvider(s.llmProvider);
          if (s.llmReasoningModel) setLlmReasoningModel(s.llmReasoningModel);
          if (s.llmSynthesisModel) setLlmSynthesisModel(s.llmSynthesisModel);
          if (s.ollamaUrl) setOllamaUrl(s.ollamaUrl);
          if (s.ollamaLlmModel) setOllamaLlmModel(s.ollamaLlmModel);
          if (s.ollamaEmbeddingModel) setOllamaEmbeddingModel(s.ollamaEmbeddingModel);
          if (s.omniRouteUrl !== undefined) setOmniRouteUrl(s.omniRouteUrl);
          if (s.omniRouteLlmModel) setOmniRouteLlmModel(s.omniRouteLlmModel);
          if (s.embeddingProvider) setEmbeddingProvider(s.embeddingProvider);
          if (s.geminiEmbeddingModel) setGeminiEmbeddingModel(s.geminiEmbeddingModel);
          if (s.openRouterEmbeddingModel) setOpenRouterEmbeddingModel(s.openRouterEmbeddingModel);
          if (s.huggingFaceEmbeddingModel) setHuggingFaceEmbeddingModel(s.huggingFaceEmbeddingModel);
          if (s.scholarlyEmail) setScholarlyEmail(s.scholarlyEmail);
          if (s.qdrantUrl) setQdrantUrl(s.qdrantUrl);
          if (s.openRouterApiKeyMasked) setOpenRouterMasked(s.openRouterApiKeyMasked);
          if (s.geminiApiKeyMasked) setGeminiMasked(s.geminiApiKeyMasked);
          if (s.omniRouteApiKeyMasked) setOmniRouteMasked(s.omniRouteApiKeyMasked);
          if (s.huggingFaceApiKeyMasked) setHuggingFaceMasked(s.huggingFaceApiKeyMasked);
          if (s.ncbiApiKeyMasked) setNcbiMasked(s.ncbiApiKeyMasked);
          if (s.qdrantApiKeyMasked) setQdrantMasked(s.qdrantApiKeyMasked);
        }

        // Clear plain text credentials from component state
        setOpenRouterApiKey('');
        setGeminiApiKey('');
        setOmniRouteApiKey('');
        setHuggingFaceApiKey('');
        setNcbiApiKey('');
        setQdrantApiKey('');

        setSaveSuccess(true);
        if (onSettingsSaved) onSettingsSaved();
        setTimeout(() => setSaveSuccess(false), 4500);
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update runtime environment');
    } finally {
      setSaving(false);
    }
  };

  // Filtered OpenRouter models for dropdowns
  const filteredModels = openRouterModels.filter(m => {
    if (modelFilterVariant === 'free' && !m.isFree) return false;
    return true;
  });

  const reasoningOptions = filteredModels.filter(m => {
    if (m.isEmbedding) return false;
    if (reasoningSearch.trim()) {
      const q = reasoningSearch.toLowerCase();
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    }
    return true;
  });

  const synthesisOptions = filteredModels.filter(m => {
    if (m.isEmbedding) return false;
    if (synthesisSearch.trim()) {
      const q = synthesisSearch.toLowerCase();
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    }
    return true;
  });

  const embeddingOptions = openRouterModels.filter(m => m.isEmbedding);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-teal-600 text-white rounded-lg shadow-xs">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Runtime Environment &amp; Engine Settings</h2>
              <p className="text-xs text-slate-500">
                Configure Qdrant URL &amp; API Key, OpenRouter model dropdowns, Ollama, OmniRoute, and credential verification
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCheckAll}
              disabled={isCheckingAll}
              className="text-xs px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg font-medium transition-colors flex items-center gap-1.5 shadow-2xs disabled:opacity-60"
              title="Test all credentials and endpoints at once"
            >
              {isCheckingAll ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />}
              <span>Check All API Keys &amp; Endpoints</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content form */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
          {saveSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center gap-2.5 text-xs font-medium">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              <div>
                <div className="font-semibold text-emerald-900">
                  Settings &amp; AI models saved and applied immediately!
                </div>
                <div className="text-[11px] text-emerald-700 mt-0.5 font-normal">
                  Reasoning: <span className="font-mono font-semibold">{llmReasoningModel}</span> • Synthesis: <span className="font-mono font-semibold">{llmSynthesisModel}</span> • Embeddings: <span className="font-mono font-semibold">{embeddingProvider}</span> • Persisted to volume storage at <code className="bg-emerald-100/70 px-1 rounded">/app/data/persistent-settings.json</code>.
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg flex items-center gap-2 text-xs">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Section 1: Primary LLM Inference & OpenRouter Models */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-teal-600" />
                <h3 className="font-semibold text-slate-900 text-sm">Primary LLM Inference Engine &amp; Models</h3>
              </div>
              <span className="text-[11px] text-slate-500">Select active provider</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
              {[
                { id: 'auto', label: 'Auto (Smart Fallback)' },
                { id: 'omniroute', label: 'OmniRoute Proxy' },
                { id: 'ollama', label: 'Ollama Local' },
                { id: 'openrouter', label: 'OpenRouter' },
                { id: 'gemini', label: 'Google Gemini' }
              ].map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setLlmProvider(item.id as any)}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border text-center transition-all ${
                    llmProvider === item.id
                      ? 'bg-teal-600 text-white border-teal-600 shadow-xs'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-teal-300 hover:bg-teal-50/30'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* OpenRouter Model Catalog Bar */}
            <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4 shadow-2xs">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-500" />
                  <span className="text-xs font-semibold text-slate-800">OpenRouter Model Catalog &amp; Dropdowns</span>
                  {modelsLoadedAt && (
                    <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                      Updated {modelsLoadedAt} ({openRouterModels.length} models)
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* Free vs All variant filter */}
                  <div className="flex items-center bg-slate-100 p-0.5 rounded-md border border-slate-200 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setModelFilterVariant('all')}
                      className={`px-2 py-0.5 rounded font-medium transition-colors ${
                        modelFilterVariant === 'all'
                          ? 'bg-white text-slate-800 shadow-2xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      All Models
                    </button>
                    <button
                      type="button"
                      onClick={() => setModelFilterVariant('free')}
                      className={`px-2 py-0.5 rounded font-medium transition-colors flex items-center gap-1 ${
                        modelFilterVariant === 'free'
                          ? 'bg-emerald-600 text-white shadow-2xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <span>Free Models Only</span>
                      <span className="text-[9px] px-1 py-0.2 bg-emerald-700/40 rounded text-emerald-100 font-mono">:free</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => fetchModels(true)}
                    disabled={isLoadingModels}
                    className="text-[11px] px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-60"
                    title="Fetch live model list directly from OpenRouter API"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingModels ? 'animate-spin' : ''}`} />
                    <span>{isLoadingModels ? 'Fetching...' : 'Fetch OpenRouter Models'}</span>
                  </button>
                </div>
              </div>

              {/* Direct reference links to OpenRouter model catalog */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 pt-1.5 border-t border-slate-100">
                <span className="text-slate-400">OpenRouter Free Catalog:</span>
                <a
                  href="https://openrouter.ai/models?output_modalities=text&variant=free"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-700 hover:text-teal-800 font-medium flex items-center gap-0.5 underline decoration-teal-300 underline-offset-2"
                >
                  <span>Free Text / Chat Models</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-slate-300">•</span>
                <a
                  href="https://openrouter.ai/models?output_modalities=embeddings&variant=free"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-700 hover:text-teal-800 font-medium flex items-center gap-0.5 underline decoration-teal-300 underline-offset-2"
                >
                  <span>Free Embedding Models</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            {/* Model Selection Dropdowns with Search & Custom Input */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Reasoning LLM Model Dropdown */}
              <div className="relative">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                    <span>Reasoning LLM Model (DeepSeek-R1 / CoT)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setReasoningDropdownOpen(!reasoningDropdownOpen)}
                    className="text-[11px] text-teal-600 hover:text-teal-800 font-medium flex items-center gap-0.5"
                  >
                    <span>{reasoningDropdownOpen ? 'Close list' : 'Select from OpenRouter'}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${reasoningDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>

                <div className="relative">
                  <input
                    type="text"
                    value={llmReasoningModel}
                    onChange={e => setLlmReasoningModel(e.target.value)}
                    placeholder="deepseek/deepseek-r1"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
                </div>

                {/* Quick Presets */}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {CURATED_REASONING_PRESETS.slice(0, 3).map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setLlmReasoningModel(p.id)}
                      className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                        llmReasoningModel === p.id
                          ? 'bg-teal-100 text-teal-800 border-teal-300 font-semibold'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>

                {/* OpenRouter Reasoning Dropdown Popover */}
                {reasoningDropdownOpen && (
                  <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden max-h-64 flex flex-col">
                    <div className="p-2 border-b border-slate-100 bg-slate-50 flex items-center gap-1.5">
                      <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <input
                        type="text"
                        value={reasoningSearch}
                        onChange={e => setReasoningSearch(e.target.value)}
                        placeholder="Search models (e.g. deepseek, llama, free)..."
                        className="w-full text-xs bg-transparent border-none focus:outline-none text-slate-700"
                        autoFocus
                      />
                    </div>
                    <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
                      {reasoningOptions.length === 0 ? (
                        <div className="p-3 text-xs text-slate-400 text-center">
                          No matching models found in OpenRouter list
                        </div>
                      ) : (
                        reasoningOptions.slice(0, 50).map(m => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setLlmReasoningModel(m.id);
                              setReasoningDropdownOpen(false);
                            }}
                            className={`w-full text-left p-2 hover:bg-teal-50/60 transition-colors flex items-center justify-between text-xs ${
                              llmReasoningModel === m.id ? 'bg-teal-50 font-medium' : ''
                            }`}
                          >
                            <div className="truncate mr-2">
                              <div className="font-mono text-slate-800 truncate">{m.id}</div>
                              <div className="text-[10px] text-slate-400 truncate">{m.name}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {m.isFree && (
                                <span className="text-[9px] px-1.5 py-0.2 bg-emerald-100 text-emerald-800 font-bold rounded">
                                  FREE
                                </span>
                              )}
                              {m.contextLength && (
                                <span className="text-[10px] text-slate-400 font-mono">
                                  {Math.round(m.contextLength / 1000)}k
                                </span>
                              )}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Synthesis LLM Model Dropdown */}
              <div className="relative">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                    <span>Synthesis LLM Model (Clinical Writer &amp; PICO)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setSynthesisDropdownOpen(!synthesisDropdownOpen)}
                    className="text-[11px] text-teal-600 hover:text-teal-800 font-medium flex items-center gap-0.5"
                  >
                    <span>{synthesisDropdownOpen ? 'Close list' : 'Select from OpenRouter'}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${synthesisDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>

                <div className="relative">
                  <input
                    type="text"
                    value={llmSynthesisModel}
                    onChange={e => setLlmSynthesisModel(e.target.value)}
                    placeholder="meta-llama/llama-3.3-70b-instruct"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
                </div>

                {/* Quick Presets */}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {CURATED_SYNTHESIS_PRESETS.slice(0, 3).map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setLlmSynthesisModel(p.id)}
                      className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                        llmSynthesisModel === p.id
                          ? 'bg-teal-100 text-teal-800 border-teal-300 font-semibold'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>

                {/* OpenRouter Synthesis Dropdown Popover */}
                {synthesisDropdownOpen && (
                  <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden max-h-64 flex flex-col">
                    <div className="p-2 border-b border-slate-100 bg-slate-50 flex items-center gap-1.5">
                      <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <input
                        type="text"
                        value={synthesisSearch}
                        onChange={e => setSynthesisSearch(e.target.value)}
                        placeholder="Search models (e.g. llama, gemini, free)..."
                        className="w-full text-xs bg-transparent border-none focus:outline-none text-slate-700"
                        autoFocus
                      />
                    </div>
                    <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
                      {synthesisOptions.length === 0 ? (
                        <div className="p-3 text-xs text-slate-400 text-center">
                          No matching models found in OpenRouter list
                        </div>
                      ) : (
                        synthesisOptions.slice(0, 50).map(m => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setLlmSynthesisModel(m.id);
                              setSynthesisDropdownOpen(false);
                            }}
                            className={`w-full text-left p-2 hover:bg-teal-50/60 transition-colors flex items-center justify-between text-xs ${
                              llmSynthesisModel === m.id ? 'bg-teal-50 font-medium' : ''
                            }`}
                          >
                            <div className="truncate mr-2">
                              <div className="font-mono text-slate-800 truncate">{m.id}</div>
                              <div className="text-[10px] text-slate-400 truncate">{m.name}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {m.isFree && (
                                <span className="text-[9px] px-1.5 py-0.2 bg-emerald-100 text-emerald-800 font-bold rounded">
                                  FREE
                                </span>
                              )}
                              {m.contextLength && (
                                <span className="text-[10px] text-slate-400 font-mono">
                                  {Math.round(m.contextLength / 1000)}k
                                </span>
                              )}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Section 2: Qdrant Vector Database (Two Variables: URL & API Key) */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white shadow-2xs">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-rose-600" />
                <div>
                  <h3 className="font-semibold text-slate-900 text-sm">Qdrant Vector Database</h3>
                  <p className="text-[11px] text-slate-500">
                    High-performance dense vector search &amp; persistent clinical evidence storage (URL &amp; API Key)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleTest('qdrant')}
                disabled={testStatus.qdrant?.loading || !qdrantUrl}
                className="text-[11px] px-2.5 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                {testStatus.qdrant?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                <span>Check Qdrant DB &amp; Key</span>
              </button>
            </div>

            {testStatus.qdrant && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.qdrant.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.qdrant.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.qdrant.message}</span>
              </div>
            )}

            {/* Vector Dimension & Model Synchronization Banner */}
            <div className="bg-slate-50 border border-slate-200/90 rounded-lg p-2.5 mb-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-700">Active Vector Space:</span>
                <span className="font-mono text-teal-800 bg-teal-50 px-2 py-0.5 rounded border border-teal-200 font-bold">
                  {embeddingProvider === 'gemini'
                    ? '768-d • Google text-embedding-004'
                    : embeddingProvider === 'huggingface'
                    ? '384-d / 768-d • Hugging Face'
                    : embeddingProvider === 'openrouter'
                    ? '384-d • OpenRouter'
                    : embeddingProvider === 'local'
                    ? '384-d • Local MiniLM-Aligned'
                    : '384-d • Qdrant sentence-transformers/all-minilm-l6-v2'}
                </span>
              </div>
              <span className="text-[11px] text-slate-500">
                Uniform 384-d default guaranteed across Qdrant storage &amp; embedding retrieval to prevent index mismatch failures
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Qdrant URL */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Qdrant URL <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={qdrantUrl}
                  onChange={e => setQdrantUrl(e.target.value)}
                  placeholder="https://bd59148a-dfe3-4984-bcd6-795c770f786d.eu-west-2-0.aws.cloud.qdrant.io:6333"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none bg-slate-50/50"
                />
                <span className="text-[10px] text-slate-400">
                  Default Qdrant Cloud URL or local <code className="bg-slate-100 px-1 py-0.5 rounded">http://localhost:6333</code>
                </span>
              </div>

              {/* Qdrant API Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700">
                    Qdrant API Key {qdrantMasked && <span className="text-slate-400 font-mono font-normal">({qdrantMasked})</span>}
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleShowKey('qdrant')}
                    className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                  >
                    {showKeys.qdrant ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showKeys.qdrant ? 'Hide' : 'Show'}</span>
                  </button>
                </div>
                <input
                  type={showKeys.qdrant ? 'text' : 'password'}
                  value={qdrantApiKey}
                  onChange={e => setQdrantApiKey(e.target.value)}
                  placeholder={qdrantMasked ? 'Leave empty to retain existing key' : 'Enter Qdrant API key (required for Qdrant Cloud)'}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-400">
                  Required for Qdrant Cloud clusters or secured on-prem instances; optional for unauthenticated local Docker instances
                </span>
              </div>
            </div>
          </div>

          {/* Section 3: OpenRouter API Key & Scholarly Credentials */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white shadow-2xs">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-600" />
                <h3 className="font-semibold text-slate-900 text-sm">OpenRouter &amp; Scholarly Credentials</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTest('openrouter')}
                  disabled={testStatus.openrouter?.loading || (!openRouterApiKey && !openRouterMasked)}
                  className="text-[11px] px-2.5 py-1 bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                >
                  {testStatus.openrouter?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                  <span>Check OpenRouter Key</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTest('ncbi')}
                  disabled={testStatus.ncbi?.loading}
                  className="text-[11px] px-2.5 py-1 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                >
                  {testStatus.ncbi?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                  <span>Check NCBI Key</span>
                </button>
              </div>
            </div>

            {testStatus.openrouter && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.openrouter.success ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.openrouter.success ? <CheckCircle2 className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.openrouter.message}</span>
              </div>
            )}

            {testStatus.ncbi && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.ncbi.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.ncbi.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.ncbi.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-700">
                    OpenRouter API Key {openRouterMasked && <span className="text-slate-400 font-mono">({openRouterMasked})</span>}
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleShowKey('openrouter')}
                    className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                  >
                    {showKeys.openrouter ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showKeys.openrouter ? 'Hide' : 'Show'}</span>
                  </button>
                </div>
                <input
                  type={showKeys.openrouter ? 'text' : 'password'}
                  value={openRouterApiKey}
                  onChange={e => setOpenRouterApiKey(e.target.value)}
                  placeholder={openRouterMasked ? 'Leave empty to retain existing key' : 'sk-or-v1-...'}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500">
                  Enables DeepSeek-R1, Llama 3.3 70B, and OpenRouter inference
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-700">
                    NCBI Entrez API Key (Optional) {ncbiMasked && <span className="text-slate-400 font-mono">({ncbiMasked})</span>}
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleShowKey('ncbi')}
                    className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                  >
                    {showKeys.ncbi ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showKeys.ncbi ? 'Hide' : 'Show'}</span>
                  </button>
                </div>
                <input
                  type={showKeys.ncbi ? 'text' : 'password'}
                  value={ncbiApiKey}
                  onChange={e => setNcbiApiKey(e.target.value)}
                  placeholder={ncbiMasked ? 'Leave empty to retain existing key' : 'Optional NCBI Entrez API key'}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-emerald-600">
                  Unlocks up to 10 requests/sec under official NCBI NBK25497 guidelines
                </span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Scholarly User-Agent Contact Email
              </label>
              <input
                type="email"
                value={scholarlyEmail}
                onChange={e => setScholarlyEmail(e.target.value)}
                placeholder="researcher@domain.com"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-teal-500 focus:outline-none"
              />
              <span className="text-[10px] text-slate-500">
                Required identification header by NCBI E-Utilities &amp; OpenAlex polite retrieval pools
              </span>
            </div>
          </div>

          {/* Section 4: Ollama Local / Remote Instance */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white shadow-2xs">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-emerald-600" />
                <h3 className="font-semibold text-slate-900 text-sm">Ollama Local / Remote Instance</h3>
              </div>
              <button
                type="button"
                onClick={() => handleTest('ollama')}
                disabled={testStatus.ollama?.loading}
                className="text-[11px] px-2.5 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded font-medium transition-colors flex items-center gap-1"
              >
                {testStatus.ollama?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                <span>Check Ollama Server</span>
              </button>
            </div>

            {testStatus.ollama && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.ollama.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.ollama.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.ollama.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Ollama Base URL
                </label>
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={e => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-400">Default: http://localhost:11434</span>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Ollama LLM Model
                </label>
                <input
                  type="text"
                  value={ollamaLlmModel}
                  onChange={e => setOllamaLlmModel(e.target.value)}
                  placeholder="llama3:latest"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Ollama Embedding Model
                </label>
                <input
                  type="text"
                  value={ollamaEmbeddingModel}
                  onChange={e => setOllamaEmbeddingModel(e.target.value)}
                  placeholder="nomic-embed-text"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section 5: OmniRoute Proxy & Unified Router */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white shadow-2xs">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Radio className="w-4 h-4 text-indigo-600" />
                <h3 className="font-semibold text-slate-900 text-sm">OmniRoute / OpenAI-Compatible Router</h3>
              </div>
              <button
                type="button"
                onClick={() => handleTest('omniroute')}
                disabled={testStatus.omniroute?.loading || !omniRouteUrl}
                className="text-[11px] px-2.5 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                {testStatus.omniroute?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                <span>Check OmniRoute Key &amp; URL</span>
              </button>
            </div>

            {testStatus.omniroute && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.omniroute.success ? 'bg-indigo-50 text-indigo-800 border border-indigo-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.omniroute.success ? <CheckCircle2 className="w-3.5 h-3.5 text-indigo-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.omniroute.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  OmniRoute API Base URL
                </label>
                <input
                  type="text"
                  value={omniRouteUrl}
                  onChange={e => setOmniRouteUrl(e.target.value)}
                  placeholder="https://api.omniroute.ai/v1"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-600">
                    OmniRoute API Key {omniRouteMasked && <span className="text-slate-400 font-mono">({omniRouteMasked})</span>}
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleShowKey('omniroute')}
                    className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                  >
                    {showKeys.omniroute ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showKeys.omniroute ? 'Hide' : 'Show'}</span>
                  </button>
                </div>
                <input
                  type={showKeys.omniroute ? 'text' : 'password'}
                  value={omniRouteApiKey}
                  onChange={e => setOmniRouteApiKey(e.target.value)}
                  placeholder={omniRouteMasked ? 'Leave empty to retain existing key' : 'Enter OmniRoute API Key'}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Default OmniRoute Model
                </label>
                <input
                  type="text"
                  value={omniRouteLlmModel}
                  onChange={e => setOmniRouteLlmModel(e.target.value)}
                  placeholder="deepseek/deepseek-r1"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section 6: Vector Embeddings Engine & Hugging Face Key */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-teal-600" />
                <h3 className="font-semibold text-slate-900 text-sm">Vector Embeddings Provider &amp; Model</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTest('gemini')}
                  disabled={testStatus.gemini?.loading}
                  className="text-[11px] px-2.5 py-1 bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                  title="Test Google text-embedding-004 model directly"
                >
                  {testStatus.gemini?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                  <span>Check Google text-embedding-004</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTest('huggingface')}
                  disabled={testStatus.huggingface?.loading}
                  className="text-[11px] px-2.5 py-1 bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                >
                  {testStatus.huggingface?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                  <span>Check HF Token &amp; Model</span>
                </button>
              </div>
            </div>

            {testStatus.gemini && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.gemini.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.gemini.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.gemini.message}</span>
              </div>
            )}

            {testStatus.huggingface && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.huggingface.success ? 'bg-teal-50 text-teal-800 border border-teal-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.huggingface.success ? <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                <span>{testStatus.huggingface.message}</span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 mb-4">
              {[
                { id: 'auto', label: 'Auto (384-d MiniLM)' },
                { id: 'qdrant', label: 'Qdrant Cloud (384-d)' },
                { id: 'local', label: 'Local (384-d Free)' },
                { id: 'gemini', label: 'Gemini (768-d)' },
                { id: 'ollama', label: 'Ollama (Local)' },
                { id: 'openrouter', label: 'OpenRouter' },
                { id: 'huggingface', label: 'Hugging Face' }
              ].map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setEmbeddingProvider(item.id as any)}
                  className={`px-2.5 py-2 text-xs font-medium rounded-lg border text-center transition-all ${
                    embeddingProvider === item.id
                      ? 'bg-teal-600 text-white border-teal-600 shadow-xs'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-teal-300'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* Google Gemini text-embedding-004 Box */}
            <div className="bg-white border border-teal-200/90 rounded-lg p-3.5 mb-4 shadow-2xs">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 bg-teal-600 text-white rounded font-bold text-[10px] tracking-wide">
                    GOOGLE
                  </span>
                  <span className="text-xs font-bold text-slate-900">Google text-embedding-004 Model</span>
                  <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-800 font-medium rounded-full">
                    Free Tier: 1,500 Requests/min on Google AI Studio
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Google Embedding Model ID
                  </label>
                  <input
                    type="text"
                    value={geminiEmbeddingModel}
                    onChange={e => setGeminiEmbeddingModel(e.target.value)}
                    placeholder="text-embedding-004"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none bg-slate-50/50"
                  />
                  <span className="text-[10px] text-slate-500">
                    Dense 768-d semantic embeddings; optimized for medical &amp; clinical RAG
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-700">
                      Google Gemini API Key {geminiMasked && <span className="text-slate-400 font-mono font-normal">({geminiMasked})</span>}
                    </label>
                    <button
                      type="button"
                      onClick={() => toggleShowKey('gemini')}
                      className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                    >
                      {showKeys.gemini ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      <span>{showKeys.gemini ? 'Hide' : 'Show'}</span>
                    </button>
                  </div>
                  <input
                    type={showKeys.gemini ? 'text' : 'password'}
                    value={geminiApiKey}
                    onChange={e => setGeminiApiKey(e.target.value)}
                    placeholder={geminiMasked ? 'Leave empty to retain existing key' : 'Enter GEMINI_API_KEY from Google AI Studio'}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none bg-white"
                  />
                  <span className="text-[10px] text-slate-400">
                    Get free API key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-teal-600 underline">aistudio.google.com</a>
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-3">
              {/* OpenRouter Embedding Model with Dropdown */}
              <div className="relative">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-700">
                    OpenRouter Embedding Model
                  </label>
                  <button
                    type="button"
                    onClick={() => setEmbedDropdownOpen(!embedDropdownOpen)}
                    className="text-[11px] text-teal-600 hover:text-teal-800 font-medium flex items-center gap-0.5"
                  >
                    <span>{embedDropdownOpen ? 'Close' : 'Presets'}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${embedDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                <input
                  type="text"
                  value={openRouterEmbeddingModel}
                  onChange={e => setOpenRouterEmbeddingModel(e.target.value)}
                  placeholder="openai/text-embedding-3-small"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none bg-white"
                />

                {embedDropdownOpen && (
                  <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden max-h-56 divide-y divide-slate-100">
                    {CURATED_EMBEDDING_PRESETS.map(ep => (
                      <button
                        key={ep.id}
                        type="button"
                        onClick={() => {
                          setOpenRouterEmbeddingModel(ep.id);
                          setEmbedDropdownOpen(false);
                        }}
                        className={`w-full text-left p-2 hover:bg-teal-50/60 transition-colors flex items-center justify-between text-xs ${
                          openRouterEmbeddingModel === ep.id ? 'bg-teal-50 font-medium' : ''
                        }`}
                      >
                        <div className="truncate mr-2">
                          <div className="font-mono text-slate-800 truncate">{ep.id}</div>
                          <div className="text-[10px] text-slate-400 truncate">{ep.name}</div>
                        </div>
                        {ep.isFree && (
                          <span className="text-[9px] px-1.5 py-0.2 bg-emerald-100 text-emerald-800 font-bold rounded shrink-0">
                            FREE
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Hugging Face User Access Token */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-700">
                    Hugging Face Token {huggingFaceMasked && <span className="text-slate-400 font-mono">({huggingFaceMasked})</span>}
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleShowKey('hf')}
                    className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                  >
                    {showKeys.hf ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showKeys.hf ? 'Hide' : 'Show'}</span>
                  </button>
                </div>
                <input
                  type={showKeys.hf ? 'text' : 'password'}
                  value={huggingFaceApiKey}
                  onChange={e => setHuggingFaceApiKey(e.target.value)}
                  placeholder={huggingFaceMasked ? 'Leave empty to retain existing key' : 'hf_...'}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none bg-white"
                />
                <span className="text-[10px] text-slate-500">Free from huggingface.co/settings/tokens</span>
              </div>

              {/* Hugging Face Embedding Model */}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hugging Face Embedding Model
                </label>
                <input
                  type="text"
                  value={huggingFaceEmbeddingModel}
                  onChange={e => setHuggingFaceEmbeddingModel(e.target.value)}
                  placeholder="sentence-transformers/all-MiniLM-L6-v2"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none bg-white"
                />
              </div>
            </div>

            {/* Biomedical Model Preset Shortcuts */}
            <div className="pt-2 border-t border-slate-200/80">
              <span className="text-[11px] font-semibold text-slate-600 block mb-1.5">
                Recommended Biomedical &amp; Clinical Embedding Models:
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setGeminiEmbeddingModel('text-embedding-004');
                    setEmbeddingProvider('gemini');
                  }}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded border transition-colors flex items-center gap-1 ${
                    embeddingProvider === 'gemini' && geminiEmbeddingModel === 'text-embedding-004'
                      ? 'bg-teal-600 text-white border-teal-600 font-semibold shadow-2xs'
                      : 'bg-teal-50 text-teal-800 border-teal-200 hover:border-teal-300 hover:bg-teal-100/70'
                  }`}
                >
                  <span className="font-bold">★ Google text-embedding-004</span>
                  <span className="text-[9px] opacity-80">(Official 768-d Free Tier)</span>
                </button>
                {[
                  { id: 'monologg/biobert_v1.1_pubmed', label: 'monologg/biobert_v1.1_pubmed (BioBERT PubMed 768-d)' },
                  { id: 'NeuML/pubmedbert-base-embeddings', label: 'NeuML/pubmedbert-base-embeddings (SOTA Clinical 768-d)' },
                  { id: 'pritamdeka/S-BioBert-snli-multinli-stsb', label: 'pritamdeka/S-BioBert (Sentence BioBERT 768-d)' },
                  { id: 'sentence-transformers/all-MiniLM-L6-v2', label: 'all-MiniLM-L6-v2 (Fast 384-d)' }
                ].map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setHuggingFaceEmbeddingModel(preset.id);
                      setEmbeddingProvider('huggingface');
                    }}
                    className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors ${
                      huggingFaceEmbeddingModel === preset.id
                        ? 'bg-teal-100 text-teal-800 border-teal-300 font-semibold'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-teal-300 hover:bg-slate-50'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </form>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span>Variables &amp; API keys persist in mounted volume (<code className="text-teal-700 bg-white px-1 rounded border">/app/data</code>) across container restarts.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg shadow-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              <span>Save &amp; Apply Immediately</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
