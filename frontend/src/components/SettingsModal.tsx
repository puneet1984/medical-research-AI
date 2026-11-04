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
  Radio
} from 'lucide-react';
import { SettingsData } from '../types/research';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved?: () => void;
}

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

  // Embeddings
  const [embeddingProvider, setEmbeddingProvider] = useState<'auto' | 'gemini' | 'openrouter' | 'huggingface' | 'ollama' | 'local'>('auto');
  const [openRouterEmbeddingModel, setOpenRouterEmbeddingModel] = useState('openai/text-embedding-3-small');
  const [huggingFaceApiKey, setHuggingFaceApiKey] = useState('');
  const [huggingFaceMasked, setHuggingFaceMasked] = useState('');
  const [huggingFaceEmbeddingModel, setHuggingFaceEmbeddingModel] = useState('sentence-transformers/all-MiniLM-L6-v2');

  // Scholarly / NCBI
  const [scholarlyEmail, setScholarlyEmail] = useState('researcher@domain.com');
  const [ncbiApiKey, setNcbiApiKey] = useState('');
  const [ncbiMasked, setNcbiMasked] = useState('');

  // Qdrant
  const [qdrantUrl, setQdrantUrl] = useState('http://localhost:6333');
  const [qdrantApiKey, setQdrantApiKey] = useState('');
  const [qdrantMasked, setQdrantMasked] = useState('');

  // Connection test statuses
  const [testStatus, setTestStatus] = useState<Record<string, { loading: boolean; success?: boolean; message?: string }>>({});

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

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
        setOpenRouterEmbeddingModel(s.openRouterEmbeddingModel || 'openai/text-embedding-3-small');
        setHuggingFaceMasked(s.huggingFaceApiKeyMasked || '');
        setHuggingFaceEmbeddingModel(s.huggingFaceEmbeddingModel || 'sentence-transformers/all-MiniLM-L6-v2');

        setScholarlyEmail(s.scholarlyEmail || 'researcher@domain.com');
        setNcbiMasked(s.ncbiApiKeyMasked || '');

        setQdrantUrl(s.qdrantUrl || 'http://localhost:6333');
        setQdrantMasked(s.qdrantApiKeyMasked || '');
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
      setErrorMsg('Failed to load active environment settings');
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async (target: 'ollama' | 'omniroute' | 'openrouter' | 'gemini' | 'huggingface') => {
    setTestStatus(prev => ({ ...prev, [target]: { loading: true } }));
    try {
      const params: Record<string, string> = {};
      if (target === 'ollama') params.url = ollamaUrl;
      if (target === 'omniroute') {
        params.url = omniRouteUrl;
        if (omniRouteApiKey) params.apiKey = omniRouteApiKey;
      }
      if (target === 'openrouter' && openRouterApiKey) params.apiKey = openRouterApiKey;
      if (target === 'huggingface') {
        params.model = huggingFaceEmbeddingModel;
        if (huggingFaceApiKey) params.apiKey = huggingFaceApiKey;
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);
    setSaveSuccess(false);

    const payload: Record<string, unknown> = {
      llmProvider,
      llmReasoningModel,
      llmSynthesisModel,
      ollamaUrl,
      ollamaLlmModel,
      ollamaEmbeddingModel,
      omniRouteUrl,
      omniRouteLlmModel,
      embeddingProvider,
      openRouterEmbeddingModel,
      huggingFaceEmbeddingModel,
      scholarlyEmail,
      qdrantUrl
    };

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
        setSaveSuccess(true);
        if (onSettingsSaved) onSettingsSaved();
        setTimeout(() => setSaveSuccess(false), 3000);
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update runtime environment');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-teal-600 text-white rounded-lg shadow-xs">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Runtime Environment &amp; Engine Settings</h2>
              <p className="text-xs text-slate-500">
                Configure LLM endpoints, Ollama, OmniRoute, API keys, and embedding models while container is running
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content form */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
          {saveSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center gap-2 text-xs font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>Runtime environment updated successfully! All subsequent requests will use the updated credentials and endpoints immediately.</span>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg flex items-center gap-2 text-xs">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Section 1: Primary LLM Inference Routing */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-teal-600" />
                <h3 className="font-semibold text-slate-900 text-sm">Primary LLM Inference Engine</h3>
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Reasoning LLM Model (DeepSeek-R1 / Reasoning)
                </label>
                <input
                  type="text"
                  value={llmReasoningModel}
                  onChange={e => setLlmReasoningModel(e.target.value)}
                  placeholder="deepseek/deepseek-r1"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Synthesis LLM Model (Clinical Writer &amp; PICO)
                </label>
                <input
                  type="text"
                  value={llmSynthesisModel}
                  onChange={e => setLlmSynthesisModel(e.target.value)}
                  placeholder="meta-llama/llama-3.3-70b-instruct"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Ollama Local / Private Server */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
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
                <span>Test Ollama</span>
              </button>
            </div>

            {testStatus.ollama && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.ollama.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.ollama.success ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
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

          {/* Section 3: OmniRoute Proxy & Unified Router */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
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
                <span>Test OmniRoute</span>
              </button>
            </div>

            {testStatus.omniroute && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.omniroute.success ? 'bg-indigo-50 text-indigo-800 border border-indigo-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.omniroute.success ? <CheckCircle2 className="w-3.5 h-3.5 text-indigo-600" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
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
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  OmniRoute API Key {omniRouteMasked && <span className="text-slate-400 font-mono">({omniRouteMasked})</span>}
                </label>
                <input
                  type="password"
                  value={omniRouteApiKey}
                  onChange={e => setOmniRouteApiKey(e.target.value)}
                  placeholder="Leave empty to retain existing key"
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

          {/* Section 4: OpenRouter & External APIs */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-600" />
                <h3 className="font-semibold text-slate-900 text-sm">OpenRouter &amp; Scholarly Credentials</h3>
              </div>
              <button
                type="button"
                onClick={() => handleTest('openrouter')}
                disabled={testStatus.openrouter?.loading || (!openRouterApiKey && !openRouterMasked)}
                className="text-[11px] px-2.5 py-1 bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                {testStatus.openrouter?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                <span>Validate Key</span>
              </button>
            </div>

            {testStatus.openrouter && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.openrouter.success ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.openrouter.success ? <CheckCircle2 className="w-3.5 h-3.5 text-amber-600" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
                <span>{testStatus.openrouter.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  OpenRouter API Key {openRouterMasked && <span className="text-slate-400 font-mono">({openRouterMasked})</span>}
                </label>
                <input
                  type="password"
                  value={openRouterApiKey}
                  onChange={e => setOpenRouterApiKey(e.target.value)}
                  placeholder="sk-or-v1-..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500">Powers DeepSeek-R1 and Llama 3.3 70B inference</span>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  NCBI API Key (Optional — NBK25497 Guidelines) {ncbiMasked && <span className="text-slate-400 font-mono">({ncbiMasked})</span>}
                </label>
                <input
                  type="password"
                  value={ncbiApiKey}
                  onChange={e => setNcbiApiKey(e.target.value)}
                  placeholder="Optional NCBI Entrez API key"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-emerald-600">Unlocks up to 10 requests/sec under official NCBI limits</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <span className="text-[10px] text-slate-500">Required parameter by NCBI E-Utilities &amp; OpenAlex</span>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Qdrant Vector DB URL
                </label>
                <input
                  type="text"
                  value={qdrantUrl}
                  onChange={e => setQdrantUrl(e.target.value)}
                  placeholder="http://localhost:6333"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500">Internal vector database endpoint</span>
              </div>
            </div>
          </div>

          {/* Section 5: Vector Embeddings Engine */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-teal-600" />
                <h3 className="font-semibold text-slate-900 text-sm">Vector Embeddings Provider</h3>
              </div>
              <button
                type="button"
                onClick={() => handleTest('huggingface')}
                disabled={testStatus.huggingface?.loading}
                className="text-[11px] px-2.5 py-1 bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200 rounded font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                {testStatus.huggingface?.loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                <span>Test HF Model</span>
              </button>
            </div>

            {testStatus.huggingface && (
              <div className={`p-2.5 mb-3 rounded text-xs flex items-center gap-1.5 ${testStatus.huggingface.success ? 'bg-teal-50 text-teal-800 border border-teal-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {testStatus.huggingface.success ? <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
                <span>{testStatus.huggingface.message}</span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-4">
              {[
                { id: 'auto', label: 'Auto (Optimal)' },
                { id: 'local', label: 'Local (100% Free)' },
                { id: 'gemini', label: 'Gemini (Free Tier)' },
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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  OpenRouter Embedding Model
                </label>
                <input
                  type="text"
                  value={openRouterEmbeddingModel}
                  onChange={e => setOpenRouterEmbeddingModel(e.target.value)}
                  placeholder="openai/text-embedding-3-small"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hugging Face User Access Token (Free) {huggingFaceMasked && <span className="text-slate-400 font-mono">({huggingFaceMasked})</span>}
                </label>
                <input
                  type="password"
                  value={huggingFaceApiKey}
                  onChange={e => setHuggingFaceApiKey(e.target.value)}
                  placeholder="hf_..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500">Free from huggingface.co/settings/tokens (no billing needed)</span>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hugging Face Embedding Model
                </label>
                <input
                  type="text"
                  value={huggingFaceEmbeddingModel}
                  onChange={e => setHuggingFaceEmbeddingModel(e.target.value)}
                  placeholder="monologg/biobert_v1.1_pubmed"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono focus:ring-teal-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Biomedical Model Preset Shortcuts */}
            <div className="pt-2 border-t border-slate-200/80">
              <span className="text-[11px] font-semibold text-slate-600 block mb-1.5">
                Recommended Biomedical &amp; Clinical Embedding Models:
              </span>
              <div className="flex flex-wrap gap-1.5">
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
            <span>Settings &amp; API keys are saved to mounted persistent volume (<code className="text-teal-700 bg-white px-1 rounded border">/app/data</code>) and applied immediately.</span>
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
