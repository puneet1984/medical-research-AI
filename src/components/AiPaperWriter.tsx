import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FileText,
  Sparkles,
  Download,
  Copy,
  Check,
  Printer,
  FileDown,
  Wand2,
  Maximize2,
  Minimize2,
  RefreshCw,
  ListOrdered,
  BookOpen,
  Edit3,
  Trash2,
  Plus,
  Eye,
  Sliders,
  Share2,
  ChevronDown,
  Layers,
  Search
} from 'lucide-react';
import {
  PaperDraft,
  PaperSection,
  CitationStyle,
  MedicalDocument
} from '../types/research';

interface AiPaperWriterProps {
  initialQuery?: string;
  evidenceDocuments?: MedicalDocument[];
}

const TARGET_JOURNALS = [
  { name: 'The Lancet', style: 'Vancouver', impact: 'Impact Factor: 168.9' },
  { name: 'The New England Journal of Medicine (NEJM)', style: 'Vancouver', impact: 'Impact Factor: 158.5' },
  { name: 'JAMA (Journal of the American Medical Association)', style: 'Vancouver', impact: 'Impact Factor: 120.7' },
  { name: 'The BMJ (British Medical Journal)', style: 'Vancouver', impact: 'Impact Factor: 105.7' },
  { name: 'Nature Medicine', style: 'Chicago', impact: 'Impact Factor: 82.9' },
  { name: 'Annals of Internal Medicine', style: 'APA', impact: 'Impact Factor: 39.2' },
  { name: 'Standard Academic / ICMJE Systematic Review', style: 'Vancouver', impact: 'Standard Clinical Review' }
];

const CITATION_STYLES: { id: CitationStyle; label: string; desc: string }[] = [
  { id: 'Vancouver', label: 'Vancouver (ICMJE)', desc: 'Numbered in order of appearance (Medical Standard)' },
  { id: 'APA', label: 'APA 7th Edition', desc: 'Author-date format (Maheshwari, 2024)' },
  { id: 'Chicago', label: 'Chicago 17th', desc: 'Notes and bibliography clinical format' },
  { id: 'MLA', label: 'MLA 9th Edition', desc: 'Humanities and interdisciplinary research format' }
];

export const AiPaperWriter: React.FC<AiPaperWriterProps> = ({
  initialQuery = 'SGLT2 inhibitors clinical outcomes in heart failure with preserved ejection fraction',
  evidenceDocuments = []
}) => {
  const [researchQuestion, setResearchQuestion] = useState(initialQuery);
  const [targetJournal, setTargetJournal] = useState(TARGET_JOURNALS[0].name);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>('Vancouver');
  const [selectedDatabases, setSelectedDatabases] = useState<string[]>([
    'PubMed',
    'DOAJ',
    'Google Scholar',
    'Scopus',
    'OpenAlex'
  ]);
  const [draftMode, setDraftMode] = useState<'outline' | 'full_draft'>('full_draft');

  // Active Draft State
  const [draft, setDraft] = useState<PaperDraft | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [editingSections, setEditingSections] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  // Generate complete paper or outline
  const handleGenerate = async () => {
    if (!researchQuestion.trim() || isGenerating) return;
    setIsGenerating(true);

    try {
      const res = await fetch('/api/paper-draft/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          researchQuestion: researchQuestion.trim(),
          targetJournal,
          targetDatabases: selectedDatabases,
          citationStyle,
          mode: draftMode,
          clinicalEvidence: evidenceDocuments
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.draft) {
        setDraft(data.draft);
        if (data.draft.sections?.length > 0) {
          setActiveSectionId(data.draft.sections[0].id);
        }
      }
    } catch (err) {
      console.error('[AiPaperWriter] Generation error:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  // Inline section action (expand, rephrase, condense, add citations, bulletize)
  const handleSectionAction = async (
    sectionId: string,
    action: 'expand' | 'rephrase' | 'condense' | 'add_citations' | 'bulletize'
  ) => {
    if (!draft) return;
    const targetSec = draft.sections.find(s => s.id === sectionId);
    if (!targetSec || actionLoading[sectionId]) return;

    setActionLoading(prev => ({ ...prev, [sectionId]: true }));

    try {
      const res = await fetch('/api/paper-draft/section-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          sectionTitle: targetSec.title,
          sectionContent: targetSec.content,
          targetJournal,
          citationStyle,
          clinicalEvidence: evidenceDocuments
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.result?.content) {
        setDraft(prev => {
          if (!prev) return null;
          const updated = prev.sections.map(s => {
            if (s.id === sectionId) {
              const newContent = data.result.content;
              const words = newContent.trim().split(/\s+/).filter(Boolean).length;
              return { ...s, content: newContent, wordCount: words };
            }
            return s;
          });
          const totalWords = updated.reduce((acc, curr) => acc + (curr.wordCount || 0), 0);
          return { ...prev, sections: updated, totalWords };
        });
      }
    } catch (err) {
      console.error('[AiPaperWriter] Section action failed:', err);
    } finally {
      setActionLoading(prev => ({ ...prev, [sectionId]: false }));
    }
  };

  // Manual section content update
  const handleUpdateSectionContent = (sectionId: string, newContent: string) => {
    setDraft(prev => {
      if (!prev) return null;
      const updated = prev.sections.map(s => {
        if (s.id === sectionId) {
          const words = newContent.trim().split(/\s+/).filter(Boolean).length;
          return { ...s, content: newContent, wordCount: words };
        }
        return s;
      });
      const totalWords = updated.reduce((acc, curr) => acc + (curr.wordCount || 0), 0);
      return { ...prev, sections: updated, totalWords };
    });
  };

  // Copy whole paper markdown
  const handleCopyMarkdown = () => {
    if (!draft) return;
    const text = draft.sections.map(s => `## ${s.title}\n\n${s.content}`).join('\n\n---\n\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Export to Print / PDF with professional academic layout
  const handlePrintPdf = () => {
    if (!draft) return;
    window.print();
  };

  // Export formatted Word Document (.docx / .doc)
  const handleExportWord = () => {
    if (!draft) return;

    const sectionsHtml = draft.sections.map(s => {
      return `
        <h2 style="font-size: 14pt; color: #1e293b; margin-top: 18pt; margin-bottom: 6pt; font-family: 'Calibri', 'Times New Roman', serif; border-bottom: 1px solid #cbd5e1; padding-bottom: 4pt;">
          ${s.title}
        </h2>
        <div style="font-size: 11pt; line-height: 1.6; color: #334155; margin-bottom: 12pt; text-align: justify;">
          ${s.content.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}
        </div>
      `;
    }).join('');

    const wordDocumentContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="utf-8">
        <title>${draft.researchQuestion}</title>
        <style>
          @page Section1 {
            size: 8.5in 11.0in;
            margin: 1.0in 1.0in 1.0in 1.0in;
            mso-header-margin: 0.5in;
            mso-footer-margin: 0.5in;
          }
          div.Section1 { page: Section1; }
          body { font-family: 'Calibri', 'Times New Roman', serif; font-size: 11pt; }
          h1 { font-size: 18pt; font-weight: bold; color: #0f172a; margin-bottom: 6pt; }
          p { margin: 0 0 10pt 0; text-indent: 0; }
        </style>
      </head>
      <body>
        <div class="Section1">
          <h1>${draft.researchQuestion}</h1>
          <p style="font-size: 12pt; font-weight: bold; color: #0d9488; margin-bottom: 2pt;">
            Lead Author: ${draft.author || 'Dr. Puneet Maheshwari'}
          </p>
          <p style="font-size: 10pt; color: #64748b; margin-bottom: 14pt;">
            Affiliation: ${draft.affiliation || 'Clinical Evidence & Research Institute'} • Target Journal: ${draft.targetJournal} • Format: ${draft.citationStyle}
          </p>
          <hr style="border: 0; border-top: 2px solid #0d9488; margin-bottom: 18pt;" />
          ${sectionsHtml}
        </div>
      </body>
      </html>
    `;

    const blob = new Blob(['\ufeff' + wordDocumentContent], {
      type: 'application/msword;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${draft.researchQuestion.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_')}_${draft.citationStyle}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-100 overflow-hidden">
      {/* 1. Top Research & Configuration Bar */}
      <div className="bg-white border-b border-slate-200 p-4 shrink-0 shadow-2xs">
        <div className="max-w-7xl mx-auto space-y-3">
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center">
            {/* Research Question Input */}
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-teal-600">
                <Sparkles className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={researchQuestion}
                onChange={e => setResearchQuestion(e.target.value)}
                placeholder="Enter clinical research question, hypothesis, or trial objective..."
                className="w-full pl-9 pr-4 py-2 text-xs md:text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 font-medium"
              />
            </div>

            {/* Target Journal Selection */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 shrink-0 hidden lg:inline">Journal:</span>
              <select
                value={targetJournal}
                onChange={e => {
                  const j = e.target.value;
                  setTargetJournal(j);
                  const matched = TARGET_JOURNALS.find(item => item.name === j);
                  if (matched && matched.style) {
                    setCitationStyle(matched.style as CitationStyle);
                  }
                }}
                className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 font-medium text-slate-800"
              >
                {TARGET_JOURNALS.map(j => (
                  <option key={j.name} value={j.name}>
                    {j.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Citation Style Selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 shrink-0 hidden lg:inline">Style:</span>
              <select
                value={citationStyle}
                onChange={e => setCitationStyle(e.target.value as CitationStyle)}
                className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 font-medium text-slate-800"
              >
                {CITATION_STYLES.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Mode selection & Generate button */}
            <div className="flex items-center gap-2">
              <div className="flex border border-slate-300 rounded-lg overflow-hidden text-xs bg-white">
                <button
                  type="button"
                  onClick={() => setDraftMode('outline')}
                  className={`px-3 py-2 font-medium transition-colors ${
                    draftMode === 'outline' ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Outline
                </button>
                <button
                  type="button"
                  onClick={() => setDraftMode('full_draft')}
                  className={`px-3 py-2 font-medium transition-colors ${
                    draftMode === 'full_draft' ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Full Paper Draft
                </button>
              </div>

              <button
                onClick={handleGenerate}
                disabled={isGenerating || !researchQuestion.trim()}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-lg shadow-xs flex items-center gap-1.5 transition-all disabled:opacity-50 shrink-0"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Generating...</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="w-3.5 h-3.5" />
                    <span>Generate {draftMode === 'outline' ? 'Outline' : 'Draft'}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Database Grounding Filters */}
          <div className="flex items-center gap-2 flex-wrap text-xs pt-1">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Target Evidence Sources:
            </span>
            {['PubMed', 'DOAJ', 'Google Scholar', 'Scopus', 'OpenAlex'].map(db => {
              const active = selectedDatabases.includes(db);
              return (
                <button
                  key={db}
                  type="button"
                  onClick={() => {
                    setSelectedDatabases(prev =>
                      active ? prev.filter(d => d !== db) : [...prev, db]
                    );
                  }}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                    active
                      ? 'bg-teal-50 text-teal-800 border-teal-300'
                      : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {active ? '✓ ' : ''}{db}
                </button>
              );
            })}

            {evidenceDocuments.length > 0 && (
              <span className="ml-auto text-[11px] text-emerald-700 font-medium bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                Indexed Evidence: {evidenceDocuments.length} Studies Ready
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Workspace Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* If no draft generated yet, show prompt & initial empty state */}
        {!draft && !isGenerating && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-white/50">
            <div className="w-16 h-16 rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-600 mb-4 shadow-xs">
              <FileText className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">AI Clinical Editor &amp; Paper Writer</h3>
            <p className="text-sm text-slate-600 max-w-xl mb-6">
              Generate structured outlines and full medical paper drafts conforming to standard biomedical journal guidelines (ICMJE/PRISMA) with citation formatting and inline rephrasing.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleGenerate}
                className="px-5 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>Generate Initial Paper Draft</span>
              </button>
            </div>
          </div>
        )}

        {/* Loading state during generation */}
        {isGenerating && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-white/50">
            <RefreshCw className="w-10 h-10 text-teal-600 animate-spin mb-4" />
            <h3 className="text-base font-bold text-slate-900 mb-1">Synthesizing Clinical Paper Draft...</h3>
            <p className="text-xs text-slate-500 max-w-md">
              Drafting structured IMRaD sections according to {targetJournal} editorial requirements and formatting citations in {citationStyle} standard.
            </p>
          </div>
        )}

        {/* Generated Draft Workspace */}
        {draft && !isGenerating && (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Left Sidebar: Outline navigation & Export actions */}
            <div className="w-full md:w-64 bg-slate-50 border-r border-slate-200 flex flex-col shrink-0">
              <div className="p-3 border-b border-slate-200 bg-white">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-slate-900">Document Outline</span>
                  <span className="text-[10px] font-mono font-medium text-slate-500">
                    {draft.totalWords} words
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 truncate" title={draft.targetJournal}>
                  {draft.targetJournal} • {draft.citationStyle}
                </div>
              </div>

              {/* Section links */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {draft.sections.map((section, idx) => (
                  <button
                    key={section.id}
                    onClick={() => {
                      setActiveSectionId(section.id);
                      const el = document.getElementById(`section-${section.id}`);
                      if (el) el.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between ${
                      activeSectionId === section.id
                        ? 'bg-teal-600 text-white font-semibold'
                        : 'text-slate-700 hover:bg-slate-200/60'
                    }`}
                  >
                    <span className="truncate pr-2">
                      {idx + 1}. {section.title.replace(/^\d+\.\s*/, '')}
                    </span>
                    <span className={`text-[10px] font-mono shrink-0 ${activeSectionId === section.id ? 'text-teal-100' : 'text-slate-400'}`}>
                      {section.wordCount}w
                    </span>
                  </button>
                ))}
              </div>

              {/* Export Panel in sidebar */}
              <div className="p-3 border-t border-slate-200 bg-white space-y-2">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Export Document:
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={handleExportWord}
                    className="px-2.5 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-800 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                    title="Export formatted Microsoft Word document (.doc / .docx)"
                  >
                    <FileDown className="w-3.5 h-3.5" />
                    <span>Word (.doc)</span>
                  </button>
                  <button
                    onClick={handlePrintPdf}
                    className="px-2.5 py-2 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                    title="Print or Save as formatted PDF"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>PDF Print</span>
                  </button>
                </div>
                <button
                  onClick={handleCopyMarkdown}
                  className="w-full px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied to Clipboard' : 'Copy Full Markdown'}</span>
                </button>
              </div>
            </div>

            {/* Main Interactive Paper Editor Canvas */}
            <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 bg-white print:p-0">
              {/* Paper Header / Metadata Banner */}
              <div className="border-b-2 border-teal-600 pb-4 mb-6">
                <span className="text-xs font-semibold uppercase tracking-wider text-teal-700 bg-teal-50 px-2 py-0.5 rounded border border-teal-200 inline-block mb-2">
                  {draft.targetJournal} Clinical Manuscript
                </span>
                <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight mb-2">
                  {draft.researchQuestion}
                </h1>
                <div className="text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
                  <span><strong>Author:</strong> {draft.author || 'Dr. Puneet Maheshwari'}</span>
                  <span><strong>Affiliation:</strong> {draft.affiliation}</span>
                  <span><strong>Citation Style:</strong> {draft.citationStyle}</span>
                  <span><strong>Date:</strong> {draft.date}</span>
                </div>
              </div>

              {/* Sections Display with Inline Actions */}
              {draft.sections.map((section, idx) => {
                const isEditing = editingSections[section.id];
                const isLoading = actionLoading[section.id];

                return (
                  <div
                    key={section.id}
                    id={`section-${section.id}`}
                    className="border border-slate-200 rounded-xl p-4 md:p-6 bg-white hover:border-slate-300 transition-shadow shadow-xs hover:shadow-sm"
                  >
                    {/* Section Header & Inline Action Bar */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 mb-3 border-b border-slate-100 gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-teal-50 text-teal-700 text-xs font-bold flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <h2 className="text-sm md:text-base font-bold text-slate-900">
                          {section.title}
                        </h2>
                        <span className="text-[11px] font-mono text-slate-400">
                          ({section.wordCount || 0} words)
                        </span>
                      </div>

                      {/* Inline AI Quick Tools */}
                      <div className="flex items-center gap-1 flex-wrap text-xs print:hidden">
                        <button
                          onClick={() => handleSectionAction(section.id, 'expand')}
                          disabled={isLoading}
                          className="px-2 py-1 bg-teal-50 hover:bg-teal-100 text-teal-800 rounded border border-teal-200 font-medium transition-colors flex items-center gap-1 text-[11px]"
                          title="Substantially expand this section with biological mechanisms and statistical rigor"
                        >
                          <Maximize2 className="w-3 h-3 text-teal-600" />
                          <span>Expand</span>
                        </button>

                        <button
                          onClick={() => handleSectionAction(section.id, 'rephrase')}
                          disabled={isLoading}
                          className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 rounded border border-indigo-200 font-medium transition-colors flex items-center gap-1 text-[11px]"
                          title="Rephrase into formal Lancet/NEJM academic medical tone"
                        >
                          <Sparkles className="w-3 h-3 text-indigo-600" />
                          <span>Rephrase</span>
                        </button>

                        <button
                          onClick={() => handleSectionAction(section.id, 'condense')}
                          disabled={isLoading}
                          className="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 rounded border border-amber-200 font-medium transition-colors flex items-center gap-1 text-[11px]"
                          title="Condense into a concise executive summary"
                        >
                          <Minimize2 className="w-3 h-3 text-amber-600" />
                          <span>Condense</span>
                        </button>

                        <button
                          onClick={() => handleSectionAction(section.id, 'add_citations')}
                          disabled={isLoading}
                          className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-800 rounded border border-blue-200 font-medium transition-colors flex items-center gap-1 text-[11px]"
                          title="Inject verified citations matching active search evidence"
                        >
                          <BookOpen className="w-3 h-3 text-blue-600" />
                          <span>+ Citations</span>
                        </button>

                        <button
                          onClick={() => handleSectionAction(section.id, 'bulletize')}
                          disabled={isLoading}
                          className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded border border-slate-300 font-medium transition-colors flex items-center gap-1 text-[11px]"
                          title="Convert paragraphs into structured clinical bullet points"
                        >
                          <ListOrdered className="w-3 h-3 text-slate-600" />
                          <span>Bulletize</span>
                        </button>

                        {/* Toggle Direct Text Editing */}
                        <button
                          onClick={() => {
                            setEditingSections(prev => ({ ...prev, [section.id]: !prev[section.id] }));
                          }}
                          className={`p-1 rounded border transition-colors ${
                            isEditing
                              ? 'bg-teal-600 text-white border-teal-600'
                              : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-100'
                          }`}
                          title="Direct text editor"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Section Body */}
                    {isLoading ? (
                      <div className="py-8 flex items-center justify-center gap-2 text-xs text-teal-700 bg-teal-50/50 rounded-lg">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Updating section with academic clinical language...</span>
                      </div>
                    ) : isEditing ? (
                      <div>
                        <textarea
                          value={section.content}
                          onChange={e => handleUpdateSectionContent(section.id, e.target.value)}
                          rows={8}
                          className="w-full p-3 text-xs md:text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 leading-relaxed bg-slate-50"
                        />
                        <div className="flex justify-end mt-2">
                          <button
                            onClick={() => setEditingSections(prev => ({ ...prev, [section.id]: false }))}
                            className="px-3 py-1 bg-teal-600 text-white text-xs font-semibold rounded-lg hover:bg-teal-700"
                          >
                            Done Editing
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="prose prose-sm max-w-none text-slate-700 leading-relaxed text-xs md:text-sm">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {section.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
