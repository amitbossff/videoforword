const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');

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

// ============ FIXED CORS CONFIGURATION ============
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:5000',
  'http://localhost:3000',
  'https://videoforword.vercel.app'
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('vercel.app')) {
      callback(null, true);
    } else {
      console.log('❌ Blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin']
}));

// Handle preflight requests
app.options('*', cors());

// Body parsers
app.use(express.json({
  limit: '500mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(cookieParser(SESSION_SECRET));

// ============ MONGODB CONNECTION WITH RETRY ============
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
    
    // Create indexes for better performance
    await db.collection(BOT_COLLECTION).createIndex({ user_id: 1 }, { unique: true });
    await db.collection(BOT_COLLECTION).createIndex({ bot_token: 1 });
    await db.collection(SESSION_COLLECTION).createIndex({ session_id: 1 });
    await db.collection(SESSION_COLLECTION).createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    
    console.log('✅ Database indexes created');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    dbConnected = false;
    // Retry after 5 seconds
    setTimeout(connectToMongoDB, 5000);
  }
}

// Start connection
connectToMongoDB();

// ============ MULTER SETUP (200MB limit) ============
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { 
    fileSize: 200 * 1024 * 1024, // 200 MB
    files: 1
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
    console.log('✅ Session created for user:', userId);
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
    console.log('✅ Session deleted:', sessionId);
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

async function sendTelegramVideo(token, chatId, buffer, caption) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendVideo`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('video', buffer, { 
      filename: 'video.mp4', 
      contentType: 'video/mp4' 
    });
    if (caption) form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    const res = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        'Content-Length': form.getLengthSync()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    console.log('✅ Video sent to Telegram:', res.data.ok);
    return res.data;
  } catch (err) {
    console.error('Error sending Telegram video:', err.response?.data || err.message);
    return { ok: false, error: err.message };
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
    console.log('✅ Webhook set for token:', token.substring(0, 10) + '...');
    return res.data;
  } catch (err) {
    console.error('Error setting webhook:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

// ============ HEALTH CHECK ENDPOINTS ============
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '🚀 Bot system is running!',
    mongodb: dbConnected ? 'connected' : 'disconnected',
    time: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: dbConnected ? 'connected' : 'disconnected',
    time: new Date().toISOString()
  });
});

app.head('/main', (req, res) => res.send('OK'));
app.get('/main', (req, res) => res.send('OK'));

// ============ CHECK SESSION ENDPOINT ============
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
  // Immediately send 200 OK to Telegram
  res.send('OK');
  
  try {
    const update = req.body;
    console.log('📩 Received update:', update?.update_id);
    
    const message = update?.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = message.text || '';
    const username = message.from?.username || 'No username';
    const firstName = message.from?.first_name || 'User';

    console.log(`💬 Message from ${firstName} (@${username}): ${text}`);

    // Handle /start command
    if (text === '/start') {
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        `Hello ${firstName}! 👋\n\n` +
        `I can help you link your own bot to receive videos.\n` +
        `Use /add to get started.`
      );
      return;
    }

    // Get conversation state
    const state = convState.get(chatId);

    // Handle /add command
    if (text === '/add') {
      convState.set(chatId, { step: 'awaiting_token' });
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        '🔧 Please send me your bot token (from @BotFather)'
      );
      return;
    }

    // Handle token input
    if (state && state.step === 'awaiting_token') {
      const botToken = text.trim();
      
      try {
        // Validate token by getting bot info
        const me = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`);
        
        if (!me.data.ok) {
          throw new Error('Invalid token');
        }

        // Store token temporarily in conversation state
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
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          '❌ Invalid token. Please check and try again.'
        );
        convState.delete(chatId);
      }
      return;
    }

    // Handle user ID input
    if (state && state.step === 'awaiting_userid') {
      const userId = text.trim();
      
      // Validate user ID (should be numbers only)
      if (!/^\d+$/.test(userId)) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          '❌ User ID must contain only numbers. Please try again.'
        );
        return;
      }

      const botToken = state.botToken;
      
      // Store in MongoDB
      const stored = await storeBotLink(userId, botToken);
      
      if (!stored) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          '⚠️ Database connection issue. Please try again later.'
        );
        convState.delete(chatId);
        return;
      }

      // Set webhook for user's bot
      const webhookUrl = `${BASE_URL}/webhook/${botToken}`;
      const setResult = await setWebhook(botToken, webhookUrl);

      if (setResult.ok) {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          `✅ Bot successfully linked!\n\n` +
          `You can now login at: ${FRONTEND_URL}\n` +
          `Use your User ID: ${userId}\n\n` +
          `📤 Upload videos and they'll be sent to your bot!`
        );
      } else {
        await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
          `⚠️ Bot linked but webhook setup failed.\n` +
          `Please manually set webhook to:\n${webhookUrl}`
        );
      }

      // Clear conversation state
      convState.delete(chatId);
      return;
    }

    // Default response for unknown messages
    await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
      'Use /add to link your bot, or /start to see welcome message.'
    );

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
  }
});

// ============ LINKED BOT WEBHOOK ============
app.post('/webhook/:token', async (req, res) => {
  // Immediately respond
  res.send('OK');
  
  try {
    const { token } = req.params;
    const update = req.body;
    
    const message = update?.message;
    if (!message) return;

    // Get user ID associated with this bot token
    const userId = await getUserIdByToken(token);
    if (!userId) {
      console.log('Unknown bot token:', token?.substring(0, 10) + '...');
      return;
    }

    // Handle /start command on linked bot
    if (message.text === '/start') {
      await sendTelegramMessage(token, userId,
        '✅ Your bot is active and ready!\n\n' +
        'Anyone can start this bot, and you\'ll receive videos from your web interface.'
      );
      
      // Also notify the person who started the bot
      if (message.chat.id.toString() !== userId) {
        await sendTelegramMessage(token, message.chat.id,
          '👋 Welcome! This bot is linked to another user for video delivery.'
        );
      }
    }
  } catch (error) {
    console.error('Error processing linked bot webhook:', error);
  }
});

// ============ API: LOGIN ============
app.post('/api/login', express.urlencoded({ extended: false }), async (req, res) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { user_id } = req.body;
    console.log('🔐 Login attempt for user:', user_id);
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Validate user_id format
    if (!/^\d+$/.test(user_id)) {
      return res.status(400).json({ error: 'User ID must contain only numbers' });
    }

    const token = await getBotToken(user_id);
    if (!token) {
      console.log('❌ User not registered:', user_id);
      return res.status(401).json({ error: 'User not registered. Please /add first.' });
    }

    const sessionId = await createSession(user_id);
    if (!sessionId) {
      return res.status(500).json({ error: 'Could not create session' });
    }

    // Set cookie
    res.cookie('session', sessionId, { 
      httpOnly: true, 
      secure: true, 
      sameSite: 'none', // Changed from 'strict' to 'none' for cross-site
      maxAge: 7 * 86400000 // 7 days
    });
    
    console.log('✅ Login successful for user:', user_id);
    res.json({ success: true });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============ API: UPLOAD ============
app.post('/api/upload', upload.single('video'), async (req, res) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
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

    const videoFile = req.file;
    if (!videoFile) {
      return res.status(400).json({ error: 'No video uploaded' });
    }

    const caption = req.body.caption || '';

    console.log(`📤 Uploading video for user ${userId}, size: ${(videoFile.size / 1024 / 1024).toFixed(2)} MB`);

    const result = await sendTelegramVideo(botToken, userId, videoFile.buffer, caption);

    if (result.ok) {
      console.log(`✅ Video sent successfully to ${userId}`);
      res.json({ success: true });
    } else {
      console.error('Telegram API error:', result);
      res.status(500).json({ 
        success: false, 
        error: result.description || 'Failed to send video' 
      });
    }
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ API: LOGOUT ============
app.post('/api/logout', async (req, res) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const sessionId = req.cookies.session;
  if (sessionId) {
    await deleteSession(sessionId);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

// ============ OPTIONS HANDLER FOR ALL ROUTES ============
app.options('/api/*', (req, res) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// ============ ERROR HANDLING MIDDLEWARE ============
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  
  // Set CORS headers for errors too
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 200MB.' });
    }
  }
  
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

// ============ 404 HANDLER ============
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📱 Main bot webhook URL: ${BASE_URL}/main`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
  console.log(`💾 MongoDB: ${dbConnected ? '✅ Connected' : '❌ Connecting...'}`);
  console.log('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await client.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing connections...');
  await client.close();
  process.exit(0);
});
