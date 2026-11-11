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
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Tag,
  CheckCircle2,
  Share2
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
  onGenerateSynthesis?: () => void;
  isSynthesizing?: boolean;
  activeSynthesisModel?: string;
  activeReasoningModel?: string;
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
  durationMs,
  onGenerateSynthesis,
  isSynthesizing = false,
  activeSynthesisModel,
  activeReasoningModel
}) => {
  const [activeView, setActiveView] = useState<'report' | 'editor'>('report');
  const [editableMarkdown, setEditableMarkdown] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [isMetaMapExpanded, setIsMetaMapExpanded] = useState(true);
  const [copiedPubMed, setCopiedPubMed] = useState(false);

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

        {/* NLM MetaMap / MetaMapLite Concept Extraction & Search Term Translator */}
        {expansion && (
          <div className="mt-3 bg-white border border-slate-200 rounded-lg p-2.5 shadow-2xs transition-all">
            <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-100">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-800 border border-blue-200 rounded text-[10px] font-bold">
                  <Brain className="w-3 h-3 text-blue-600" />
                  <span>NLM MetaMapLite</span>
                </span>
                {activeReasoningModel && (
                  <span
                    className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-teal-800 bg-teal-50/80 border border-teal-200 px-1.5 py-0.2 rounded font-medium"
                    title={`Active Reasoning Model: ${activeReasoningModel}`}
                  >
                    <span>Reasoning:</span>
                    <span className="font-semibold">{activeReasoningModel.split('/').pop()}</span>
                  </span>
                )}
                <span className="text-[10px] text-slate-500 font-medium">
                  Lister Hill Center Biomedical NLP
                </span>
                <a
                  href="https://lhncbc.nlm.nih.gov/LHC-research/LHC-projects/NLP/MetaMapLite.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-teal-700 hover:text-teal-900 inline-flex items-center gap-0.5 hover:underline"
                >
                  <span>Doc</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>

              <button
                type="button"
                onClick={() => setIsMetaMapExpanded(!isMetaMapExpanded)}
                className="text-[10px] text-slate-500 hover:text-slate-800 flex items-center gap-0.5 cursor-pointer"
              >
                <span>{isMetaMapExpanded ? 'Hide Details' : 'Inspect Terminology'}</span>
                {isMetaMapExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>

            {/* Collapsed Compact View */}
            {!isMetaMapExpanded && (
              <div className="pt-1.5 flex items-center gap-1.5 flex-wrap text-[10px]">
                <span className="text-slate-400 font-semibold uppercase text-[9px]">Mapped MeSH:</span>
                {expansion.meshTerms.slice(0, 4).map((term, i) => (
                  <span key={i} className="px-1.5 py-0.2 bg-slate-50 text-slate-700 border border-slate-200 rounded font-mono text-[10px]">
                    {term}
                  </span>
                ))}
              </div>
            )}

            {/* Expanded Full MetaMapLite Inspector */}
            {isMetaMapExpanded && (
              <div className="pt-2 space-y-2.5 text-[11px]">
                {/* 1. Extracted Biomedical Concepts & Semantic Types */}
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center justify-between">
                    <span>UMLS Concepts &amp; Semantic Types:</span>
                    <span className="text-[9px] font-normal text-slate-400">Match Confidence: ~1000/1000</span>
                  </div>

                  <div className="space-y-1.5">
                    {expansion.metaMap?.concepts && expansion.metaMap.concepts.length > 0 ? (
                      expansion.metaMap.concepts.map((c, i) => (
                        <div key={i} className="p-1.5 bg-slate-50 rounded border border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[10px]">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-slate-800 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                              "{c.matchedText}"
                            </span>
                            <span className="text-slate-400">→</span>
                            <span className="font-semibold text-slate-700">
                              {c.preferredName}
                            </span>
                            <span className="font-mono text-[9px] px-1 py-0.2 bg-teal-50 text-teal-800 border border-teal-200 rounded" title="UMLS Concept Unique Identifier">
                              CUI: {c.cui}
                            </span>
                          </div>

                          <div className="flex items-center gap-1 flex-wrap shrink-0">
                            {c.semanticTypes.map((st, j) => {
                              const isDevice = st === 'medd';
                              const isProc = st === 'topp';
                              const isDis = st === 'dsyn';
                              const isDrug = st === 'phsu';
                              const badgeCls = isDevice
                                ? 'bg-purple-50 text-purple-700 border-purple-200'
                                : isProc
                                ? 'bg-blue-50 text-blue-700 border-blue-200'
                                : isDis
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : isDrug
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-slate-100 text-slate-700 border-slate-200';

                              return (
                                <span key={j} className={`text-[9px] px-1.5 py-0.2 rounded border font-semibold ${badgeCls}`} title={c.semanticTypeNames[j] || st}>
                                  [{st}] {c.semanticTypeNames[j] || st}
                                </span>
                              );
                            })}

                            {c.meshId && (
                              <a
                                href={`https://meshb.nlm.nih.gov/record/ui?ui=${c.meshId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-[9px] font-mono font-semibold px-1 py-0.2 bg-blue-50 text-blue-700 hover:text-blue-900 border border-blue-200 rounded hover:underline"
                                title={`Inspect MeSH Descriptor ${c.meshId} in official NLM MeSH Browser`}
                              >
                                <span>MeSH: {c.meshId}</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {expansion.meshTerms.map((m, i) => (
                          <span key={i} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded font-mono text-[10px]">
                            {m}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. Comparative Clinical Arms Breakdown if comparative */}
                {expansion.metaMap?.isComparative && expansion.metaMap.comparativeDetails && (
                  <div className="p-2 bg-blue-50/40 rounded border border-blue-100 space-y-1 text-[10px]">
                    <div className="font-semibold text-blue-900 flex items-center justify-between">
                      <span>Comparative Implant / Therapy Arms:</span>
                      <span className="text-[9px] text-blue-600 font-normal">Head-to-head Clinical Evaluation</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                      <div className="bg-white p-1.5 rounded border border-blue-200">
                        <span className="text-slate-400 block text-[9px] font-bold uppercase">Arm 1 (Intervention):</span>
                        <span className="font-semibold text-slate-800">{expansion.metaMap.comparativeDetails.arm1.expanded}</span>
                        <div className="text-[9px] text-slate-500 font-mono mt-0.5 truncate">{expansion.metaMap.comparativeDetails.arm1.pubmedTerm}</div>
                      </div>
                      <div className="bg-white p-1.5 rounded border border-blue-200">
                        <span className="text-slate-400 block text-[9px] font-bold uppercase">Arm 2 (Comparator):</span>
                        <span className="font-semibold text-slate-800">{expansion.metaMap.comparativeDetails.arm2.expanded}</span>
                        <div className="text-[9px] text-slate-500 font-mono mt-0.5 truncate">{expansion.metaMap.comparativeDetails.arm2.pubmedTerm}</div>
                      </div>
                    </div>
                    {expansion.metaMap.comparativeDetails.contextCondition && (
                      <div className="pt-1 text-[9px] text-slate-600">
                        <span className="font-bold text-slate-700">Clinical Domain Restriction: </span>
                        <span>{expansion.metaMap.comparativeDetails.contextCondition} (prevents irrelevant literature leakage)</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 3. Formulated Optimized PubMed Search Query */}
                <div>
                  <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    <span>Optimized PubMed Search Syntax:</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          const pubmedString = expansion.metaMap?.optimizedPubMedQuery || expansion.expandedQuery;
                          navigator.clipboard.writeText(pubmedString);
                          setCopiedPubMed(true);
                          setTimeout(() => setCopiedPubMed(false), 2000);
                        }}
                        className="inline-flex items-center gap-1 text-[10px] font-semibold text-teal-700 hover:text-teal-900 bg-teal-50 hover:bg-teal-100 border border-teal-200 px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                        title="Copy PubMed search syntax to clipboard"
                      >
                        {copiedPubMed ? (
                          <>
                            <Check className="w-2.5 h-2.5 text-emerald-600" />
                            <span>Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-2.5 h-2.5" />
                            <span>Copy PubMed Query</span>
                          </>
                        )}
                      </button>

                      <a
                        href={`https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(expansion.metaMap?.optimizedPubMedQuery || expansion.expandedQuery)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-blue-700 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-1.5 py-0.5 rounded transition-colors"
                        title="Execute this exact query in PubMed (NCBI)"
                      >
                        <span>Run in PubMed</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>

                  <div className="p-2 bg-slate-900 text-slate-200 font-mono text-[10px] rounded border border-slate-800 leading-relaxed break-all select-all">
                    {expansion.metaMap?.optimizedPubMedQuery || expansion.expandedQuery}
                  </div>
                </div>
              </div>
            )}
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
          {onGenerateSynthesis && documents.length > 0 && (
            <button
              type="button"
              onClick={onGenerateSynthesis}
              disabled={isSynthesizing}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                isSynthesizing
                  ? 'bg-teal-100 text-teal-800 animate-pulse cursor-wait'
                  : synthesis?.markdown
                  ? 'bg-slate-100 hover:bg-teal-50 text-slate-700 hover:text-teal-800 border border-slate-200 hover:border-teal-300'
                  : 'bg-teal-600 hover:bg-teal-700 active:bg-teal-800 text-white shadow-2xs'
              }`}
              title={synthesis?.markdown ? "Re-run AI synthesis over retrieved studies" : "Generate clinical evidence synthesis report"}
            >
              <Sparkles className={`w-3.5 h-3.5 ${isSynthesizing ? 'animate-spin text-teal-600' : synthesis?.markdown ? 'text-teal-600' : 'text-teal-100'}`} />
              <span>{isSynthesizing ? 'Synthesizing...' : synthesis?.markdown ? 'Re-synthesize' : 'Generate Report'}</span>
            </button>
          )}

          {durationMs && (
            <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {(durationMs / 1000).toFixed(2)}s
            </span>
          )}

          {(synthesis?.modelUsed || activeSynthesisModel) && (
            <span
              className="text-[10px] font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded border border-slate-200 flex items-center gap-1"
              title={`Clinical evidence synthesis model: ${synthesis?.modelUsed || activeSynthesisModel}`}
            >
              <Cpu className="w-2.5 h-2.5 text-teal-600" />
              <span>{synthesis?.modelUsed || activeSynthesisModel}</span>
            </span>
          )}

          <div className="h-4 w-px bg-slate-200" />

          <button
            onClick={handleCopy}
            disabled={!synthesis?.markdown}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 p-1.5 rounded hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Copy Report to Clipboard"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleDownload}
            disabled={!synthesis?.markdown}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 p-1.5 rounded hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            {isSynthesizing ? (
              <div className="py-16 text-center max-w-md mx-auto space-y-4">
                <div className="w-14 h-14 mx-auto rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center shadow-xs">
                  <Sparkles className="w-7 h-7 text-teal-600 animate-spin" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-800">Synthesizing Clinical Evidence Report...</h3>
                  <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                    Analyzing {documents.length} retrieved publications, synthesizing comparative outcomes across intervention vs comparator arms, and generating verified bracket citations [Author Year].
                  </p>
                </div>
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-slate-100 rounded-full text-[11px] text-slate-600 font-mono">
                  <span className="w-2 h-2 rounded-full bg-teal-500 animate-ping" />
                  <span>Agentic Evidence Synthesis in progress</span>
                </div>
              </div>
            ) : synthesis?.markdown ? (
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
            ) : documents.length > 0 ? (
              <div className="py-12 px-6 max-w-lg mx-auto bg-white rounded-xl border border-teal-200/80 shadow-2xs text-center space-y-4">
                <div className="w-12 h-12 mx-auto rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-teal-600" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Medical Evidence Retrieved &amp; Indexed</h3>
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                    MeSH expansion, multi-database search across PubMed, vector indexing, and PICO matrix extraction have completed for <strong className="text-slate-800">{documents.length} studies</strong>.
                  </p>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-lg text-left text-[11px] text-slate-600 space-y-1.5">
                  <div className="flex items-center gap-2 font-medium text-slate-700">
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                    <span>MeSH &amp; UMLS MetaMapLite semantic concept extraction complete</span>
                  </div>
                  <div className="flex items-center gap-2 font-medium text-slate-700">
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                    <span>{documents.length} publications indexed with clinical PICO matrix</span>
                  </div>
                  <div className="flex items-center gap-2 font-medium text-slate-700">
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                    <span>Semantic vector ranking applied in Qdrant</span>
                  </div>
                </div>

                {onGenerateSynthesis && (
                  <button
                    type="button"
                    onClick={onGenerateSynthesis}
                    disabled={isSynthesizing}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-teal-600 hover:bg-teal-700 active:bg-teal-800 text-white font-semibold text-xs rounded-lg shadow-sm transition-colors cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>Generate Clinical Evidence Synthesis Report</span>
                  </button>
                )}
                <p className="text-[10px] text-slate-400">
                  Synthesizes study findings into a structured Cochrane-style narrative with verified in-text citations [Author Year].
                </p>
              </div>
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
