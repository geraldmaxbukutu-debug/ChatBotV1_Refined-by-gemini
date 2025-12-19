
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const async = require("async");
const express = require("express");
const dotenv = require("dotenv");
const {
  default: createFcaApi,
  getThreadIDFromMessage,
} = require("@dongdev/fca-unofficial");

dotenv.config();

// --- Configuration ---
const configPath = path.join(__dirname, "config.json");
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  console.error("Error reading config.json:", err.message);
  process.exit(1);
}

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const historyFilePath = path.join(dataDir, "history.json");
let threadHistory = {};
if (fs.existsSync(historyFilePath)) {
  try {
    threadHistory = JSON.parse(fs.readFileSync(historyFilePath, "utf8"));
  } catch (err) {
    console.error("Error parsing history.json, starting fresh:", err.message);
  }
}
const saveHistory = () =>
  fs.writeFileSync(historyFilePath, JSON.stringify(threadHistory, null, 2));

// --- Gemini Setup ---
const ai = new GoogleGenAI({ apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY });
const generationConfig = {
  temperature: 0.9,
  topK: 1,
  topP: 1,
  maxOutputTokens: 1024,
  responseMimeType: "text/plain",
};

// --- FCA API & Queues ---
let fcaApi;
const threadQueues = new Map();

const getRandomDelay = () => Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;

const createThreadQueue = (threadID) => {
  const queue = async.queue(async (task, callback) => {
    try {
      await processMessageWithGemini(task);
    } catch (err) {
      console.error(
        `Error processing message in thread ${task.threadID}:`,
        err.message
      );
    } finally {
      setTimeout(callback, getRandomDelay());
    }
  }, 1);
  return queue;
};

// --- Core Logic ---
async function processMessageWithGemini(task) {
  const { senderID, threadID, messageID, body, attachments = [] } = task;
  const isAdmin = config.ADMIN_UIDS.includes(senderID);

  // Admin command: !history reset
  if (isAdmin && body.trim() === "!history reset") {
    delete threadHistory[threadID];
    saveHistory();
    console.log(`History reset for thread ${threadID} by admin ${senderID}.`);
    return;
  }

  // Probability to act
  if (Math.random() > config.RESPONSE_PROBABILITY) return;

  const queue = threadQueues.get(threadID) || createThreadQueue(threadID);
  if (!threadQueues.has(threadID)) threadQueues.set(threadID, queue);

  const historyKey = `${threadID}`;
  if (!threadHistory[historyKey]) threadHistory[historyKey] = [];

  const history = threadHistory[historyKey];
  const userInput = body || "User sent an attachment.";

  // Prepare prompt for filtering
  const filterPrompt = `Thread Name: ${threadID}\nUser Message: ${userInput}\nShould the bot respond, react, or ignore? Respond with only one word: "MESSAGE", "REACTION", or "IGNORE".`;

  try {
    const filterResponse = await ai.models.generateContent({
      model: "gemini-1.5-flash-latest",
      contents: [{ role: "user", parts: [{ text: filterPrompt }] }],
      generationConfig: { ...generationConfig, maxOutputTokens: 10 },
    });

    const action = (filterResponse.text?.trim().toUpperCase() || "IGNORE").replace(/[^\w]/g, "");
    console.log(`Filter Decision for thread ${threadID}: ${action}`);

    if (action === "IGNORE") return;

    if (action === "REACTION") {
      const reactions = ["👍", "❤️", "😂", "😮", "😢", "😡"];
      const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];
      await fcaApi.setMessageReaction(randomReaction, messageID);
      return;
    }

    if (action === "MESSAGE") {
      history.push({ role: "user", parts: [{ text: userInput }] });
      if (history.length > config.CONTEXT_WINDOW * 2) history.splice(0, 2);

      // Ensure history alternates correctly before sending
      if (history.length > 1 && history[history.length - 1].role === "user" && history[history.length - 2].role === "user") {
        history.splice(history.length - 2, 0, { role: "model", parts: [{ text: "..." }] });
      }
      if (history.length > 1 && history[history.length - 1].role === "model" && history[history.length - 2].role === "model") {
         // This is a less ideal fix, but we prepend a dummy user message if two models are back-to-back.
         // A better system would track actual exchanges.
         history.splice(history.length - 1, 0, { role: "user", parts: [{ text: "..." }] });
      }

      const geminiResponse = await ai.models.generateContent({
        model: config.GEMINI_MODEL_NAME,
        contents: history,
        generationConfig,
      });

      const geminiText = geminiResponse.text;
      if (geminiText) {
        history.push({ role: "model", parts: [{ text: geminiText }] });
        saveHistory();
        await fcaApi.sendMessage(geminiText, threadID);
      }
    }
  } catch (error) {
    console.error("Gemini processing error:", error.message);
    if (error.message && error.message.toLowerCase().includes("block")) {
       // If blocked, ensure next interaction starts fresh
       delete threadHistory[historyKey];
       saveHistory();
    }
  }
}

async function main() {
  fcaApi = await createFcaApi({
    appState: JSON.parse(fs.readFileSync(path.join(__dirname, "appstate.json"))),
    listenEvents: config.LISTEN_EVENTS,
    selfListen: config.SELF_LISTEN,
    forceLogin: config.FORCE_LOGIN,
  });

  fcaApi.listenMqtt(async (err, event) => {
    if (err) return console.error("FCA API Error:", err);

    if (event.type === "message" || event.type === "message_reply") {
      const threadID = getThreadIDFromMessage(event);
      if (!threadID) return;

      const task = {
        senderID: event.senderID,
        threadID,
        messageID: event.messageID,
        body: event.body,
        attachments: event.attachments,
      };

      const queue = threadQueues.get(threadID) || createThreadQueue(threadID);
      if (!threadQueues.has(threadID)) threadQueues.set(threadID, queue);
      queue.push(task);
    }
  });

  const app = express();
  const PORT = config.SERVER?.PORT || 3000;
  app.get("/", (_, res) => res.send("Bot is running..."));
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

main().catch(console.error);
