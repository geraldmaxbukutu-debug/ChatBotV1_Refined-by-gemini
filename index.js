// index.js// index.js
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI: GoogleGenAI } = require("@google/generative-ai");
require("dotenv").config();
const login = require("@dongdev/fca-unofficial");
const async = require('async');
const express = require('express'); // Added Express

let config;
try {
    const configData = fs.readFileSync('./config.json', 'utf8');
    config = JSON.parse(configData);
    console.log("Configuration loaded successfully.");
} catch (e) {
    console.error("FATAL ERROR: Could not load or parse config.json. Please check the file path and syntax.", e);
    process.exit(1);
}

const {
    GEMINI_API_KEY,
    FACEBOOK_APPSTATE_PATH,
    MODEL_NAME,
    BOT_NAME,
    SYSTEM_PROMPT,
    REACTIONS,
    RISK_MITIGATION,
    PROBABILITIES,
    PERSISTENCE,
    SERVER // Added SERVER config access
} = config;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const chatSessions = {};
let persistedHistory = {};

function loadHistory() {
    if (PERSISTENCE.ENABLED && fs.existsSync(PERSISTENCE.HISTORY_FILE_PATH)) {
        try {
            const data = fs.readFileSync(PERSISTENCE.HISTORY_FILE_PATH, 'utf8');
            persistedHistory = JSON.parse(data);
            console.log("Chat history loaded from file.");
        } catch (err) {
            console.error("Error loading chat history, starting fresh:", err);
            persistedHistory = {};
        }
    }
}

function saveHistory() {
    if (PERSISTENCE.ENABLED) {
        try {
            fs.writeFileSync(PERSISTENCE.HISTORY_FILE_PATH, JSON.stringify(persistedHistory, null, 2));
        } catch (err) {
            console.error("Error saving chat history:", err);
        }
    }
}

async function getChatSession(threadID) {
    if (!chatSessions[threadID]) {
        const model = ai.getGenerativeModel({ model: MODEL_NAME });
        const chat = model.startChat({
            history: persistedHistory[threadID] || [],
            generationConfig: { maxOutputTokens: 1000 }
        });
        chatSessions[threadID] = chat;
    }
    return chatSessions[threadID];
}

async function shouldBotReply(messageContent, threadID) {
    try {
        const filterPrompt = `${SYSTEM_PROMPT}\n\nHuman Message:\n${messageContent}\n\nShould the AI reply directly (Yes/No)?`;
        const filterModel = ai.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const filterResult = await filterModel.generateContent(filterPrompt);
        const filterText = (await filterResult.response.text()).trim().toLowerCase();
        return filterText.includes("yes");
    } catch (error) {
        console.error(`[Reasoning Error] Thread ${threadID}:`, error);
        return false;
    }
}

function getReplyAction() {
    const rand = Math.random();
    if (rand < PROBABILITIES.REPLY) return 'MESSAGE';
    if (rand < PROBABILITIES.REPLY + PROBABILITIES.REACT) return 'REACTION';
    return 'IGNORE';
}

function sendTaggedMessage(api, message, threadID, senderID, senderName) {
    const tagMessage = {
        body: message,
        mentions: [{ tag: `@${senderName}`, id: senderID }]
    };
    api.sendMessage(tagMessage, threadID, (err, msgInfo) => {
        if (err) {
            console.error(`[Error] Failed to send tagged message in thread ${threadID}:`, err);
        } else {
            console.log(`[Bot Reply] Sent TAGGED message (ID: ${msgInfo?.messageID}) to ${senderName} in thread ${threadID}.`);
        }
    });
}

const threadQueues = new Map();

function getThreadQueue(threadID) {
    if (!threadQueues.has(threadID)) {
        const q = async.queue(async function(event, callback) {
            try {
                 await processMessage(api, event);
            } catch (error) {
                console.error(`[Queue Worker Error - Thread ${threadID}]:`, error);
            } finally {
                 callback();
            }
        }, 1);
        threadQueues.set(threadID, q);
        console.log(`[Queue Manager] Created new queue for thread ${threadID}.`);
    }
    return threadQueues.get(threadID);
}

async function processMessage(api, event) {
    if (event.type === "message" && event.senderID !== api.getCurrentUserID()) {
        const userMessage = event.body;
        const threadID = event.threadID;
        const messageID = event.messageID;
        const senderID = event.senderID;
        const senderName = event.senderName || 'Friend';

        console.log(`[Processing] New message in thread ${threadID} from ${senderID}. Queue length: ${getThreadQueue(threadID).length() + (getThreadQueue(threadID).running() ? 1 : 0) }`);

        if (userMessage.toLowerCase() === '!history reset' && threadID === senderID) {
            if (chatSessions[threadID]) {
                delete chatSessions[threadID];
                delete persistedHistory[threadID];
                saveHistory();
                api.sendMessage("Memory for this chat wiped. Starting fresh! ✨", threadID);
                console.log(`[Admin] Chat history for ${threadID} reset and saved.`);
            } else {
                api.sendMessage("Memory already clear, chief. You're good to go!", threadID);
            }
            return;
        }

        const chat = await getChatSession(threadID);

        let attachmentDescription = "";
        let fullUserMessage = userMessage || "";
        const hasAttachment = event.attachments && event.attachments.length > 0;

        if (hasAttachment) {
            const attachment = event.attachments[0];
            switch (attachment.type) {
                case "photo":
                case "video":
                    const caption = attachment.caption ? ` with the caption: "${attachment.caption}"` : "";
                    attachmentDescription = ` (The user also sent a ${attachment.type}${caption}. Respond to the media naturally.)`;
                    break;
                case "file":
                case "audio":
                    attachmentDescription = ` (The user sent a voice clip or file named: ${attachment.name}. Acknowledge it.)`;
                    break;
                case "sticker":
                    attachmentDescription = ` (The user sent a sticker. React to the sticker's mood, which is generally fun/casual.)`;
                    if (!fullUserMessage) fullUserMessage = "They sent a sticker.";
                    break;
                case "share":
                    attachmentDescription = ` (The user shared a link titled: ${attachment.title || 'Link'}. Address the link briefly.)`;
                    break;
                default:
                    attachmentDescription = " (The user sent an unrecognized media attachment.)";
            }
            console.log(`[Attachment] Detected type: ${attachment.type}`);
        }

        let shouldProceed = false;
        const reasoningMessage = fullUserMessage + (hasAttachment ? attachmentDescription : "");

        try {
            const isExplicitlyAddressed = fullUserMessage.toLowerCase().includes(BOT_NAME);
            if (isExplicitlyAddressed || hasAttachment) {
                shouldProceed = true;
            } else {
                shouldProceed = await shouldBotReply(reasoningMessage, threadID);
            }
        } catch (e) {
            console.error("Reasoning Filter Error:", e);
            shouldProceed = false;
        }

        if (shouldProceed) {
            const reactionDelay = RISK_MITIGATION.BASE_REACTION_DELAY_MS + Math.random() * RISK_MITIGATION.MAX_JITTER_DELAY_MS;
            await new Promise(r => setTimeout(r, reactionDelay));

            const action = getReplyAction();

            if (action === 'REACTION') {
                const randomReaction = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
                try {
                    api.setMessageReaction(randomReaction, messageID, false, (e) => {
                        if (e) console.error("Error setting reaction:", e);
                        else console.log(`[Bot Action] Reacted with ${randomReaction} to message ${messageID} in thread ${threadID}.`);
                    });
                    await chat.sendMessage({ message: fullUserMessage + attachmentDescription });
                    persistedHistory[threadID] = await chat.getHistory();
                    saveHistory();
                } catch (e) { console.error("Reaction failed:", e); }
                return;
            }

            if (action === 'MESSAGE') {
                const messageToSendToAI = (fullUserMessage || "The user sent media.") + attachmentDescription;

                try {
                    const typingStartDelay = Math.random() * 1000;
                    const typingPromise = new Promise(async (resolve) => {
                        await new Promise(r => setTimeout(r, typingStartDelay));
                        api.sendTypingIndicator(threadID, (e) => { if (e) console.error(e); });
                        resolve();
                    });

                    const aiCallPromise = chat.sendMessage({ message: messageToSendToAI });
                    const [_, response] = await Promise.all([typingPromise, aiCallPromise]);
                    const aiReply = response.text.trim();

                    const typingTime = aiReply.length * RISK_MITIGATION.TYPING_SPEED_PER_CHAR_MS + Math.random() * (aiReply.length * RISK_MITIGATION.MAX_TYPING_FLUCTUATION_MS);
                    await new Promise(r => setTimeout(r, typingTime));

                    const shouldTag = Math.random() < 0.1 || threadID !== senderID;

                    if (shouldTag) {
                        sendTaggedMessage(api, aiReply, threadID, senderID, senderName);
                        console.log(`[Bot Reply] Sent and TAGGED ${senderName} in thread ${threadID}. AI Reply: ${aiReply.substring(0, 50)}...`);
                    } else {
                        api.sendMessage(aiReply, threadID, (err, msgInfo) => {
                             if (err) {
                                console.error(`[Error] Failed to send message in thread ${threadID}:`, err);
                             } else {
                                console.log(`[Bot Reply] Sent standard message (ID: ${msgInfo?.messageID}) in thread ${threadID}. AI Reply: ${aiReply.substring(0, 50)}...`);
                             }
                        });
                    }

                    persistedHistory[threadID] = await chat.getHistory();
                    saveHistory();

                } catch (aiError) {
                    console.error("Gemini API Error:", aiError);
                    api.sendMessage("Ugh, my internet is glitching rn. Totes can't connect!", threadID);
                }
            }

            if (action === 'IGNORE') {
                console.log(`[Bot Action] Ignored message in thread ${threadID} (Simulating human pause/disinterest).`);
                await chat.sendMessage({ message: fullUserMessage + attachmentDescription });
                persistedHistory[threadID] = await chat.getHistory();
                saveHistory();
            }

        } else {
            console.log(`[Ignored] Message in thread ${threadID} not about ${BOT_NAME} or direct, skipping.`);
        }
        console.log(`[Processing Done] Finished message in thread ${threadID}. Queue length: ${getThreadQueue(threadID).length()}`);
    }
}

loadHistory();

let appState;
try {
    appState = JSON.parse(fs.readFileSync(FACEBOOK_APPSTATE_PATH, 'utf8'));
} catch (e) {
    console.error("Could not load appstate.json. Ensure file exists at:", FACEBOOK_APPSTATE_PATH);
    process.exit(1);
}

login({ appState: appState }, (err, api) => {
    if (err) return console.error("Facebook Login Failed:", err);

    api.setOptions({ listenEvents: true, selfListen: false, online: true });
    console.log(`Facebook Bot (${MODEL_NAME}) is online and configured as '${BOT_NAME}'.`);

    // --- START EXPRESS SERVER TO USE CONFIGURED PORT ---
    const app = express();
    const configuredPort = SERVER.PORT || 3000; // Default to 3000 if not set

    app.get('/', (req, res) => {
        res.send(`Facebook Bot (${MODEL_NAME}) is active on port ${configuredPort}.`);
    });

    app.listen(configuredPort, () => {
        console.log(`[Server] Listening on port ${configuredPort}. This port is reserved for the application.`);
    });
    // --- END EXPRESS SERVER ---

    api.listenMqtt(async (err, event) => {
        if (err) return console.error("Listen Error:", err);

        if (event.type === "message") {
             const threadID = event.threadID;
             const queue = getThreadQueue(threadID);
             queue.push(event, (err) => {
                 if(err) {
                     console.error(`[Queue Error - Push] Thread ${threadID}:`, err);
                 }
             });
             console.log(`[Queued] Message from ${event.senderID} added to queue for thread ${threadID}. Queue length: ${queue.length()}`);
        } else {
            console.log(`[Event] Non-message event '${event.type}' received in thread ${event.threadID || 'N/A'}.`);
        }
    });
});


