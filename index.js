const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');
const { login } = require('ws3-fca'); 

dotenv.config();

// --- Configuration Loading ---
let config;
try {
    const configData = fs.readFileSync('./config.json', 'utf8');
    config = JSON.parse(configData);
    console.log("Configuration loaded successfully.");
} catch (e) {
    console.error("FATAL ERROR: Could not load or parse config.json. Please check the file path and syntax.", e);
    process.exit(1);
}

// Map config properties for cleaner access
const { 
    GEMINI_API_KEY, 
    FACEBOOK_APPSTATE_PATH, 
    MODEL_NAME, 
    BOT_NAME, 
    SYSTEM_PROMPT, 
    REACTIONS, 
    RISK_MITIGATION, 
    PROBABILITIES,
    PERSISTENCE 
} = config;

// Initialize the Gemini Client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY }); 

// Stores live chat sessions (Gemini objects)
const chatSessions = {}; 
// Stores raw chat history for persistence (key: threadID, value: Gemini history array)
let persistedHistory = {}; 


// ====================================================================
// === CORE BOT LOGIC FUNCTIONS =======================================
// ====================================================================

// --- PERSISTENCE FUNCTIONS ---
function loadHistory() {
    try {
        if (fs.existsSync(PERSISTENCE.HISTORY_FILE)) {
            const data = fs.readFileSync(PERSISTENCE.HISTORY_FILE, 'utf8');
            persistedHistory = JSON.parse(data);
            console.log(`Successfully loaded ${Object.keys(persistedHistory).length} threads from history file.`);
        } else {
            console.log("No history file found. Starting fresh.");
        }
    } catch (e) {
        console.error("Error loading history:", e);
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(PERSISTENCE.HISTORY_FILE, JSON.stringify(persistedHistory, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving history:", e);
    }
}

// --- GEMINI CHAT MANAGEMENT FUNCTION ---
async function getChatSession(threadID) {
    if (!chatSessions[threadID]) {
        const history = persistedHistory[threadID] || [];
        const chat = ai.chats.create({
            model: MODEL_NAME,
            config: { systemInstruction: SYSTEM_PROMPT },
            history: history
        });
        chatSessions[threadID] = chat;
    }
    return chatSessions[threadID];
}


// --- REASONING AND DECISION FUNCTIONS ---

// Smart Filter: Uses Gemini to determine if a message warrants a reply
async function shouldBotReply(message, threadID) {
    const chat = await getChatSession(threadID);
    const context = await chat.getHistory();
    const lastFewMessages = context.slice(-3).map(m => m.parts[0].text).join('\n');
    
    // Create a temporary chat for a quick decision
    const decisionChat = ai.chats.create({
        model: MODEL_NAME,
        config: {
            systemInstruction: `You are a conversational filter for a human named '${BOT_NAME}'. 
            Analyze the following message and the recent chat history (if available). 
            If the message is a direct question, a comment clearly about '${BOT_NAME}', or a natural follow-up to a previous reply by '${BOT_NAME}', respond with ONLY the word "YES". 
            Otherwise, respond with ONLY the word "NO". DO NOT add any other text or explanation.`,
        }
    });

    const prompt = `Recent context:\n---\n${lastFewMessages}\n---\nNew message to check: "${message}"`;
    const response = await decisionChat.sendMessage({ message: prompt });
    
    return response.text.trim().toUpperCase().includes('YES');
}

// Randomly determines if the bot should MESSAGE, REACT, or IGNORE
function getReplyAction() {
    const r = Math.random();
    let cumulative = 0;
    
    cumulative += PROBABILITIES.MESSAGE;
    if (r < cumulative) return 'MESSAGE';
    
    cumulative += PROBABILITIES.REACTION;
    if (r < cumulative) return 'REACTION';

    return 'IGNORE';
}

// --- MESSAGE SENDING FUNCTIONS ---

// Handles message sending and includes user tagging logic
function sendTaggedMessage(api, message, threadID, tagUserID = null, tagUserName = 'User') {
    let msg = {
        body: message,
        mentions: []
    };

    if (tagUserID) {
        // Tag needs to be placed in the body
        const tagText = `@${tagUserName}`;
        msg.body = `${tagText} ${message}`;
        
        msg.mentions.push({
            tag: tagText,
            id: tagUserID,
            fromIndex: 0 // Tag starts at the beginning
        });
    }

    api.sendMessage(msg, threadID, (err) => {
        if (err) console.error("Error sending message:", err);
    });
}


// ====================================================================
// === MAIN EXECUTION BLOCK ===========================================
// ====================================================================

// --- INITIALIZATION ---
loadHistory();

let appState;
try {
    appState = JSON.parse(fs.readFileSync(FACEBOOK_APPSTATE_PATH, 'utf8'));
} catch (e) {
    console.error("Could not load appstate.json. Ensure file exists at:", FACEBOOK_APPSTATE_PATH);
    process.exit(1);
}


// 2. Main Login and Listener
login({ appState: appState }, (err, api) => {
    if (err) return console.error("Facebook Login Failed:", err);

    api.setOptions({ listenEvents: true, selfListen: false, online: true }); 
    console.log(`Facebook Bot (${MODEL_NAME}) is online and configured as '${BOT_NAME}'.`);

    api.listenMqtt(async (err, event) => {
        if (err) return console.error("Listen Error:", err);

        if (event.type === "message" && event.senderID !== api.getCurrentUserID()) {
            const userMessage = event.body;
            const threadID = event.threadID;
            const messageID = event.messageID; 
            const senderID = event.senderID;
            const senderName = event.senderName || 'Friend';

            // --- ADMIN COMMAND CHECK ---
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
            // --- END ADMIN COMMAND CHECK ---

            // 1. Get/Initialize Chat Session 
            const chat = await getChatSession(threadID);

            // --- ATTACHMENT PROCESSING ---
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

            // --- STEP 2: REASONING FILTER ---
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
                
                // 3. Start Human Reaction Delay
                const reactionDelay = RISK_MITIGATION.BASE_REACTION_DELAY_MS + Math.random() * RISK_MITIGATION.MAX_JITTER_DELAY_MS;
                await new Promise(r => setTimeout(r, reactionDelay));
                
                const action = getReplyAction(); 
                
                // --- EXECUTE ACTION ---
                
                if (action === 'REACTION') {
                    const randomReaction = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
                    
                    try {
                        api.setMessageReaction(randomReaction, messageID, false, (e) => {
                            if (e) console.error("Error setting reaction:", e);
                        });
                        // Update persistence: Log user message and bot action
                        await chat.sendMessage({ message: fullUserMessage + attachmentDescription });
                        persistedHistory[threadID] = await chat.getHistory();
                        saveHistory();
                        console.log(`[Bot Action] Reacted with ${randomReaction}`);
                    } catch (e) { console.error("Reaction failed:", e); }
                    return; 
                }
                
                if (action === 'MESSAGE') {
                    const messageToSendToAI = (fullUserMessage || "The user sent media.") + attachmentDescription;
                    
                    try {
                        // Smart Typing Indicator
                        const typingStartDelay = Math.random() * 1000; 
                        const typingPromise = new Promise(async (resolve) => {
                            await new Promise(r => setTimeout(r, typingStartDelay));
                            api.sendTypingIndicator(threadID, (e) => { if (e) console.error(e); });
                            resolve();
                        });
                        
                        const aiCallPromise = chat.sendMessage({ message: messageToSendToAI });
                        const [_, response] = await Promise.all([typingPromise, aiCallPromise]); 
                        const aiReply = response.text.trim();

                        // Final Typing Delay
                        const typingTime = aiReply.length * RISK_MITIGATION.TYPING_SPEED_PER_CHAR_MS + Math.random() * (aiReply.length * RISK_MITIGATION.MAX_TYPING_FLUCTUATION_MS);
                        await new Promise(r => setTimeout(r, typingTime));
                        
                        // Tagging Logic: 10% chance OR if in a group chat
                        const shouldTag = Math.random() < 0.1 || threadID !== senderID;
                        
                        if (shouldTag) {
                            sendTaggedMessage(api, aiReply, threadID, senderID, senderName);
                            console.log(`[Bot Reply] Sent and TAGGED ${senderName}.`);
                        } else {
                            api.sendMessage(aiReply, threadID);
                            console.log(`[Bot Reply] Sent standard message.`);
                        }

                        // Update persistence
                        persistedHistory[threadID] = await chat.getHistory();
                        saveHistory();

                    } catch (aiError) {
                        console.error("Gemini API Error:", aiError);
                        api.sendMessage("Ugh, my internet is glitching rn. Totes can't connect!", threadID);
                    }
                }

                if (action === 'IGNORE') {
                    console.log(`[Bot Action] Ignored message (Simulating human pause/disinterest).`);
                    // Update persistence: Log full context to history
                    await chat.sendMessage({ message: fullUserMessage + attachmentDescription });
                    persistedHistory[threadID] = await chat.getHistory();
                    saveHistory();
                }

            } else {
                console.log(`[Ignored] Message not about ${BOT_NAME} or direct, skipping.`);
            }
        }
    });
});


