import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Search,
  Sparkles,
  Copy,
  Check,
  Download,
  Edit3,
  BookOpen,
  Brain,
  Cpu,
  Layers,
  FileCheck,
  Clock
} from 'lucide-react';
import { SynthesisData, QueryExpansion, MedicalDocument } from '../types/research';

interface LeftCanvasProps {
  query: string;
  onQueryChange: (q: string) => void;
  onExecuteSearch: (customQuery?: string) => void;
  isLoading: boolean;
  activeStep: number; // 0 to 5
  synthesis: SynthesisData | null;
  expansion: QueryExpansion | null;
  documents: MedicalDocument[];
  onSelectCitation: (authorOrDoi: string) => void;
  durationMs?: number;
}

export const LeftCanvas: React.FC<LeftCanvasProps> = ({
  query,
  onQueryChange,
  onExecuteSearch,
  isLoading,
  activeStep,
  synthesis,
  expansion,
  documents,
  onSelectCitation,
  durationMs
}) => {
  const [activeView, setActiveView] = useState<'report' | 'editor'>('report');
  const [editableMarkdown, setEditableMarkdown] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Sync editable text when new synthesis arrives
  React.useEffect(() => {
    if (synthesis?.markdown) {
      setEditableMarkdown(synthesis.markdown);
    }
  }, [synthesis?.markdown]);

  const handleCopy = () => {
    const textToCopy = activeView === 'editor' ? editableMarkdown : (synthesis?.markdown || '');
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const textToSave = activeView === 'editor' ? editableMarkdown : (synthesis?.markdown || '');
    const blob = new Blob([textToSave], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Clinical_Evidence_Report_${new Date().toISOString().split('T')[0]}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || isLoading) return;
    onExecuteSearch();
  };

  const renderCitationPill = (text: string) => {
    // Matches patterns like [McMurray, 2019 (10.1056/NEJMoa1911303)]
    const parts = text.split(/(\[[A-Za-z\s–-]+,\s*\d{4}\s*\([^)]+\)\])/g);
    return parts.map((part, index) => {
      const match = part.match(/^\[([A-Za-z\s–-]+),\s*(\d{4})\s*\(([^)]+)\)\]$/);
      if (match) {
        const author = match[1];
        const year = match[2];
        const doi = match[3];
        return (
          <button
            key={index}
            onClick={() => onSelectCitation(author)}
            className="inline-flex items-center gap-0.5 mx-0.5 px-1.5 py-0.5 text-[11px] font-mono font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 hover:text-teal-900 border border-teal-200 rounded transition-colors align-baseline cursor-pointer"
            title={`Inspect Source: ${author} et al. (${year}) - DOI: ${doi}`}
          >
            <span>[{author}, {year}]</span>
          </button>
        );
      }
      return part;
    });
  };

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      {/* 1. Clinical Query Input Workspace */}
      <div className="p-4 border-b border-slate-200 bg-slate-50/70">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative flex items-center">
            <div className="absolute left-3 text-slate-400">
              <Search className="w-5 h-5 text-teal-600" />
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Enter your search query..."
              disabled={isLoading}
              className="w-full pl-10 pr-32 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition-all shadow-xs"
            />
            <button
              type="submit"
              disabled={isLoading || !query.trim()}
              className="absolute right-1.5 px-4 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 text-white text-xs font-semibold rounded-md transition-all shadow-xs flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Synthesizing...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Synthesize</span>
                </>
              )}
            </button>
          </div>
        </form>

        {/* Agentic RAG Multi-Step Workflow Status */}
        {isLoading && (
          <div className="mt-3.5 pt-3 border-t border-slate-200">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5 text-teal-600 animate-pulse" />
              <span>Agentic RAG Pipeline:</span>
            </div>
            <div className="grid grid-cols-5 gap-1 text-[10px]">
              {[
                { step: 1, label: 'MeSH Expansion', icon: Brain },
                { step: 2, label: 'PubMed/DOAJ/Scholar', icon: Search },
                { step: 3, label: '384-d Vector Index', icon: Layers },
                { step: 4, label: 'PICO Extraction', icon: FileCheck },
                { step: 5, label: 'Clinical Synthesis', icon: Sparkles }
              ].map(({ step, label, icon: Icon }) => {
                const isComplete = activeStep > step;
                const isCurrent = activeStep === step;
                return (
                  <div
                    key={step}
                    className={`p-1.5 rounded border text-center transition-all ${
                      isComplete
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : isCurrent
                        ? 'bg-teal-50 text-teal-800 border-teal-300 ring-1 ring-teal-200 font-semibold'
                        : 'bg-white text-slate-400 border-slate-200'
                    }`}
                  >
                    <Icon className="w-3 h-3 mx-auto mb-0.5" />
                    <span className="block truncate">{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* MeSH & UMLS Expansion preview chips */}
        {expansion && expansion.meshTerms?.length > 0 && (
          <div className="mt-2.5 flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="font-semibold text-slate-500 uppercase text-[10px]">MeSH Concepts:</span>
            {expansion.meshTerms.slice(0, 4).map((term, i) => (
              <span key={i} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded font-mono text-[10px]">
                {term}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 2. Synthesis Workspace Header Bar */}
      <div className="px-4 py-2 border-b border-slate-200 bg-white flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setActiveView('report')}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
              activeView === 'report'
                ? 'bg-teal-50 text-teal-800 border border-teal-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Synthesized Report</span>
          </button>

          <button
            onClick={() => setActiveView('editor')}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
              activeView === 'editor'
                ? 'bg-teal-50 text-teal-800 border border-teal-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Clinical Note Editor</span>
          </button>
        </div>

        {/* Metadata & Actions */}
        <div className="flex items-center gap-2">
          {durationMs && (
            <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {(durationMs / 1000).toFixed(2)}s
            </span>
          )}

          {synthesis?.modelUsed && (
            <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200">
              {synthesis.modelUsed}
            </span>
          )}

          <div className="h-4 w-px bg-slate-200" />

          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 p-1.5 rounded hover:bg-slate-100 transition-colors"
            title="Copy Report to Clipboard"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleDownload}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 p-1.5 rounded hover:bg-slate-100 transition-colors"
            title="Download Markdown Report"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 3. Synthesis Body (Markdown Viewer or Clinical Note Editor) */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeView === 'report' ? (
          <div className="max-w-3xl mx-auto prose prose-slate prose-sm text-slate-800">
            {synthesis?.markdown ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Render custom paragraph with clickable citations
                  p: ({ children }) => {
                    const content = React.Children.map(children, child => {
                      if (typeof child === 'string') {
                        return renderCitationPill(child);
                      }
                      return child;
                    });
                    return <p className="mb-3 leading-relaxed text-slate-700">{content}</p>;
                  },
                  h3: ({ children }) => (
                    <h3 className="text-base font-bold text-slate-900 mt-5 mb-2 pb-1 border-b border-slate-200 flex items-center gap-1.5">
                      {children}
                    </h3>
                  ),
                  h4: ({ children }) => (
                    <h4 className="text-sm font-semibold text-teal-900 mt-4 mb-1.5">
                      {children}
                    </h4>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc pl-5 my-2 space-y-1 text-slate-700">{children}</ul>
                  ),
                  li: ({ children }) => {
                    const content = React.Children.map(children, child => {
                      if (typeof child === 'string') {
                        return renderCitationPill(child);
                      }
                      return child;
                    });
                    return <li className="leading-snug">{content}</li>;
                  },
                  strong: ({ children }) => (
                    <strong className="font-semibold text-slate-900">{children}</strong>
                  ),
                  code: ({ children }) => (
                    <code className="font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded text-teal-800 border border-slate-200">
                      {children}
                    </code>
                  )
                }}
              >
                {synthesis.markdown}
              </ReactMarkdown>
            ) : (
              <div className="py-16 text-center text-slate-400">
                <BookOpen className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                <h3 className="text-base font-semibold text-slate-700">Medical Synthesis Workspace</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                  Enter a clinical research question above to generate an evidence-based PICO report with verified citations.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
              <span>Edit synthesis markdown or add clinician notes:</span>
              <span className="font-mono text-[10px]">{editableMarkdown.length} characters</span>
            </div>
            <textarea
              value={editableMarkdown}
              onChange={(e) => setEditableMarkdown(e.target.value)}
              className="flex-1 w-full p-4 font-mono text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 leading-relaxed resize-none"
              placeholder="Clinical synthesis report will be editable here..."
            />
          </div>
        )}
      </div>
    </div>
  );
};
