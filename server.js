import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { generatePdfBuffer, generateTextOnlyPdfBuffer, generateCoverPdfBuffer } from './services/pdfService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*', optionsSuccessStatus: 200 }));

// Basic request logger with correlation id from proxy (placed BEFORE body parsing)
app.use((req, _res, next) => {
  const reqId = req.headers['x-request-id'] || 'no-id';
  const source = req.headers['x-source'] || 'unknown';
  console.log(`[PDF MS] (${reqId}) ${req.method} ${req.path} ← source=${source}`);
  next();
});

// Parse body after logging so aborted requests are still visible
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'magic-book-pdf-service' });
});

// Mirrors your existing payload shape
app.post('/api/pdf/generate', async (req, res) => {
  try {
    const reqId = req.headers['x-request-id'] || 'no-id';
    console.log(`[PDF MS] (${reqId}) start /api/pdf/generate`);
    const { story, selectedStory, childName, childAge, selectedGender, options = {} } = req.body || {};
    const effectiveStory = story || selectedStory;
    if (!effectiveStory || !childName || !selectedGender) {
      return res.status(400).json({ error: 'Missing required fields: story, childName, selectedGender' });
    }
    const pdfBuffer = await generatePdfBuffer({
      story: effectiveStory,
      childName,
      childAge,
      selectedGender,
      options
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('[PDF SERVICE] Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF', details: error?.message });
  }
});

app.post('/api/pdf/generate-text-only', async (req, res) => {
  try {
    const reqId = req.headers['x-request-id'] || 'no-id';
    console.log(`[PDF MS] (${reqId}) start /api/pdf/generate-text-only`);
    const { story, childName, childAge, selectedGender, options = {} } = req.body || {};
    if (!story || !childName || !selectedGender) {
      return res.status(400).json({ error: 'Missing required fields: story, childName, selectedGender' });
    }
    const pdfBuffer = await generateTextOnlyPdfBuffer({
      story,
      childName,
      childAge,
      selectedGender,
      options
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('[PDF SERVICE] Error generating text-only PDF:', error);
    res.status(500).json({ error: 'Failed to generate text-only PDF', details: error?.message });
  }
});

app.post('/api/pdf/generate-cover', async (req, res) => {
  try {
    const reqId = req.headers['x-request-id'] || 'no-id';
    console.log(`[PDF MS] (${reqId}) start /api/pdf/generate-cover`);
    const { story, childName, childAge, options = {} } = req.body || {};
    if (!story || !childName) {
      return res.status(400).json({ error: 'Missing required fields: story, childName' });
    }
    const pdfBuffer = await generateCoverPdfBuffer({
      story,
      childName,
      childAge,
      options
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('[PDF SERVICE] Error generating cover PDF:', error);
    res.status(500).json({ error: 'Failed to generate cover PDF', details: error?.message });
  }
});

app.listen(PORT, () => {
  console.log(`PDF service is running on http://localhost:${PORT}`);
});


