/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Stethoscope,
  Cpu,
  ShieldCheck,
  Settings as SettingsIcon,
  PenTool,
  LayoutDashboard
} from 'lucide-react';
import { LeftCanvas } from './components/LeftCanvas';
import { RightContext } from './components/RightContext';
import { PicoFilterBar } from './components/PicoFilterBar';
import { SettingsModal } from './components/SettingsModal';
import { AiPaperWriter } from './components/AiPaperWriter';
import {
  MedicalDocument,
  SynthesisData,
  QueryExpansion,
  VectorStatusInfo,
  PicoFilters,
  SettingsData
} from './types/research';

export default function App() {
  const [activeTab, setActiveTab] = useState<'workspace' | 'writer'>('workspace');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeStep, setActiveStep] = useState(0); // 0 = idle, 1..5 = steps
  const [documents, setDocuments] = useState<MedicalDocument[]>([]);
  const [synthesis, setSynthesis] = useState<SynthesisData | null>(null);
  const [expansion, setExpansion] = useState<QueryExpansion | null>(null);
  const [vectorStatus, setVectorStatus] = useState<VectorStatusInfo | null>(null);
  const [activeSettings, setActiveSettings] = useState<SettingsData | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Pagination & lazy hydration state
  const [totalAvailableStudies, setTotalAvailableStudies] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextOffset, setNextOffset] = useState<number>(0);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);

  // PICO Filters state
  const [filters, setFilters] = useState<PicoFilters>({
    designs: [],
    minSample: 0,
    yearFrom: 0,
    statSignificantOnly: false,
    searchFilterText: '',
    sourceDatabases: []
  });

  // Fetch vector engine telemetry
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/vector-status');
      if (res.ok) {
        const data = await res.json();
        if (data.status) setVectorStatus(data.status);
      }
    } catch {
      // Dev mode fallback
    }
  };

  // Fetch active settings and model configuration
  const fetchActiveSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setActiveSettings(data.settings);
      }
    } catch {
      // Dev mode fallback
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchActiveSettings();
  }, []);

  const executeSearch = async (overrideQuery?: string) => {
    const q = overrideQuery || query;
    if (!q.trim() || isLoading) return;

    setIsLoading(true);
    setErrorMsg(null);
    setActiveStep(1);

    // Simulate animated step transitions for realistic Agentic RAG observability
    const t1 = setTimeout(() => setActiveStep(2), 500);
    const t2 = setTimeout(() => setActiveStep(3), 1100);
    const t3 = setTimeout(() => setActiveStep(4), 1600);
    const t4 = setTimeout(() => setActiveStep(5), 2100);

    try {
      const res = await fetch('/api/search-and-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, filters, limit: 28 })
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      setDocuments(data.documents || []);
      setTotalAvailableStudies(data.totalAvailableStudies || (data.documents?.length || 0));
      setHasMore(Boolean(data.hasMore));
      setNextOffset(data.nextOffset || (data.documents?.length || 0));
      setSynthesis(data.synthesis || null);
      setExpansion(data.expansion || null);
      if (data.vectorStatus) setVectorStatus(data.vectorStatus);
      if (data.durationMs) setDurationMs(data.durationMs);

      // Select first document by default
      if (data.documents && data.documents.length > 0) {
        setActiveDocumentId(data.documents[0].id);
      }
    } catch (err) {
      console.error('[App] Search failed:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Search processing encountered an issue.');
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      setActiveStep(0);
      setIsLoading(false);
    }
  };

  const [isSynthesizing, setIsSynthesizing] = useState(false);

  const handleGenerateSynthesis = async () => {
    if (!query.trim() || isSynthesizing || documents.length === 0) return;
    setIsSynthesizing(true);
    try {
      const res = await fetch('/api/synthesize-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, documents: documents.slice(0, 30) })
      });
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.synthesis) {
        setSynthesis(data.synthesis);
      }
    } catch (err) {
      console.error('[App] Clinical report synthesis failed:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Clinical synthesis failed.');
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleLoadMore = async () => {
    if (isLoadingMore || !hasMore || !query.trim()) return;
    setIsLoadingMore(true);
    try {
      const res = await fetch('/api/search-and-index/load-more', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, offset: nextOffset, batchSize: 40, filters })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.newDocuments && data.newDocuments.length > 0) {
          setDocuments(prev => {
            const seen = new Set(prev.map(d => d.id));
            const fresh = data.newDocuments.filter((d: MedicalDocument) => !seen.has(d.id));
            return [...prev, ...fresh];
          });
        }
        setTotalAvailableStudies(data.totalAvailableStudies || totalAvailableStudies);
        setHasMore(Boolean(data.hasMore));
        setNextOffset(data.nextOffset);
        if (data.vectorStatus) setVectorStatus(data.vectorStatus);
      }
    } catch (err) {
      console.error('[App] Load more studies failed:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Filtered documents calculation
  const filteredDocuments = useMemo(() => {
    return documents.filter(doc => {
      // 0. Database source filter (PubMed, DOAJ, Google Scholar, Scopus, OpenAlex)
      if (filters.sourceDatabases && filters.sourceDatabases.length > 0) {
        if (!filters.sourceDatabases.includes(doc.source)) {
          return false;
        }
      }
      // 1. Study design filter
      if (filters.designs.length > 0 && !filters.designs.includes(doc.pico.design)) {
        return false;
      }
      // 2. Minimum sample size N
      if (filters.minSample > 0 && (doc.pico.sampleSize || 0) < filters.minSample) {
        return false;
      }
      // 3. Publication Year
      if (filters.yearFrom > 0 && doc.year < filters.yearFrom) {
        return false;
      }
      // 4. Statistical significance (p < 0.05)
      if (filters.statSignificantOnly) {
        const hasSigP = doc.pico.pValues.some(p => p.includes('< 0.001') || p.includes('< 0.01') || p.includes('< 0.05'));
        if (!hasSigP && !doc.pico.hazardRatio) return false;
      }
      // 5. Search text filter
      if (filters.searchFilterText) {
        const term = filters.searchFilterText.toLowerCase();
        const matches = doc.title.toLowerCase().includes(term) ||
          doc.abstract.toLowerCase().includes(term) ||
          doc.firstAuthor.toLowerCase().includes(term);
        if (!matches) return false;
      }
      return true;
    });
  }, [documents, filters]);

  // Click handler from LeftCanvas citation pills
  const handleSelectCitation = (authorOrDoi: string) => {
    const cleanSearch = authorOrDoi.toLowerCase().trim();
    const target = documents.find(d =>
      d.firstAuthor.toLowerCase().includes(cleanSearch) ||
      (d.doi && d.doi.toLowerCase().includes(cleanSearch)) ||
      d.authors.some(a => a.toLowerCase().includes(cleanSearch))
    );

    if (target) {
      setActiveDocumentId(target.id);
      const el = document.getElementById(`doc-${target.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-100 text-slate-900 font-sans overflow-hidden">
      {/* 1. Global Navigation Bar */}
      <header className="h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between shadow-2xs z-20 shrink-0">
        {/* Brand identity & Mode Switcher */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-teal-600 text-white shadow-xs">
              <Stethoscope className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold tracking-tight text-slate-900">MedResearch AI</h1>
              </div>
              <p className="text-[10px] text-slate-500 hidden sm:block">
                Clinical Synthesis • Dr. Puneet Maheshwari
              </p>
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
            <button
              onClick={() => setActiveTab('workspace')}
              className={`px-3 py-1.5 rounded-md font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'workspace'
                  ? 'bg-white text-teal-800 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              <span>Evidence Workspace</span>
            </button>

            <button
              onClick={() => setActiveTab('writer')}
              className={`px-3 py-1.5 rounded-md font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'writer'
                  ? 'bg-white text-teal-800 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <PenTool className="w-3.5 h-3.5" />
              <span>AI Editor &amp; Writer</span>
            </button>
          </div>
        </div>

        {/* System & Model Telemetry + Settings Button */}
        <div className="flex items-center space-x-2 sm:space-x-3">
          {/* Vector engine badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-50 border border-slate-200 text-xs">
            <div className={`w-2 h-2 rounded-full ${vectorStatus?.isQdrantConnected ? 'bg-emerald-500 animate-pulse' : 'bg-teal-500'}`} />
            <span className="text-slate-500 text-[11px] font-medium">Vector DB:</span>
            <span className="font-mono text-[11px] font-semibold text-slate-800">
              {vectorStatus?.isQdrantConnected ? 'Qdrant' : '384-d Vector'}
            </span>
          </div>

          {/* Active AI Models Badge (Reasoning + Synthesis) */}
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs shadow-2xs transition-colors cursor-pointer"
            title={`Active AI Models (Click to configure in Settings):\n• Reasoning: ${activeSettings?.llmReasoningModel || 'baidu/ernie-5.5-flash-preview:free'}\n• Synthesis: ${synthesis?.modelUsed || activeSettings?.llmSynthesisModel || 'nvidia/nemotron-3.5-super-vl:free'}\n• Embeddings: ${activeSettings?.embeddingProvider || 'gemini'}`}
          >
            <Cpu className="w-3.5 h-3.5 text-teal-600 shrink-0" />

            {/* Reasoning Model */}
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-slate-500 font-medium">Reasoning:</span>
              <span className="font-mono font-semibold text-slate-800 truncate max-w-[130px]">
                {(activeSettings?.llmReasoningModel || 'baidu/ernie-5.5-flash-preview:free').split('/').pop()}
              </span>
            </div>

            <span className="text-slate-300">•</span>

            {/* Synthesis Model */}
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-slate-500 font-medium">Synthesis:</span>
              <span className="font-mono font-semibold text-teal-800 truncate max-w-[130px]">
                {(synthesis?.modelUsed || activeSettings?.llmSynthesisModel || 'nvidia/nemotron-3.5-super-vl:free').split('/').pop()}
              </span>
            </div>
          </button>

          {/* Evidence Provenance */}
          <div className="hidden xl:flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span className="font-medium">PubMed + DOAJ + Scopus</span>
          </div>

          {/* Settings Trigger Button */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 text-xs font-semibold shadow-2xs transition-colors"
            title="Configure Runtime Settings, Ollama, OmniRoute, API Keys, and Models"
          >
            <SettingsIcon className="w-3.5 h-3.5 text-slate-500" />
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {activeTab === 'workspace' ? (
        <>
          {/* 2. PICO Metadata Controls Filter Bar */}
          <PicoFilterBar
            filters={filters}
            onFilterChange={setFilters}
            totalCount={documents.length}
            filteredCount={filteredDocuments.length}
          />

          {/* 3. Main Split-Screen Workspace (60% / 40% Dual-Pane) */}
          <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Left Canvas: Synthesis Workspace & Editor (60% width) */}
            <div className="w-full md:w-[60%] h-full flex flex-col overflow-hidden">
              <LeftCanvas
                query={query}
                onQueryChange={setQuery}
                onExecuteSearch={executeSearch}
                isLoading={isLoading}
                activeStep={activeStep}
                synthesis={synthesis}
                expansion={expansion}
                documents={filteredDocuments}
                onSelectCitation={handleSelectCitation}
                durationMs={durationMs}
                onGenerateSynthesis={handleGenerateSynthesis}
                isSynthesizing={isSynthesizing}
                activeSynthesisModel={activeSettings?.llmSynthesisModel}
                activeReasoningModel={activeSettings?.llmReasoningModel}
              />
            </div>

            {/* Right Context: Document Viewer & Source Tabs (40% width) */}
            <div className="w-full md:w-[40%] h-full flex flex-col overflow-hidden">
              <RightContext
                documents={filteredDocuments}
                activeDocumentId={activeDocumentId}
                onSelectDocument={setActiveDocumentId}
                vectorStatus={vectorStatus}
                isLoading={isLoading}
                totalAvailableStudies={totalAvailableStudies}
                hasMore={hasMore}
                isLoadingMore={isLoadingMore}
                onLoadMore={handleLoadMore}
              />
            </div>
          </main>
        </>
      ) : (
        /* AI Editor & Writer View */
        <main className="flex-1 overflow-hidden">
          <AiPaperWriter
            initialQuery={query}
            evidenceDocuments={documents}
            totalAvailableStudies={totalAvailableStudies}
            totalIndexedStudies={vectorStatus?.totalIndexed}
          />
        </main>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsSaved={() => {
          fetchStatus();
          fetchActiveSettings();
        }}
      />
    </div>
  );
}
