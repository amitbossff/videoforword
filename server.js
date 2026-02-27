const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ कॉन्फ़िगरेशन (Render Env Vars से) ============
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

// ============ MongoDB कनेक्शन ============
let db;
MongoClient.connect(MONGODB_URI)
  .then(client => {
    db = client.db(DB_NAME);
    console.log('✅ MongoDB connected');
  })
  .catch(err => console.error('❌ MongoDB error:', err));

// ============ मिडलवेयर ============
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));
app.use(cookieParser(SESSION_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ Multer सेटअप (200MB लिमिट) ============
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200 MB
});

// ============ हेल्पर फंक्शन ============
async function getBotToken(userId) {
  const doc = await db.collection(BOT_COLLECTION).findOne({ user_id: userId });
  return doc ? doc.bot_token : null;
}

async function getUserIdByToken(botToken) {
  const doc = await db.collection(BOT_COLLECTION).findOne({ bot_token: botToken });
  return doc ? doc.user_id : null;
}

async function storeBotLink(userId, botToken) {
  await db.collection(BOT_COLLECTION).updateOne(
    { user_id: userId },
    { $set: { user_id: userId, bot_token: botToken, created_at: new Date() } },
    { upsert: true }
  );
}

async function createSession(userId) {
  const sessionId = uuidv4();
  const expires = new Date(Date.now() + 86400 * 1000); // 1 day
  await db.collection(SESSION_COLLECTION).insertOne({
    session_id: sessionId,
    user_id: userId,
    expires
  });
  return sessionId;
}

async function getSessionUser(sessionId) {
  const doc = await db.collection(SESSION_COLLECTION).findOne({
    session_id: sessionId,
    expires: { $gt: new Date() }
  });
  return doc ? doc.user_id : null;
}

async function deleteSession(sessionId) {
  await db.collection(SESSION_COLLECTION).deleteOne({ session_id: sessionId });
}

// ============ टेलीग्राम API ============
async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  });
  return res.data;
}

async function sendTelegramVideo(token, chatId, buffer, caption) {
  const url = `https://api.telegram.org/bot${token}/sendVideo`;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('video', buffer, { filename: 'video.mp4', contentType: 'video/mp4' });
  if (caption) form.append('caption', caption);
  form.append('parse_mode', 'HTML');

  const res = await axios.post(url, form, {
    headers: form.getHeaders()
  });
  return res.data;
}

async function setWebhook(token, webhookUrl) {
  const url = `https://api.telegram.org/bot${token}/setWebhook`;
  const res = await axios.post(url, { url: webhookUrl });
  return res.data;
}

// ============ MAIN BOT WEBHOOK ============
app.post('/main', async (req, res) => {
  const update = req.body;
  const message = update.message;
  if (!message) return res.send('OK');

  const chatId = message.chat.id;
  const text = message.text || '';

  if (!global.convState) global.convState = new Map();
  const state = global.convState.get(chatId);

  if (text === '/add') {
    global.convState.set(chatId, { step: 'awaiting_token' });
    await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
      '🔧 Enter Your Bot Token Now'
    );
    return res.send('OK');
  }

  if (state && state.step === 'awaiting_token') {
    const botToken = text.trim();
    try {
      const me = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`);
      if (!me.data.ok) throw new Error('Invalid token');
      global.convState.set(chatId, { step: 'awaiting_userid', botToken });
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        `✅ Bot @${me.data.result.username} Connected Sucessfully\nEnter Your Userid (ex: 123456789)`
      );
    } catch (e) {
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId, '❌ Wrong Bot Token Try Again');
      global.convState.delete(chatId);
    }
    return res.send('OK');
  }

  if (state && state.step === 'awaiting_userid') {
    const userId = text.trim();
    if (!/^\d+$/.test(userId)) {
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId, '❌ User ID Accept Only digit');
      return res.send('OK');
    }

    const botToken = state.botToken;
    await storeBotLink(userId, botToken);

    const webhookUrl = `${BASE_URL}/webhook/${botToken}`;
    const set = await setWebhook(botToken, webhookUrl);

    if (set.ok) {
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        `✅ Bot Linked Sucessfully\nNow Go ${FRONTEND_URL} Go And Login With Your User id`
      );
    } else {
      await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
        `⚠️ bot linked but not connected to server: ${set.description}\nset manually ${webhookUrl}`
      );
    }

    global.convState.delete(chatId);
    return res.send('OK');
  }

  await sendTelegramMessage(MAIN_BOT_TOKEN, chatId,
    'Welcome /add use for connect bot'
  );
  res.send('OK');
});

// ============ LINKED BOT WEBHOOK ============
app.post('/webhook/:token', async (req, res) => {
  const { token } = req.params;
  const update = req.body;
  const message = update.message;
  if (!message) return res.send('OK');

  const userId = await getUserIdByToken(token);
  if (!userId) return res.send('OK');

  if (message.text === '/start') {
    await sendTelegramMessage(token, userId,
      '✅ Bot Started Sucessfully'
    );
  }
  res.send('OK');
});

// ============ API: लॉगिन ============
app.post('/api/login', express.urlencoded({ extended: false }), async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'User ID required' });

  const token = await getBotToken(user_id);
  if (!token) return res.status(401).json({ error: 'User not registered' });

  const sessionId = await createSession(user_id);
  res.cookie('session', sessionId, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400000 });
  res.json({ success: true });
});

// ============ API: अपलोड ============
app.post('/api/upload', upload.single('video'), async (req, res) => {
  const sessionId = req.cookies.session;
  if (!sessionId) return res.status(401).json({ error: 'Not logged in' });

  const userId = await getSessionUser(sessionId);
  if (!userId) return res.status(401).json({ error: 'Invalid session' });

  const botToken = await getBotToken(userId);
  if (!botToken) return res.status(400).json({ error: 'Bot not linked' });

  const videoFile = req.file;
  if (!videoFile) return res.status(400).json({ error: 'No video uploaded' });

  const caption = req.body.caption || '';

  try {
    const result = await sendTelegramVideo(botToken, userId, videoFile.buffer, caption);
    if (result.ok) {
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: result.description });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ API: लॉगआउट ============
app.post('/api/logout', async (req, res) => {
  const sessionId = req.cookies.session;
  if (sessionId) await deleteSession(sessionId);
  res.clearCookie('session');
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
