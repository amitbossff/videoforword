const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 5000;

// ============ CONFIGURATION ============
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL.startsWith('http') 
  ? process.env.BASE_URL 
  : `https://${process.env.BASE_URL}`;
const FRONTEND_URL = process.env.FRONTEND_URL.startsWith('http')
  ? process.env.FRONTEND_URL
  : `https://${process.env.FRONTEND_URL}`;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'bot_system';
const BOT_COLLECTION = 'bot_links';
const SESSION_COLLECTION = 'sessions';
const SESSION_SECRET = process.env.SESSION_SECRET;

// ============ FFMPEG SETUP ============
let FFMPEG_PATH = null;
const possiblePaths = [
  path.join(__dirname, 'bin', 'ffmpeg'),
  path.join(__dirname, 'ffmpeg'),
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg'
];

console.log('🔍 Looking for FFmpeg...');
for (const testPath of possiblePaths) {
  if (fs.existsSync(testPath)) {
    FFMPEG_PATH = testPath;
    console.log(`✅ FFmpeg found at: ${FFMPEG_PATH}`);
    
    // Set execute permission
    try {
      fs.chmodSync(FFMPEG_PATH, 0o755);
      console.log('✅ FFmpeg permissions set');
    } catch (e) {
      console.log('⚠️ Could not set permissions:', e.message);
    }
    break;
  }
}

if (!FFMPEG_PATH) {
  console.warn('⚠️ FFmpeg not found, compression will be disabled');
}

// ============ GLOBAL VARIABLES ============
let db;
let dbConnected = false;
const convState = new Map();

// ============ CORS ============
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin']
}));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser(SESSION_SECRET));

// ============ MONGODB ============
const client = new MongoClient(MONGODB_URI, {
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

async function connectToMongoDB() {
  try {
    await client.connect();
    db = client.db(DB_NAME);
    dbConnected = true;
    console.log('✅ MongoDB connected');
    
    app.locals.db = db.collection(BOT_COLLECTION);
    app.locals.sessions = db.collection(SESSION_COLLECTION);
    
    await db.collection(BOT_COLLECTION).createIndex({ user_id: 1 }, { unique: true });
    await db.collection(BOT_COLLECTION).createIndex({ bot_token: 1 });
    await db.collection(SESSION_COLLECTION).createIndex({ session_id: 1 });
    await db.collection(SESSION_COLLECTION).createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    
  } catch (err) {
    console.error('❌ MongoDB failed:', err.message);
    dbConnected = false;
    setTimeout(connectToMongoDB, 5000);
  }
}
connectToMongoDB();

// ============ MULTER SETUP ============
const tempDir = os.tmpdir();
console.log(`📁 Temp dir: ${tempDir}`);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${uuidv4().substring(0, 8)}`;
    cb(null, `original-${unique}.mp4`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files allowed'));
    }
  }
});

// ============ VIDEO COMPRESSION ============
async function compressVideo(inputPath, maxSizeMB = 9) {
  console.log('\n🎬 ===== COMPRESSION STARTED =====');
  console.log(`📥 Input: ${inputPath}`);
  
  if (!FFMPEG_PATH) {
    console.log('⚠️ FFmpeg not available, sending original');
    return inputPath;
  }

  const outputPath = inputPath.replace('original-', 'compressed-');
  const stats = fs.statSync(inputPath);
  const inputSizeMB = stats.size / (1024 * 1024);
  
  console.log(`📊 Original size: ${inputSizeMB.toFixed(2)} MB`);
  
  // अगर पहले से 9MB से कम है तो skip करें
  if (inputSizeMB <= maxSizeMB) {
    console.log(`✅ Video already under ${maxSizeMB}MB, skipping compression`);
    return inputPath;
  }
  
  try {
    // Video duration निकालें
    console.log('⏱️ Getting video duration...');
    const durationCmd = `${FFMPEG_PATH} -i "${inputPath}" 2>&1 | grep Duration | awk '{print $2}' | tr -d ,`;
    const { stdout: durationStr } = await execPromise(durationCmd, { shell: true });
    
    let duration = 60; // default
    if (durationStr) {
      const parts = durationStr.trim().split(':');
      if (parts.length === 3) {
        duration = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
      }
    }
    console.log(`⏱️ Duration: ${duration.toFixed(2)} seconds`);
    
    // Calculate bitrate
    const targetSizeBits = maxSizeMB * 8 * 1024 * 1024;
    const targetBitrate = Math.floor(targetSizeBits / duration / 1000);
    console.log(`🎯 Target bitrate: ${targetBitrate}kbps`);
    
    // FFmpeg command
    const command = `${FFMPEG_PATH} -i "${inputPath}" ` +
      `-c:v libx264 -preset fast ` +
      `-b:v ${targetBitrate}k -maxrate ${targetBitrate * 1.5}k -bufsize ${targetBitrate * 2}k ` +
      `-c:a aac -b:a 128k ` +
      `-movflags +faststart ` +
      `-y "${outputPath}"`;
    
    console.log('🎬 Running FFmpeg compression...');
    console.log('⏳ This may take a few moments...');
    
    await execPromise(command);
    
    // Check result
    const compressedStats = fs.statSync(outputPath);
    const compressedSizeMB = compressedStats.size / (1024 * 1024);
    console.log(`✅ Compressed size: ${compressedSizeMB.toFixed(2)} MB`);
    console.log(`📊 Compression ratio: ${(compressedSizeMB/inputSizeMB*100).toFixed(1)}%`);
    
    // Delete original
    fs.unlinkSync(inputPath);
    console.log('🧹 Original file deleted');
    console.log('🎬 ===== COMPRESSION COMPLETE =====\n');
    
    return outputPath;
  } catch (err) {
    console.error('❌ Compression failed:', err.message);
    console.log('⚠️ Sending original file instead');
    return inputPath;
  }
}

// ============ TELEGRAM FUNCTIONS ============
async function sendTelegramVideo(token, chatId, filePath, caption) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendVideo`;
    
    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);
    const sizeMB = stats.size / (1024 * 1024);
    
    console.log(`📤 Sending to Telegram: ${sizeMB.toFixed(2)} MB`);
    
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('video', fileStream, { 
      filename: 'video.mp4', 
      contentType: 'video/mp4',
      knownLength: stats.size
    });
    
    if (caption) form.append('caption', caption);
    form.append('supports_streaming', 'true');
    form.append('parse_mode', 'HTML');

    const response = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000
    });
    
    console.log('✅ Telegram send successful');
    return response.data;
  } catch (err) {
    console.error('❌ Telegram send error:', err.response?.data || err.message);
    return err.response?.data || { ok: false, error: err.message };
  }
}

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: dbConnected ? 'connected' : 'disconnected',
    ffmpeg: FFMPEG_PATH ? 'available' : 'not found',
    tempDir: tempDir,
    time: new Date().toISOString()
  });
});

// ============ MAIN BOT WEBHOOK (simplified) ============
app.post('/main', async (req, res) => {
  res.send('OK');
  // Add your main bot logic here
});

// ============ LOGIN API ============
app.post('/api/login', express.urlencoded({ extended: false }), async (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { user_id } = req.body;
    
    if (!user_id) return res.status(400).json({ error: 'User ID required' });
    if (!/^\d+$/.test(user_id)) return res.status(400).json({ error: 'User ID must contain only numbers' });

    const token = await db.collection(BOT_COLLECTION).findOne({ user_id });
    if (!token) return res.status(401).json({ error: 'User not registered' });

    const sessionId = uuidv4();
    await db.collection(SESSION_COLLECTION).insertOne({
      session_id: sessionId,
      user_id,
      created_at: new Date(),
      expires: new Date(Date.now() + 7 * 86400000)
    });

    res.cookie('session', sessionId, { 
      httpOnly: true, 
      secure: true, 
      sameSite: 'none',
      maxAge: 7 * 86400000
    });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============ UPLOAD API ============
app.post('/api/upload', upload.single('video'), async (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  let finalFilePath = null;
  let originalPath = null;
  
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const session = await db.collection(SESSION_COLLECTION).findOne({ session_id: sessionId });
    if (!session) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const userId = session.user_id;
    const botData = await db.collection(BOT_COLLECTION).findOne({ user_id: userId });
    if (!botData) {
      return res.status(400).json({ error: 'Bot not linked' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No video uploaded' });
    }

    originalPath = req.file.path;
    const caption = req.body.caption || '';
    const originalSize = req.file.size / (1024 * 1024);

    console.log('\n📁 ===== NEW UPLOAD =====');
    console.log(`👤 User: ${userId}`);
    console.log(`📊 Original size: ${originalSize.toFixed(2)} MB`);

    // Step 1: COMPRESS VIDEO FIRST
    console.log('⏳ Step 1: Compressing video...');
    finalFilePath = await compressVideo(originalPath, 9);
    
    // Step 2: SEND TO TELEGRAM
    console.log('⏳ Step 2: Sending to Telegram...');
    const result = await sendTelegramVideo(botData.bot_token, userId, finalFilePath, caption);

    // Step 3: CLEANUP
    if (finalFilePath && fs.existsSync(finalFilePath)) {
      fs.unlinkSync(finalFilePath);
      console.log('🧹 Cleanup complete');
    }

    if (result.ok) {
      const finalStats = fs.statSync(finalFilePath);
      const finalSizeMB = finalStats.size / (1024 * 1024);
      
      console.log('✅ ===== UPLOAD COMPLETE =====\n');
      res.json({ 
        success: true,
        original_size: originalSize.toFixed(2),
        final_size: finalSizeMB.toFixed(2),
        compressed: finalSizeMB < originalSize
      });
    } else {
      throw new Error(result.description || 'Failed to send video');
    }

  } catch (error) {
    console.error('❌ Upload error:', error);
    
    if (originalPath && fs.existsSync(originalPath)) {
      fs.unlinkSync(originalPath);
    }
    if (finalFilePath && finalFilePath !== originalPath && fs.existsSync(finalFilePath)) {
      fs.unlinkSync(finalFilePath);
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============ LOGOUT API ============
app.post('/api/logout', async (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const sessionId = req.cookies.session;
  if (sessionId) {
    await db.collection(SESSION_COLLECTION).deleteOne({ session_id: sessionId });
  }
  res.clearCookie('session');
  res.json({ success: true });
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 200MB.' });
    }
  }
  
  res.status(500).json({ error: err.message });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
  console.log(`🎬 FFmpeg: ${FFMPEG_PATH ? '✅ Available' : '❌ Not found'}`);
  console.log('='.repeat(60) + '\n');
});

process.on('SIGTERM', () => {
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.close();
  process.exit(0);
});
