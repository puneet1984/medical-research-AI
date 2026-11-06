export interface PicoData {
  population: string;
  sampleSize: number;
  intervention: string;
  comparator: string;
  primaryOutcome: string;
  pValues: string[];
  hazardRatio?: string;
  riskRatio?: string;
  design: 'Randomized Controlled Trial' | 'Meta-Analysis' | 'Systematic Review' | 'Cohort Study' | 'Clinical Trial';
}

export interface MedicalDocument {
  id: string;
  title: string;
  authors: string[];
  firstAuthor: string;
  journal: string;
  year: number;
  doi: string;
  pmid?: string;
  abstract: string;
  citationCount: number;
  isOpenAccess?: boolean;
  source: 'OpenAlex' | 'PubMed' | 'DOAJ' | 'Google Scholar' | 'Embase' | 'Scopus' | 'Google Search' | 'ClinicalTrials';
  webUrl?: string;
  pico: PicoData;
  score?: number;
}

export interface QueryExpansion {
  originalQuery: string;
  expandedQuery: string;
  meshTerms: string[];
  umlsConcepts: string[];
  booleanQuery: string;
  targetPopulation: string;
  targetIntervention: string;
}

export interface SynthesisData {
  markdown: string;
  citedSources: string[];
  provider: string;
  modelUsed: string;
}

export interface StudyStub {
  id: string;
  title: string;
  year: number;
  firstAuthor: string;
  authors: string[];
  journal: string;
  doi: string;
  pmid?: string;
  source: 'OpenAlex' | 'PubMed' | 'DOAJ' | 'Google Scholar' | 'Embase' | 'Scopus' | 'Google Search' | 'ClinicalTrials';
  webUrl?: string;
  isOpenAccess?: boolean;
  citationCount?: number;
  isHydrated: boolean;
}

export interface QdrantSchemaColumn {
  field: string;
  type: 'integer' | 'keyword' | 'text' | 'float' | 'bool';
  indexed: boolean;
  status: 'active' | 'created' | 'verified';
}

export interface QdrantSchemaVerification {
  collectionExists: boolean;
  collectionName: string;
  status: 'green' | 'yellow' | 'ready' | 'offline';
  vectorDimension: number;
  distanceMetric: string;
  columns: QdrantSchemaColumn[];
  allColumnsVerified: boolean;
  totalPoints: number;
  verifiedAt: string;
}

export interface VectorStatusInfo {
  isQdrantConnected: boolean;
  activeBackend: 'qdrant' | 'local_in_memory';
  collectionName: string;
  totalIndexed: number;
  url: string;
  upsertMode?: string;
  cachedVectorHits?: number;
  vectorAcceleration?: string;
  maxCapacity: number;
  localMaxCapacity?: number;
  qdrantMaxCapacity?: number;
  storageUsagePct: number;
  rollingBufferActive: boolean;
  totalEvicted: number;
  oldestRecordDate?: string;
  schemaVerification?: QdrantSchemaVerification;
  offlineFallbackExplanation?: string;
}

export interface PicoFilters {
  designs: string[];
  minSample: number;
  yearFrom: number;
  statSignificantOnly: boolean;
  searchFilterText: string;
  sourceDatabases: string[];
}

export interface SettingsData {
  llmProvider: 'auto' | 'omniroute' | 'ollama' | 'openrouter' | 'gemini';
  llmReasoningModel: string;
  llmSynthesisModel: string;
  openRouterApiKeyMasked: string;
  isOpenRouterConfigured: boolean;
  geminiApiKeyMasked: string;
  isGeminiConfigured: boolean;
  geminiEmbeddingModel?: string;
  ollamaUrl: string;
  ollamaLlmModel: string;
  ollamaEmbeddingModel: string;
  omniRouteUrl: string;
  omniRouteApiKeyMasked: string;
  isOmniRouteConfigured: boolean;
  omniRouteLlmModel: string;
  embeddingProvider: 'auto' | 'gemini' | 'openrouter' | 'huggingface' | 'ollama' | 'local';
  openRouterEmbeddingModel: string;
  huggingFaceApiKeyMasked: string;
  isHuggingFaceConfigured: boolean;
  huggingFaceEmbeddingModel: string;
  scholarlyEmail: string;
  ncbiApiKeyMasked: string;
  isNcbiConfigured: boolean;
  qdrantHost: string;
  qdrantPort: number;
  qdrantUrl: string;
  qdrantApiKeyMasked: string;
  isQdrantConfigured: boolean;
}

export interface PaperSection {
  id: string;
  type: 'title' | 'abstract' | 'introduction' | 'methods' | 'results' | 'discussion' | 'conclusion' | 'references' | 'custom';
  title: string;
  content: string;
  keyPoints?: string[];
  wordCount?: number;
}

export type CitationStyle = 'APA' | 'Chicago' | 'MLA' | 'Vancouver';

export interface PaperDraft {
  id: string;
  title: string;
  researchQuestion: string;
  targetJournal: string;
  targetDatabases: string[];
  citationStyle: CitationStyle;
  mode: 'outline' | 'full_draft';
  author: string;
  affiliation: string;
  date: string;
  sections: PaperSection[];
  totalWords: number;
}

export interface OpenRouterModelOption {
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

export interface OpenRouterModelsResponse {
  success: boolean;
  count: number;
  models: OpenRouterModelOption[];
  categories: {
    freeText: OpenRouterModelOption[];
    allText: OpenRouterModelOption[];
    freeEmbeddings: OpenRouterModelOption[];
    allEmbeddings: OpenRouterModelOption[];
    reasoning: OpenRouterModelOption[];
  };
}

