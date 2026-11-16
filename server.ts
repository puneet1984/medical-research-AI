import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { initQdrant } from './backend/src/services/vectorService.js';
import {
  handleSearchAndIndex,
  handleSynthesizeReport,
  handleLoadMoreStudies,
  handleVectorSearch,
  handleVectorStatus,
  handleHealth,
  handleMetaMapExtract,
  handleGetSettings,
  handleUpdateSettings,
  handleGetOpenRouterModels,
  handleTestConnection,
  handleGeneratePaperDraft,
  handleSectionAction,
  handleGetRelatedArticles
} from './backend/src/controllers/researchController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const parsed = Number(process.argv[portArgIdx + 1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const envPort = process.env.PORT;
  const nginxPort = process.env.NGINX_PORT;
  if (envPort && envPort !== nginxPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.DEFAULT_APP_PORT) || 3000;
}

const app = express();
const PORT = resolvePort();
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Endpoints
app.get('/api/health', handleHealth);
app.get('/api/vector-status', handleVectorStatus);
app.post('/api/search-and-index', handleSearchAndIndex);
app.post('/api/synthesize-report', handleSynthesizeReport);
app.post('/api/search-and-index/load-more', handleLoadMoreStudies);
app.post('/api/vector-search', handleVectorSearch);
app.post('/api/nlp/metamap', handleMetaMapExtract);
app.get('/api/articles/:pmid/related', handleGetRelatedArticles);

// Settings & Runtime Configuration
app.get('/api/settings', handleGetSettings);
app.post('/api/settings', handleUpdateSettings);
app.get('/api/settings/openrouter-models', handleGetOpenRouterModels);
app.get('/api/openrouter/models', handleGetOpenRouterModels);
app.post('/api/settings/test-connection', handleTestConnection);

// AI Editor & Writer Endpoints
app.post('/api/paper-draft/generate', handleGeneratePaperDraft);
app.post('/api/paper-draft/section-action', handleSectionAction);

async function main() {
  const httpServer = http.createServer(app);
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  let vitePromise: Promise<Awaited<ReturnType<typeof createViteServer>>> | null = null;

  if (!isProduction) {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    vitePromise = createViteServer({
      server: {
        middlewareMode: true,
        hmr: !hmrDisabled,
        ws: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    }).then(instance => {
      vite = instance;
      return instance;
    });

    app.use(async (req, res, next) => {
      try {
        const instance = vite || (await vitePromise!);
        instance.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[MedResearch FullStack] Server listening on port ${PORT} (isProduction: ${isProduction})`);
    // Initialize vector database connection in background without blocking HTTP startup
    initQdrant().catch(err => {
      console.warn('[MedResearch FullStack] Background Qdrant initialization notice:', err instanceof Error ? err.message : err);
    });
  });

  const shutdown = async () => {
    try {
      if (vite) await vite.close();
      httpServer.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[MedResearch FullStack] Error starting server:', err);
  process.exit(1);
});
