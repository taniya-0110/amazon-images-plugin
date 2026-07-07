const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const ChatGPTAutomation = require('./chatgptAutomation');

dotenv.config();

const app = express();
// const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.send('Backend is running perfectly!');
});

// Serve generated and temporary listing images statically
app.use('/generated-images', express.static(path.join(__dirname, 'generated_images')));
app.use('/temp-images', express.static(path.join(__dirname, 'temp_images')));

// Ensure directories exist
const dirs = ['temp_images', 'generated_images', 'playwright-profile1'];
dirs.forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// ==========================================
// GLOBAL STATE - SHARED BETWEEN SERVER AND AUTOMATION
// ==========================================
let currentStatus = {
  status: 'idle',
  message: 'Ready',
  timestamp: new Date().toISOString(),
  data: {}
};

let currentResults = {
  analysis: null,
  generatedImages: [],
  totalImages: 0,
  currentImage: 0,
  rawResponse: null
};

let automationInstance = null;
let continueResolve = null;
let isRunning = false;

function clearDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath)) {
    fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true });
  }
}

function getImageExtension(source) {
  if (!source) return '.jpg';
  if (source.startsWith('data:image/png')) return '.png';
  if (source.startsWith('data:image/webp')) return '.webp';
  if (source.startsWith('data:image/gif')) return '.gif';
  if (source.startsWith('data:image/jpeg') || source.startsWith('data:image/jpg')) return '.jpg';
  try {
    const ext = path.extname(String(source).split('?')[0]).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext) ? ext : '.jpg';
  } catch (error) {
    return '.jpg';
  }
}

function saveFetchedImages(images) {
  const tempDir = path.join(__dirname, 'temp_images');
  clearDirectory(tempDir);

  return images.map((image, index) => {
    const sourceUrl = typeof image === 'string' ? image : image.url;
    const dataUrl = typeof image === 'string' ? '' : image.dataUrl;
    const ext = getImageExtension(dataUrl || sourceUrl);
    const filename = `listing_image_${String(index + 1).padStart(2, '0')}${ext}`;
    const filePath = path.join(tempDir, filename);
    const stored = typeof image === 'string' ? { url: image } : { ...image };

    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return { ...stored, tempFile: '', tempUrl: '' };
    }

    const base64 = dataUrl.split(',')[1];
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));

    return {
      ...stored,
      tempFile: filePath,
      tempUrl: `/temp-images/${filename}`
    };
  });
}

// ==========================================
// STATUS MANAGEMENT
// ==========================================
function updateStatus(status, message, data = {}) {
  if (data.analysis && !currentResults.analysis) {
    currentResults.analysis = data.analysis;
  }

  // CRITICAL FIX: Always update generatedImages from data
  if (Array.isArray(data.generatedImages)) {
    // Merge with existing to avoid duplicates
    const existingNumbers = new Set(currentResults.generatedImages.map(img => img && img.imageNumber));
    for (const img of data.generatedImages) {
      const normalized = normalizeGeneratedImage(img);
      if (normalized && !existingNumbers.has(normalized.imageNumber)) {
        currentResults.generatedImages.push(normalized);
        existingNumbers.add(normalized.imageNumber);
      }
    }
    currentResults.currentImage = getGeneratedCount();
  }

  if (data.totalImages) {
    currentResults.totalImages = data.totalImages;
  }

  if (data.currentImage && status !== 'generating') {
    currentResults.currentImage = data.currentImage;
  }

  currentStatus = {
    status,
    message,
    timestamp: new Date().toISOString(),
    data: { ...currentStatus.data, ...data }
  };
  console.log(`[STATUS] ${status}: ${message}`);
}

function setAnalysisResults(analysis) {
  currentResults.analysis = analysis;
  console.log('[RESULTS] Analysis results stored');
}

function addGeneratedImage(imageData) {
  imageData = normalizeGeneratedImage(imageData);
  if (!imageData) return;

  // Check if this image number already exists
  const existingIndex = currentResults.generatedImages.findIndex(
    img => img.imageNumber === imageData.imageNumber
  );

  if (existingIndex >= 0) {
    currentResults.generatedImages[existingIndex] = imageData;
  } else {
    currentResults.generatedImages.push(imageData);
  }

  currentResults.currentImage = imageData.imageNumber;
  console.log(`[RESULTS] Generated image ${imageData.imageNumber} stored. Total: ${currentResults.generatedImages.length}`);
}

function normalizeGeneratedImage(imageData) {
  if (!imageData || typeof imageData !== 'object') return imageData;

  const normalized = { ...imageData };
  if (!normalized.imageUrl && normalized.url) {
    normalized.imageUrl = normalized.url;
  }

  if (!normalized.imageUrl && normalized.filePath) {
    normalized.imageUrl = `/generated-images/${path.basename(normalized.filePath)}`;
  }

  return normalized;
}

function hydrateResultsFromDisk() {
  const resultsFile = path.join(__dirname, 'analysis_results.json');
  if (!fs.existsSync(resultsFile)) return;

  try {
    const saved = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const savedAnalysis = saved.analysis || saved.results?.analysis || null;
    const savedGeneratedImages = saved.generatedImages || saved.results?.generatedImages || [];
    const savedCurrentImage = saved.currentImage || saved.results?.currentImage || 0;

    if (!currentResults.analysis && savedAnalysis) {
      currentResults.analysis = savedAnalysis;
      currentResults.rawResponse = saved.fullResponse || saved.rawResponse || saved.results?.rawResponse || currentResults.rawResponse;
    }

    // Only update generated images if we have new ones
    if (Array.isArray(savedGeneratedImages) && savedGeneratedImages.length > 0) {
      // Merge with existing images to avoid duplicates
      const existingNumbers = new Set(currentResults.generatedImages.map(img => img && img.imageNumber));
      for (const img of savedGeneratedImages) {
        const normalized = normalizeGeneratedImage(img);
        if (normalized && !existingNumbers.has(normalized.imageNumber)) {
          currentResults.generatedImages.push(normalized);
          existingNumbers.add(normalized.imageNumber);
        }
      }
      currentResults.currentImage = Math.max(currentResults.currentImage, getGeneratedCount());
    }

    if (!currentResults.totalImages) {
      currentResults.totalImages = currentResults.generatedImages.length || currentResults.analysis?.detailedAnalysis?.length || 0;
    }
  } catch (error) {
    console.warn('[RESULTS] Could not hydrate saved results:', error.message);
  }
}

function getGeneratedCount() {
  // Only count images that have actual file paths or URLs
  return currentResults.generatedImages.filter(img => 
    img.filePath || img.imageUrl || img.url
  ).length;
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get current status
app.get('/api/status', (req, res) => {
  hydrateResultsFromDisk();

  res.json({
    ...currentStatus,
    generatedCount: getGeneratedCount(),
    totalImages: currentResults.totalImages,
    generatedImages: currentResults.generatedImages // Include generated images in status
  });
});

// Get analysis results
app.get('/api/analysis-results', (req, res) => {
  hydrateResultsFromDisk();
  currentResults.currentImage = getGeneratedCount();

  if (!currentResults.analysis) {
    return res.status(404).json({ 
      success: false, 
      error: 'No analysis results available yet' 
    });
  }

  res.json({
    success: true,
    analysis: currentResults.analysis,
    generatedImages: currentResults.generatedImages,
    totalImages: currentResults.totalImages,
    currentImage: currentResults.currentImage,
    rawResponse: currentResults.rawResponse
  });
});

// Get all results
app.get('/api/results', (req, res) => {
  hydrateResultsFromDisk();
  currentResults.currentImage = getGeneratedCount();

  res.json({
    success: true,
    results: currentResults,
    generatedCount: getGeneratedCount(),
    status: currentStatus.status
  });
});

// Store fetched Seller Central images in the temp folder immediately.
app.post('/api/store-images', (req, res) => {
  try {
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No images provided'
      });
    }

    const storedImages = saveFetchedImages(images);

    currentResults = {
      analysis: null,
      generatedImages: [],
      totalImages: storedImages.length,
      currentImage: 0,
      rawResponse: null
    };

    fs.writeFileSync(path.join(__dirname, 'analysis_results.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'images_stored',
      analysis: null,
      generatedImages: [],
      currentImage: 0,
      totalImages: storedImages.length,
      status: 'images_stored'
    }, null, 2));

    currentStatus.data = {};
    updateStatus('images_stored', `${storedImages.length} listing images stored in temp folder.`, {
      totalImages: storedImages.length,
      tempImages: storedImages.map((img) => img.tempUrl).filter(Boolean)
    });

    res.json({
      success: true,
      images: storedImages,
      totalImages: storedImages.length
    });
  } catch (error) {
    console.error('[STORE] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate one image at a time after analysis is complete.
app.post('/api/continue', async (req, res) => {
  console.log('[CONTINUE] Received generate-next request from plugin');

  if (!automationInstance || !currentResults.analysis) {
    return res.status(400).json({
      success: false,
      error: 'Run analysis before generating images.'
    });
  }

  try {
    const result = await automationInstance.generateNextImageFromActiveChat();
    res.json({
      success: true,
      message: result.complete ? 'All images generated' : 'Image generated',
      result
    });
  } catch (error) {
    console.error('[CONTINUE] Error:', error);
    updateStatus('error', error.message, {
      analysis: currentResults.analysis,
      generatedImages: currentResults.generatedImages,
      totalImages: currentResults.totalImages,
      currentImage: currentResults.currentImage
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Main analyze endpoint
app.post('/api/analyze-images', async (req, res) => {
  try {
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No images provided' 
      });
    }

    if (isRunning) {
      return res.status(409).json({
        success: false,
        error: 'Analysis already in progress'
      });
    }

    console.log(`[ANALYZE] Received ${images.length} images for analysis`);
    const storedImages = saveFetchedImages(images);

    // Reset state
    currentResults = {
      analysis: null,
      generatedImages: [],
      totalImages: storedImages.length,
      currentImage: 0,
      rawResponse: null
    };

    fs.writeFileSync(path.join(__dirname, 'analysis_results.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'analysis_started',
      analysis: null,
      generatedImages: [],
      currentImage: 0,
      totalImages: storedImages.length,
      status: 'starting'
    }, null, 2));

    isRunning = true;
    currentStatus.data = {};
    updateStatus('starting', 'Starting analysis...', { totalImages: storedImages.length });

    // Start automation in background
    res.json({ 
      success: true, 
      message: 'Analysis started',
      totalImages: storedImages.length
    });

    // Run automation
    try {
      const results = await runAutomation(storedImages);
      console.log('[AUTOMATION] Analysis completed successfully');
      updateStatus('analysis_complete', 'Analysis complete! Click Generate First Image when ready.', {
        totalImages: results.totalImages,
        generatedImages: results.generatedImages,
        analysis: results.analysis
      });
    } catch (err) {
      console.error('[AUTOMATION] Error:', err);
      updateStatus('error', err.message);
    } finally {
      isRunning = false;
    }

  } catch (error) {
    console.error('[ERROR] Analyze endpoint:', error);
    updateStatus('error', error.message);
    isRunning = false;
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// AUTOMATION RUNNER
// ==========================================
async function runAutomation(images) {
  automationInstance = ChatGPTAutomation;

  // Inject server state callbacks into automation
  automationInstance._serverSetAnalysis = function(analysis, rawResponse) {
    setAnalysisResults(analysis);
    if (rawResponse) currentResults.rawResponse = rawResponse;
    updateStatus('analysis_complete', 'Analysis complete! Review results in plugin.', {
      analysis: analysis,
      totalImages: images.length
    });
  };

  automationInstance._serverAddGeneratedImage = function(imageData) {
    addGeneratedImage(imageData);
    // IMPORTANT: When an image is generated, update status with the image data
    // This will trigger the plugin to display it automatically
    updateStatus('image_generated', `Image ${imageData.imageNumber} generated successfully!`, {
      currentImage: getGeneratedCount(),
      totalImages: currentResults.totalImages,
      generatedImages: currentResults.generatedImages,
      analysis: currentResults.analysis
    });
  };

  automationInstance._serverUpdateStatus = function(status, message, data) {
    updateStatus(status, message, data);
  };

  automationInstance._serverWaitForContinue = async function() {
    return new Promise((resolve) => {
      continueResolve = resolve;

      // Also set up file-based watcher as backup
      const continueSignalFile = path.join(__dirname, 'continue_signal.json');
      fs.writeFileSync(continueSignalFile, JSON.stringify({ status: 'waiting' }));

      // Timeout after 30 minutes
      setTimeout(() => {
        if (continueResolve) {
          continueResolve({ continue: false, timeout: true });
          continueResolve = null;
        }
      }, 30 * 60 * 1000);
    });
  };

  // Run the main analysis
  const results = await automationInstance.analyzeWithChatGPT(images);

  return results;
}

// ==========================================
// START SERVER
// ==========================================
app.listen(BACKEND_URL, () => {
  console.log(`\n🚀 Amazon Image Analyzer Backend running on ${BACKEND_URL}`);
  console.log(`📊 API Endpoints:`);
  console.log(`   GET  /api/health           - Health check`);
  console.log(`   GET  /api/status           - Current status`);
  console.log(`   GET  /api/analysis-results - Analysis results`);
  console.log(`   GET  /api/results          - All results`);
  console.log(`   POST /api/analyze-images   - Start analysis`);
  console.log(`   POST /api/continue         - Continue to next image`);
  console.log(`\n📁 Generated images served at: ${BACKEND_URL}/generated-images/`);
});
