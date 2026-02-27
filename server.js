const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const axios = require("axios");
const User = require("./models/User");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "uploads/" });

mongoose.connect(process.env.MONGO_URI);

const MANAGER_TOKEN = process.env.MANAGER_TOKEN;

// TELEGRAM WEBHOOK
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.send("ok");

  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "/add") {
    await sendMessage(chatId, "Send your Bot Token:");
    global.temp = { step: "token", chatId };
  }
  else if (global.temp?.step === "token") {
    global.temp.token = text;
    global.temp.step = "userid";
    await sendMessage(chatId, "Send your USERID:");
  }
  else if (global.temp?.step === "userid") {
    await User.create({
      userid: text,
      token: global.temp.token,
      chatId: chatId
    });

    await sendMessage(chatId, "✅ Bot Linked Successfully");
    global.temp = null;
  }

  res.send("ok");
});

// Upload API (Vercel call karega)
app.post("/upload", upload.single("video"), async (req, res) => {

  const { userid, caption } = req.body;

  const user = await User.findOne({ userid });
  if (!user) return res.json({ error: "Invalid USERID" });

  const formData = new FormData();
  formData.append("chat_id", user.chatId);
  formData.append("caption", caption);
  formData.append("video", require("fs").createReadStream(req.file.path));

  await axios.post(
    `https://api.telegram.org/bot${user.token}/sendVideo`,
    formData,
    { headers: formData.getHeaders() }
  );

  res.json({ success: "Upload Done Successfully" });
});

async function sendMessage(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${MANAGER_TOKEN}/sendMessage`,
    { chat_id: chatId, text }
  );
}

app.listen(3000, () => console.log("Server running"));
