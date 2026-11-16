import React from 'react';
import { Filter, RotateCcw, Check, Users, Calendar, Award, Database } from 'lucide-react';
import { PicoFilters } from '../types/research.js';

interface PicoFilterBarProps {
  filters: PicoFilters;
  onFilterChange: (filters: PicoFilters) => void;
  totalCount: number;
  filteredCount: number;
  totalAvailableStudies?: number;
}

const STUDY_DESIGNS = [
  'Randomized Controlled Trial',
  'Meta-Analysis',
  'Systematic Review',
  'Cohort Study',
  'Case Report'
];

const DATABASE_SOURCES = [
  'PubMed',
  'DOAJ',
  'Google Scholar',
  'Scopus',
  'OpenAlex',
  'ClinicalTrials.gov'
];

const TIMELINE_PRESETS = [
  { label: 'All Time', year: 0 },
  { label: 'Last 2 Yrs', year: new Date().getFullYear() - 2 },
  { label: 'Last 5 Yrs', year: new Date().getFullYear() - 5 },
  { label: 'Last 10 Yrs', year: new Date().getFullYear() - 10 }
];

export const PicoFilterBar: React.FC<PicoFilterBarProps> = ({
  filters,
  onFilterChange,
  totalCount,
  filteredCount,
  totalAvailableStudies
}) => {
  const toggleDesign = (design: string) => {
    const next = filters.designs.includes(design)
      ? filters.designs.filter(d => d !== design)
      : [...filters.designs, design];
    onFilterChange({ ...filters, designs: next });
  };

  const toggleSourceDatabase = (db: string) => {
    const current = filters.sourceDatabases || [];
    const next = current.includes(db)
      ? current.filter(d => d !== db)
      : [...current, db];
    onFilterChange({ ...filters, sourceDatabases: next });
  };

  const resetFilters = () => {
    onFilterChange({
      designs: [],
      minSample: 0,
      yearFrom: 0,
      statSignificantOnly: false,
      searchFilterText: '',
      sourceDatabases: []
    });
  };

  const hasActiveFilters =
    filters.designs.length > 0 ||
    filters.minSample > 0 ||
    filters.yearFrom > 0 ||
    filters.statSignificantOnly ||
    filters.searchFilterText.length > 0 ||
    (filters.sourceDatabases && filters.sourceDatabases.length > 0);

  return (
    <div className="bg-white border-b border-slate-200 px-4 py-2 text-xs text-slate-700 shadow-xs">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 font-medium text-slate-500 mr-1">
            <Filter className="w-3.5 h-3.5 text-teal-600" />
            <span className="uppercase tracking-wider text-[11px] font-semibold">PICO Filters:</span>
          </div>

          <div className="flex items-center gap-1">
            {STUDY_DESIGNS.map(design => {
              const active = filters.designs.includes(design);
              const label =
                design === 'Randomized Controlled Trial' ? 'RCT' :
                design === 'Meta-Analysis' ? 'Meta-Analysis' :
                design === 'Systematic Review' ? 'Systematic Rev' :
                design === 'Case Report' ? 'Case Report' : 'Cohort';

              return (
                <button
                  key={design}
                  onClick={() => toggleDesign(design)}
                  className={`px-2 py-0.5 rounded-md transition-all text-[11px] font-medium border flex items-center gap-1 ${
                    active
                      ? 'bg-teal-50 text-teal-800 border-teal-300 shadow-xs'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                  title={design}
                >
                  {active && <Check className="w-3 h-3 text-teal-600" />}
                  {label}
                </button>
              );
            })}
          </div>

          <div className="h-4 w-px bg-slate-200 mx-1" />

          <div className="flex items-center gap-1">
            <Database className="w-3.5 h-3.5 text-slate-400 mr-0.5" />
            {DATABASE_SOURCES.map(db => {
              const active = (filters.sourceDatabases || []).includes(db);
              return (
                <button
                  key={db}
                  onClick={() => toggleSourceDatabase(db)}
                  className={`px-2 py-0.5 rounded-md transition-all text-[11px] font-medium border flex items-center gap-1 ${
                    active
                      ? 'bg-indigo-50 text-indigo-800 border-indigo-300 shadow-xs'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {active && <Check className="w-3 h-3 text-indigo-600" />}
                  {db}
                </button>
              );
            })}
          </div>

          <div className="h-4 w-px bg-slate-200 mx-1" />

          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-md px-2 py-0.5">
            <Users className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-slate-500 font-medium">Min N:</span>
            <input
              type="range"
              min="0"
              max="5000"
              step="250"
              value={filters.minSample}
              onChange={e => onFilterChange({ ...filters, minSample: Number(e.target.value) })}
              className="w-16 accent-teal-600 cursor-pointer h-1 bg-slate-200 rounded-lg"
            />
            <span className="font-mono text-[11px] font-semibold text-slate-800 w-12 text-right">
              {filters.minSample === 0 ? 'Any' : `≥ ${filters.minSample.toLocaleString()}`}
            </span>
          </div>

          <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-md p-0.5">
            <Calendar className="w-3.5 h-3.5 text-slate-400 ml-1" />
            {TIMELINE_PRESETS.map(p => {
              const active = filters.yearFrom === p.year;
              return (
                <button
                  key={p.label}
                  onClick={() => onFilterChange({ ...filters, yearFrom: p.year })}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                    active
                      ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => onFilterChange({ ...filters, statSignificantOnly: !filters.statSignificantOnly })}
            className={`px-2 py-0.5 rounded-md text-[11px] font-medium border flex items-center gap-1 transition-colors ${
              filters.statSignificantOnly
                ? 'bg-amber-50 text-amber-900 border-amber-300'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
            title="Filter trials with statistically verified significance"
          >
            <Award className="w-3.5 h-3.5 text-amber-600" />
            <span>p &lt; 0.05</span>
          </button>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded">
            Total Retrieved: <span className="font-mono font-bold">{(totalAvailableStudies || totalCount).toLocaleString()}</span>
          </div>
          <div className="text-[11px] text-slate-500">
            Showing <span className="font-semibold text-slate-800">{filteredCount}</span> of <span className="font-semibold text-slate-800">{totalCount}</span> studies
          </div>

          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
