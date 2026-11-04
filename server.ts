import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { initQdrant } from './backend/src/services/vectorService.js';
import {
  handleSearchAndIndex,
  handleLoadMoreStudies,
  handleVectorSearch,
  handleVectorStatus,
  handleHealth,
  handleGetSettings,
  handleUpdateSettings,
  handleTestConnection,
  handleGeneratePaperDraft,
  handleSectionAction
} from './backend/src/controllers/researchController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Endpoints
app.get('/api/health', handleHealth);
app.get('/api/vector-status', handleVectorStatus);
app.post('/api/search-and-index', handleSearchAndIndex);
app.post('/api/search-and-index/load-more', handleLoadMoreStudies);
app.post('/api/vector-search', handleVectorSearch);

// Settings & Runtime Configuration
app.get('/api/settings', handleGetSettings);
app.post('/api/settings', handleUpdateSettings);
app.post('/api/settings/test-connection', handleTestConnection);

// AI Editor & Writer Endpoints
app.post('/api/paper-draft/generate', handleGeneratePaperDraft);
app.post('/api/paper-draft/section-action', handleSectionAction);

async function main() {
  // Initialize vector database connection
  await initQdrant();

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MedResearch FullStack] Server listening on port ${PORT} (isProduction: ${isProduction})`);
  });
}

main().catch(err => {
  console.error('[MedResearch FullStack] Error starting server:', err);
  process.exit(1);
});
