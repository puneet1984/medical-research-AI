import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initQdrant } from './services/vectorService.js';
import {
  handleSearchAndIndex,
  handleVectorSearch,
  handleVectorStatus,
  handleHealth
} from './controllers/researchController.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '10mb' }));

// API Routes
app.get('/api/health', handleHealth);
app.get('/api/vector-status', handleVectorStatus);
app.post('/api/search-and-index', handleSearchAndIndex);
app.post('/api/vector-search', handleVectorSearch);

// Start server
async function startServer() {
  // Initialize Qdrant connection check
  await initQdrant();

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[MedResearch Backend] Service listening on http://0.0.0.0:${config.port}`);
    console.log(`[MedResearch Backend] Mode: ${config.nodeEnv}`);
  });
}

startServer().catch(err => {
  console.error('[MedResearch Backend] Startup failure:', err);
  process.exit(1);
});

export default app;
