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

// ============ GLOBAL VARIABLES ============
let db;
let dbConnected = false;
const convState = new Map(); // Conversation state

// ============ CORS CONFIGURATION ============
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin']
}));

// Handle preflight requests
app.options('*', cors());

// Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser(SESSION_SECRET));

// ============ MONGODB CONNECTION ============
const client = new MongoClient(MONGODB_URI, {
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

async function connectToMongoDB() {
  try {
    await client.connect();
    db = client.db(DB_NAME);
    dbConnected = true;
    console.log('✅ MongoDB connected successfully');
    
    // Store db in app locals for routes
    app.locals.db = db.collection(BOT_COLLECTION);
    app.locals.sessions = db.collection(SESSION_COLLECTION);
    
    // Create indexes
    await db.collection(BOT_COLLECTION).createIndex({ user_id: 1 }, { unique: true });
    await db.collection(BOT_COLLECTION).createIndex({ bot_token: 1 });
    await db.collection(SESSION_COLLECTION).createIndex({ session_id: 1 });
    await db.collection(SESSION_COLLECTION).createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    dbConnected = false;
    setTimeout(connectToMongoDB, 5000);
  }
}
connectToMongoDB();

// ============ MULTER SETUP FOR TEMP FILE STORAGE ============
// यह file को Render के temporary disk पर store करेगा
const tempDir = os.tmpdir();
console.log(`📁 Temp directory: ${tempDir}`);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${uuidv4().substring(0, 8)}`;
    cb(null, `video-${unique}.mp4`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 200 * 1024 * 1024, // 200 MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

// ============ HELPER FUNCTIONS ============
async function getBotToken(userId) {
  if (!dbConnected) return null;
  try {
    const doc = await db.collection(BOT_COLLECTION).findOne({ user_id: userId });
    return doc ? doc.bot_token : null;
  } catch (err) {
    console.error('Error getting bot token:', err);
    return null;
  }
}

async function getUserIdByToken(botToken) {
  if (!dbConnected) return null;
  try {
    const doc = await db.collection(BOT_COLLECTION).findOne({ bot_token: botToken });
    return doc ? doc.user_id : null;
  } catch (err) {
    console.error('Error getting user ID by token:', err);
    return null;
  }
}

async function storeBotLink(userId, botToken) {
  if (!dbConnected) return false;
  try {
    await db.collection(BOT_COLLECTION).updateOne(
      { user_id: userId },
      { 
        $set: { 
          user_id: userId, 
          bot_token: botToken, 
          created_at: new Date(),
          updated_at: new Date()
        } 
      },
      { upsert: true }
    );
    console.log('✅ Bot link stored for user:', userId);
    return true;
  } catch (err) {
    console.error('Error storing bot link:', err);
    return false;
  }
}

async function createSession(userId) {
  if (!dbConnected) return null;
  try {
    const sessionId = uuidv4();
    const expires = new Date(Date.now() + 7 * 86400 * 1000); // 7 days
    await db.collection(SESSION_COLLECTION).insertOne({
      session_id: sessionId,
      user_id: userId,
      created_at: new Date(),
      expires
    });
    return sessionId;
  } catch (err) {
    console.error('Error creating session:', err);
    return null;
  }
}

async function getSessionUser(sessionId) {
  if (!dbConnected) return null;
  try {
    const doc = await db.collection(SESSION_COLLECTION).findOne({
      session_id: sessionId,
      expires: { $gt: new Date() }
    });
    return doc ? doc.user_id : null;
  } catch (err) {
    console.error('Error getting session user:', err);
    return null;
  }
}

async function deleteSession(sessionId) {
  if (!dbConnected) return;
  try {
    await db.collection(SESSION_COLLECTION).deleteOne({ session_id: sessionId });
  } catch (err) {
    console.error('Error deleting session:', err);
  }
}

// ============ TELEGRAM API FUNCTIONS ============
async function sendTelegramMessage(token, chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    });
    return res.data;
  } catch (err) {
    console.error('Error sending Telegram message:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function sendTelegramVideo(token, chatId, filePath, caption) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendVideo`;
    
    // Create readable stream from file
    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);
    
    console.log(`📤 Sending video to Telegram, size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('video', fileStream, { 
      filename: 'video.mp4', 
      contentType: 'video/mp4',
      knownLength: stats.size
    });
    
    if (caption) {
      form.append('caption', caption);
    }
    form.append('parse_mode', 'HTML');

    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000 // 2 minutes timeout for large files
    });
    
    return response.data;
  } catch (err) {
    console.error('❌ Telegram send error:', err.response?.data || err.message);
    if (err.response?.data) {
      return err.response.data;
    }
    throw err;
  }
}

async function setWebhook(token, webhookUrl) {
  try {
    const url = `https://api.telegram.org/bot${token}/setWebhook`;
    const res = await axios.post(url, { 
      url: webhookUrl,
      max_connections: 40,
      allowed_updates: ['message']
    });
    return res.data;
  } catch (err) {
    console.error('Error setting webhook:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: dbConnected ? 'connected' : 'disconnected',
    tempDir: tempDir,
    time: new Date().toISOString()
  });
});

app.head('/main', (req, res) => res.send('OK'));
app.get('/main', (req, res) => res.send('OK'));

// ============ CHECK SESSION ============
app.get('/api/check-session', async (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const sessionId = req.cookies.session;
  if (!sessionId) {
    return res.json({ loggedIn: false });
  }
  
  const userId = await getSessionUser(sessionId);
  if (userId) {
    res.json({ loggedIn: true, userId });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============ MAIN BOT WEBHOOK ============
app.post('/main', async (req, res) => {
  res.send('OK');
  
  try {
    const update = req.body;
    const message = update?.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = message.text || '';
    const firstName = message.from?.first_name || 'User';

    const state = convState.get(chatId);

    if (text === '/start') {
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        `Hello ${firstName}! 👋\n\n` +
        `I can help you link your own bot to receive videos.\n` +
        `Use /add to get started.`
      );
      return;
    }

    if (text === '/add') {
      convState.set(chatId, { step: 'awaiting_token' });
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        '🔧 Please send me your bot token (from @BotFather)'
      );
      return;
    }

    if (state && state.step === 'awaiting_token') {
      const botToken = text.trim();
      
      try {
        const me = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`);
        
        if (!me.data.ok) throw new Error('Invalid token');

        convState.set(chatId, { 
          step: 'awaiting_userid', 
          botToken,
          botUsername: me.data.result.username 
        });

        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          `✅ Bot @${me.data.result.username} is valid!\n\n` +
          `Now please send your Telegram User ID\n` +
          `(You can get it from @userinfobot)`
        );
      } catch (error) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId, '❌ Invalid token. Please try again.');
        convState.delete(chatId);
      }
      return;
    }

    if (state && state.step === 'awaiting_userid') {
      const userId = text.trim();
      
      if (!/^\d+$/.test(userId)) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId, '❌ User ID must contain only numbers.');
        return;
      }

      const botToken = state.botToken;
      const stored = await storeBotLink(userId, botToken);
      
      if (!stored) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId, '⚠️ Database issue. Try again later.');
        convState.delete(chatId);
        return;
      }

      const webhookUrl = `${BASE_URL}/webhook/${botToken}`;
      const setResult = await setWebhook(botToken, webhookUrl);

      if (setResult.ok) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          `✅ Bot successfully linked!\n\n` +
          `You can now login at: ${FRONTEND_URL}\n` +
          `Use your User ID: ${userId}`
        );
      } else {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          `⚠️ Bot linked but webhook failed.\nManual webhook: ${webhookUrl}`
        );
      }

      convState.delete(chatId);
      return;
    }

    await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
      'Use /add to link your bot, or /start to see welcome message.'
    );

  } catch (error) {
    console.error('❌ Webhook error:', error);
  }
});

// ============ LINKED BOT WEBHOOK ============
app.post('/webhook/:token', async (req, res) => {
  res.send('OK');
  
  try {
    const { token } = req.params;
    const update = req.body;
    const message = update?.message;
    if (!message) return;

    const userId = await getUserIdByToken(token);
    if (!userId) return;

    if (message.text === '/start') {
      await sendTelegramMessage(token, userId, '✅ Your bot is active and ready!');
      
      if (message.chat.id.toString() !== userId) {
        await sendTelegramMessage(token, message.chat.id,
          '👋 This bot is linked to another user for video delivery.'
        );
      }
    }
  } catch (error) {
    console.error('Linked bot webhook error:', error);
  }
});

// ============ LOGIN API ============
app.post('/api/login', express.urlencoded({ extended: false }), async (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required' });
    }

    if (!/^\d+$/.test(user_id)) {
      return res.status(400).json({ error: 'User ID must contain only numbers' });
    }

    const token = await getBotToken(user_id);
    if (!token) {
      return res.status(401).json({ error: 'User not registered. Please /add first.' });
    }

    const sessionId = await createSession(user_id);
    if (!sessionId) {
      return res.status(500).json({ error: 'Could not create session' });
    }

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
  
  let tempFilePath = null;
  
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const userId = await getSessionUser(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const botToken = await getBotToken(userId);
    if (!botToken) {
      return res.status(400).json({ error: 'Bot not linked. Please /add first.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No video uploaded' });
    }

    tempFilePath = req.file.path;
    const fileSize = req.file.size;
    const caption = req.body.caption || '';

    console.log(`📁 File saved: ${tempFilePath}`);
    console.log(`📤 Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB for user ${userId}`);

    // Send to Telegram
    const result = await sendTelegramVideo(botToken, userId, tempFilePath, caption);

    // Clean up temp file
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      console.log(`🧹 Temp file deleted: ${tempFilePath}`);
    }

    if (result.ok) {
      console.log(`✅ Video sent successfully to ${userId}`);
      res.json({ success: true });
    } else {
      console.error('Telegram error:', result);
      res.status(500).json({ 
        success: false, 
        error: result.description || 'Failed to send video' 
      });
    }

  } catch (error) {
    console.error('❌ Upload error:', error);
    
    // Clean up temp file on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Upload failed'
    });
  }
});

// ============ LOGOUT API ============
app.post('/api/logout', async (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const sessionId = req.cookies.session;
  if (sessionId) {
    await deleteSession(sessionId);
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
    return res.status(400).json({ error: err.message });
  }
  
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Main bot webhook: ${BASE_URL}/main`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
  console.log(`📁 Temp directory: ${tempDir}`);
  console.log('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing...');
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing...');
  client.close();
  process.exit(0);
});
