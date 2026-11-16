# MedResearch AI — Clinical Evidence & Literature Synthesis Platform

**Author:** Dr. Puneet Maheshwari  
**License:** Apache-2.0  
**Stack:** React 19 (TypeScript), Node.js (Express), Tailwind CSS, Qdrant / Local Dense Vector Store, PubMed/NCBI Entrez (NBK25497 compliant), DOAJ, Crossref/Scopus, Google Scholar, Google Search Grounding, OpenAlex, OpenRouter / Hugging Face / Google Gemini

---

## Overview

**MedResearch AI** is an open-source medical literature research and clinical synthesis platform designed by **Dr. Puneet Maheshwari**. It features an interactive dual-pane workspace dividing the display into a 60% clinical synthesis canvas & note editor and a 40% document context inspector and PICO trial comparison matrix.

The system connects concurrently across multiple authoritative biomedical repositories and trial registries:
1. **PubMed / NCBI Entrez & PMC Open-Access Full Text:** Fully compliant with **NCBI Entrez Usage Guidelines (NBK25497 Chapter 2)**, implementing automated rate limiting (≤ 3 req/sec without API key, ≤ 10 req/sec with `NCBI_API_KEY`), mandatory `tool=MedResearchAI` and `email` tracking, `usehistory=y` batching, XML parsing of structured `<AbstractText>` elements, NCBI ID Converter (`pmid` -> `pmcid`), and PMC full-text `<article>` XML extraction prioritized across `Methods -> Results -> Tables -> Discussion`.
2. **ClinicalTrials.gov REST API v2:** Direct trial search (`/api/v2/studies`) and automated `NCT\d{8}` enrichment populating trial designs, enrollment counts ($N$), arms/comparators, and primary outcomes.
3. **ISRCTN Official XML API:** Detects `10.1186/isrctn\d+` DOIs and `ISRCTN\d+` trial IDs, querying `/api/query/format/default` XML metadata cleanly without HTML cookie-wall artifacts.
4. **DOAJ (Directory of Open Access Journals):** Direct free REST API querying thousands of peer-reviewed open access medical and clinical journals.
5. **Scopus / Crossref:** Direct metadata lookup across major clinical publishers (Elsevier Scopus DOIs, Springer Nature, Wiley).
6. **Google Scholar & Google Search Grounding:** Direct scholarly search and live web citation grounding using Gemini 3.8 Flash Google Search tool integration, returning real web URIs and authentic clinical trial endpoints.
7. **OpenAlex Scholarly Graph:** Semantic entity mapping across hundreds of millions of scholarly publications.

The **Agentic RAG** workflow enforces cross-source deduplication (`PMID`, `DOI`, `NCT`, `ISRCTN`, and `>90%` normalized title similarity), keeps peer-reviewed publications as primary while absorbing registry PICO/sample metrics, caches external responses in a 24-hour TTL/LRU store, and extracts quantitative metrics (hazard ratios, risk ratios, and $p$-values) with verifiable bracket citations `[Author, Year (PMID/DOI)]`.

---

## Key Features

- **Split-Screen Dual-Pane Workspace:**
  - **Left Canvas (60%):** Text query box, landmark clinical query presets, real-time 5-step Agentic RAG progress tracker, interactive Markdown synthesis with clickable citation pills, and a full-featured clinical note editor with clipboard and download export.
  - **Right Context (40%):**
    - **Tab 1: Extracted Sources Map:** Real-time study cards with journal impact, publication year, color-coded database source badges (PubMed, ClinicalTrials.gov, ISRCTN, DOAJ, Google Scholar, Scopus, OpenAlex), verification pills (`PMC Full Text`, `NCT Verified`, `ISRCTN Verified`, merged-source badges), **Find Similar (NCBI)** citation network discovery via `elink`, direct outbound DOI/PMID/PMCID/NCT/ISRCTN/Scholar links, and one-click **Export .RIS / .BibTeX** for Zotero and EndNote.
    - **Tab 2: PICO Data Matrix:** Cross-study comparison grid isolating clinical populations, sample sizes ($N$), active regimens, control groups, and $p$-value metrics with one-click CSV export.
    - **Tab 3: Vector Index Inspector:** 384-dimensional dense vector space telemetry, distance metric inspection, and semantic cosine proximity ranking bars.
- **PICO Clinical Filter Bar:** Instant live filtering by study design tiering (RCTs, Meta-Analyses, Systematic Reviews, Cohort Studies), database source chips (PubMed, DOAJ, Google Scholar, Scopus, OpenAlex, ClinicalTrials.gov), minimum sample size boundary ($N$ slider up to 5,000+), publication timelines (2, 5, 10 years, all time), and statistical significance ($p < 0.05$).
- **AI Editor & Writer:**
  - **Initial Structural Outlines & Full Paper Drafts:** Generates structured IMRaD manuscripts (Title, Abstract, Introduction, Methods, Results, Discussion, Conclusion, References) tailored to specific research questions, target databases (PubMed, DOAJ, Google Scholar, Scopus, OpenAlex), and journal formats (*The Lancet*, *NEJM*, *JAMA*, *The BMJ*, *Nature Medicine*, *Annals of Internal Medicine*).
  - **Interactive Inline Section Tweaker:** Tweak, expand, rephrase in formal academic tone, condense, inject grounded citations, or bulletize individual sections inline with live word counting.
  - **Multi-Style Document Export:** One-click export to **Microsoft Word (.doc / .docx)** and formatted **PDF (Print / Save as PDF)** using specific citation standards: **APA (7th ed)**, **Chicago (17th ed)**, **MLA (9th ed)**, and **Vancouver (ICMJE medical standard)**.
- **Runtime Environment Settings Page:**
  - Enter and update environment variables dynamically *after the container is running* without requiring restarts.
  - Configure Ollama local/remote base URL (`http://localhost:11434`) and custom LLM/Embedding models (`llama3`, `nomic-embed-text`).
  - Configure OmniRoute unified router / OpenAI-compatible proxy URL and API key with live connection testing.
  - Manage OpenRouter API keys, DeepSeek-R1 / Llama 3.3 models, NCBI Entrez API keys (NBK25497 10 req/s boost), Hugging Face tokens, and Qdrant vector database endpoints.
- **Multi-Source Embedding Pipeline:**
  - **Ollama Local Embeddings:** `nomic-embed-text` or custom embedding models.
  - **OpenRouter Embeddings:** `openai/text-embedding-3-small`, `baai/bge-large-en-v1.5`, or `thenlper/gte-large`.
  - **Hugging Face Inference:** `sentence-transformers/all-MiniLM-L6-v2` or `BAAI/bge-small-en-v1.5`.
  - **Zero-Latency Local Engine:** Deterministic 384-dimensional biomedical feature hashing with domain keyword weighting.
- **Multi-Model Inference Engine:**
  - Ollama local inference (`llama3:latest`, `mistral`, `deepseek-r1:8b`).
  - OmniRoute unified proxy routing.
  - OpenRouter API (`deepseek/deepseek-r1`, `meta-llama/llama-3.3-70b-instruct`).
  - Native Google Gemini server-side fallback (`gemini-3.8-flash`).
- **Resilient Vector Store:** Native Qdrant client connection (`medical_workspace` collection) with automated high-speed in-memory cosine fallback.

---

## Architecture & Agentic RAG Flow

```
User Clinical Query
       │
       ▼
[Agent 1: Query Agent] ──> Expands into MeSH Descriptors & UMLS Concepts
       │
       ▼
[Search Service]       ──> Concurrent Querying: PubMed + OpenAlex + Crossref + DOAJ + ClinicalTrials.gov v2
       │
       ▼
[Enrichment & Cache]   ──> 24h TTL/LRU Cache + PMC Full-Text XML + NCT/ISRCTN XML Registry Resolvers
       │
       ▼
[Cross-Source Merger]  ──> Deduplicates via PMID/DOI/NCT/ISRCTN/>90% Title; merges PICO & N
       │
       ▼
[Embedding Service]    ──> OpenRouter / Hugging Face / Local 384-d Vector Profiles
       │
       ▼
[Vector Service]       ──> Upsert to Qdrant Collection & Cosine Semantic Re-ranking
       │
       ▼
[PICO Extractor]       ──> Isolates Cohort Size (N), Intervention, Control & p-values
       │
       ▼
[Agent 2: Synthesis]   ──> Clinical Report with Strict Bracket Citations [Author, Year (PMID/DOI)]
```

---

## Single-Container Multi-Stage Docker Setup

The entire application compiles and runs in a **single multi-stage container** serving both the compiled React frontend and the Express backend API on port `3000`.

### Running with Docker Compose

```bash
# 1. Clone the repository
git clone https://github.com/puneet1984/medical-research-AI.git
cd medical-research-AI

# 2. Configure environment variables (optional)
cp .env.example .env

# 3. Build and launch the single-container platform
docker compose up --build
```

Access the application in your browser at: `http://localhost:3000`

---

## Local Development (Without Docker)

### Prerequisites
- Node.js 20+
- npm

### Installation & Run

```bash
# Install dependencies
npm install

# Start full-stack dev server (Express API + Vite SPA middleware on port 3000)
npm run dev

# Run TypeScript linter
npm run lint

# Build production assets
npm run build
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the full-stack server |
| `NODE_ENV` | `development` | Environment mode (`development` / `production`) |
| `OPENROUTER_API_KEY` | *(optional)* | OpenRouter API key for DeepSeek-R1 / Llama 3.3 and embeddings |
| `LLM_REASONING_MODEL` | `deepseek/deepseek-r1` | Deep reasoning model identifier |
| `LLM_SYNTHESIS_MODEL` | `meta-llama/llama-3.3-70b-instruct` | Clinical synthesis model identifier |
| `OPENROUTER_EMBEDDING_MODEL` | `openai/text-embedding-3-small` | OpenRouter embedding model |
| `HUGGINGFACE_API_KEY` | *(optional)* | Hugging Face user access token |
| `HUGGINGFACE_EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | Hugging Face embedding model |
| `EMBEDDING_PROVIDER` | `auto` | Preferred provider: `auto`, `openrouter`, `huggingface`, or `local` |
| `GEMINI_API_KEY` | *(injected in AI Studio)* | Google Gemini API key fallback |
| `QDRANT_URL` | `http://localhost:6333` | Optional external Qdrant vector database URL |
| `SCHOLARLY_USER_AGENT_EMAIL` | `researcher@domain.com` | Contact email for polite OpenAlex and PubMed requests (NCBI NBK25497) |
| `NCBI_API_KEY` | *(optional)* | NCBI Entrez API key unlocking up to 10 req/s under NBK25497 guidelines |

---

## API Endpoints

- `POST /api/search-and-index`: Executes query expansion, multi-database retrieval (PubMed, PMC Full Text, ClinicalTrials.gov v2, ISRCTN XML, DOAJ, Crossref/Scopus, Google Scholar/Search, OpenAlex), cross-source deduplication & PICO merging, vector embedding, and PICO extraction.
- `GET /api/articles/:pmid/related`: Queries NCBI Entrez `elink` (`pubmed_pubmed` and `pubmed_pubmed_citedin`) and hydrates related & citing PubMed article metadata (backed by the 24-hour TTL/LRU cache).
- `POST /api/vector-search`: Performs fast cosine similarity search across indexed literature chunks.
- `GET /api/vector-status`: Returns vector index telemetry (connection state, active provider, collection name, document count).
- `GET /api/settings`: Retrieves active runtime environment configuration with masked keys.
- `POST /api/settings`: Updates runtime environment variables in memory without container restarts.
- `POST /api/settings/test-connection`: Tests connectivity to Ollama, OmniRoute, OpenRouter, or Gemini.
- `POST /api/paper-draft/generate`: Generates structured clinical paper outlines or full manuscripts according to journal and citation style filters.
- `POST /api/paper-draft/section-action`: Performs inline section modifications (expand, rephrase, condense, add citations, bulletize).
- `GET /api/health`: Service health status and timestamp.

---

## Author & Acknowledgements

Created and architected by **Dr. Puneet Maheshwari**.  
Powered by NCBI PubMed Entrez E-Utilities & PMC Full-Text XML (NBK25497), ClinicalTrials.gov REST API v2, ISRCTN XML API, DOAJ (Directory of Open Access Journals), Crossref, Google Scholar Grounding, and OpenAlex.
