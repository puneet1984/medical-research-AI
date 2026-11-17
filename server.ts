import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePort(): number {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--port' && process.argv[i + 1]) {
      const parsed = Number(process.argv[i + 1]);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
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

// Immediate liveness probe so startup health checks succeed without waiting on heavy imports
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'MedResearch AI Engine'
  });
});

// Lazy-loaded backend modules so port 3000 binds immediately before heavy imports
type ControllerModule = typeof import('./backend/src/controllers/researchController.js');
type VectorModule = typeof import('./backend/src/services/vectorService.js');
let controllerModulePromise: Promise<ControllerModule> | null = null;
let vectorModulePromise: Promise<VectorModule> | null = null;

function getControllerModule(): Promise<ControllerModule> {
  if (!controllerModulePromise) {
    controllerModulePromise = import('./backend/src/controllers/researchController.js');
  }
  return controllerModulePromise;
}

function getVectorModule(): Promise<VectorModule> {
  if (!vectorModulePromise) {
    vectorModulePromise = import('./backend/src/services/vectorService.js');
  }
  return vectorModulePromise;
}

const lazyHandler = (getter: (mod: ControllerModule) => (req: Request, res: Response) => unknown) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mod = await getControllerModule();
      await getter(mod)(req, res);
    } catch (err) {
      next(err);
    }
  };
};

// API Endpoints
app.get('/api/vector-status', lazyHandler(m => m.handleVectorStatus));
app.post('/api/search-and-index', lazyHandler(m => m.handleSearchAndIndex));
app.post('/api/synthesize-report', lazyHandler(m => m.handleSynthesizeReport));
app.post('/api/search-and-index/load-more', lazyHandler(m => m.handleLoadMoreStudies));
app.post('/api/vector-search', lazyHandler(m => m.handleVectorSearch));
app.post('/api/nlp/metamap', lazyHandler(m => m.handleMetaMapExtract));
app.get('/api/articles/:pmid/related', lazyHandler(m => m.handleGetRelatedArticles));

// Settings & Runtime Configuration
app.get('/api/settings', lazyHandler(m => m.handleGetSettings));
app.post('/api/settings', lazyHandler(m => m.handleUpdateSettings));
app.get('/api/settings/openrouter-models', lazyHandler(m => m.handleGetOpenRouterModels));
app.get('/api/openrouter/models', lazyHandler(m => m.handleGetOpenRouterModels));
app.post('/api/settings/test-connection', lazyHandler(m => m.handleTestConnection));

// AI Editor & Writer Endpoints
app.post('/api/paper-draft/generate', lazyHandler(m => m.handleGeneratePaperDraft));
app.post('/api/paper-draft/section-action', lazyHandler(m => m.handleSectionAction));

async function main() {
  const httpServer = http.createServer(app);
  let vite: { middlewares: any; close: () => Promise<void> } | null = null;
  let vitePromise: Promise<{ middlewares: any; close: () => Promise<void> }> | null = null;

  const ensureVite = () => {
    if (!vitePromise) {
      const hmrDisabled = process.env.DISABLE_HMR === 'true';
      vitePromise = import('vite')
        .then(({ createServer: createViteServer }) =>
          createViteServer({
            server: {
              middlewareMode: true,
              hmr: hmrDisabled ? false : { server: httpServer },
              ...(hmrDisabled ? { ws: false } : {})
            },
            appType: 'spa'
          })
        )
        .then(instance => {
          vite = instance;
          return instance;
        })
        .catch(err => {
          console.error('[MedResearch FullStack] Vite dev middleware initialization error:', err);
          vitePromise = null;
          throw err;
        });
    }
    return vitePromise;
  };

  if (!isProduction) {
    app.use(async (req, res, next) => {
      try {
        const instance = vite || (await ensureVite());
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

  httpServer.on('error', err => {
    console.error('[MedResearch FullStack] HTTP server error:', err);
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[MedResearch FullStack] Server listening on port ${PORT} (isProduction: ${isProduction})`);

    setImmediate(() => {
      if (!isProduction) {
        ensureVite().catch(() => {});
      }
      getControllerModule().catch(err => {
        console.warn('[MedResearch FullStack] Background controller warm-up notice:', err instanceof Error ? err.message : err);
      });
      // Initialize vector database connection in background without blocking HTTP startup
      getVectorModule()
        .then(({ initQdrant }) => initQdrant())
        .catch(err => {
          console.warn('[MedResearch FullStack] Background Qdrant initialization notice:', err instanceof Error ? err.message : err);
        });
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
