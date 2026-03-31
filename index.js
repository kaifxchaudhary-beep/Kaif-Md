/**
 * ⚡ KAIF MD AUTOFORWARD BOT ⚡
 * Main Entry Point
 * Developed by Mr Wasi (ixxwasi)
 */
require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase, wasi_getGroupSettings, wasi_isDbConnected } = require('./wasilib/database');
const config = require('./wasi');
const qrcode = require('qrcode');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// PLUGIN LOADER (Only 4 specific commands)
// -----------------------------------------------------------------------------
const wasi_plugins = new Map();

function wasi_loadPlugins() {
    const pluginDir = path.join(__dirname, 'wasiplugins');
    if (!fs.existsSync(pluginDir)) return;

    // We only want these specific filenames/commands as per user request
    const requested = ['autoforward.js', 'forward.js', 'gjids.js', 'jid.js', 'uptime.js', 'ping.js', 'menu.js'];
    
    for (const file of requested) {
        const filePath = path.join(pluginDir, file);
        if (fs.existsSync(filePath)) {
            try {
                const plugin = require(`./wasiplugins/${file}`);
                if (plugin.name) {
                    const name = plugin.name.toLowerCase();
                    wasi_plugins.set(name, plugin);
                    if (plugin.aliases && Array.isArray(plugin.aliases)) {
                        plugin.aliases.forEach(alias => wasi_plugins.set(alias.toLowerCase(), plugin));
                    }
                }
            } catch (e) {
                console.error(`Failed to load plugin ${file}:`, e.message);
            }
        }
    }
    console.log(`✅ Loaded ${wasi_plugins.size} core commands.`);
}

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
      }).filter(regex => regex !== null)
    : [];

const NEW_TEXT = process.env.NEW_TEXT
    ? process.env.NEW_TEXT
    : '';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

/**
 * Clean forwarded label from message
 */
function cleanForwardedLabel(message) {
    try {
        // Clone the message to avoid modifying original
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        // Remove forwarded flag from different message types
        if (cleanedMessage.extendedTextMessage?.contextInfo) {
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            // Also remove forwarding news if present
            if (cleanedMessage.extendedTextMessage.contextInfo.forwardingScore) {
                cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.imageMessage?.contextInfo) {
            cleanedMessage.imageMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.imageMessage.contextInfo.forwardingScore) {
                cleanedMessage.imageMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.videoMessage?.contextInfo) {
            cleanedMessage.videoMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.videoMessage.contextInfo.forwardingScore) {
                cleanedMessage.videoMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.audioMessage?.contextInfo) {
            cleanedMessage.audioMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.audioMessage.contextInfo.forwardingScore) {
                cleanedMessage.audioMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.documentMessage?.contextInfo) {
            cleanedMessage.documentMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.documentMessage.contextInfo.forwardingScore) {
                cleanedMessage.documentMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        // Remove newsletter/broadcast specific markers
        if (cleanedMessage.protocolMessage) {
            // For newsletter messages, we extract the actual message content
            if (cleanedMessage.protocolMessage.type === 14 || 
                cleanedMessage.protocolMessage.type === 26) {
                // These are typically newsletter/broadcast messages
                // We'll try to extract the actual message if possible
                if (cleanedMessage.protocolMessage.historySyncNotification) {
                    // Extract from history sync
                    const syncData = cleanedMessage.protocolMessage.historySyncNotification;
                    if (syncData.pushName) {
                        // Use pushName as sender info
                        console.log('Newsletter from:', syncData.pushName);
                    }
                }
            }
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

/**
 * Clean newsletter/information markers from text
 */
function cleanNewsletterText(text) {
    if (!text) return text;
    
    // Remove common newsletter markers
    const newsletterMarkers = [
        /📢\s*/g,
        /🔔\s*/g,
        /📰\s*/g,
        /🗞️\s*/g,
        /\[NEWSLETTER\]/gi,
        /\[BROADCAST\]/gi,
        /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi,
        /Broadcast:/gi,
        /Announcement:/gi,
        /Forwarded many times/gi,
        /Forwarded message/gi,
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    // Trim extra whitespace
    cleanedText = cleanedText.trim();
    
    return cleanedText;
}

/**
 * Replace caption text using regex patterns
 */
function replaceCaption(caption) {
    if (!caption) return caption;
    
    // اگر OLD_TEXT_REGEX یا NEW_TEXT خالی ہوں تو کچھ نہیں کریں گے
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    
    return result;
}

/**
 * Process and clean a message completely
 */
function processAndCleanMessage(originalMessage) {
    try {
        // Step 1: Clone the message
        let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));
        
        // Step 2: Remove forwarded labels
        cleanedMessage = cleanForwardedLabel(cleanedMessage);
        
        // Step 3: Extract text and clean newsletter markers
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text) {
            const cleanedText = cleanNewsletterText(text);
            
            // Update the cleaned text in appropriate field
            if (cleanedMessage.conversation) {
                cleanedMessage.conversation = cleanedText;
            } else if (cleanedMessage.extendedTextMessage?.text) {
                cleanedMessage.extendedTextMessage.text = cleanedText;
            } else if (cleanedMessage.imageMessage?.caption) {
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText);
            }
        }
        
        // Step 4: Remove protocol messages (newsletter metadata)
        delete cleanedMessage.protocolMessage;
        
        // Step 5: Remove newsletter sender info
        if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) {
            const participant = cleanedMessage.extendedTextMessage.contextInfo.participant;
            if (participant.includes('newsletter') || participant.includes('broadcast')) {
                delete cleanedMessage.extendedTextMessage.contextInfo.participant;
                delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId;
                delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid;
            }
        }
        
        // Step 6: Ensure message appears as original (not forwarded)
        if (cleanedMessage.extendedTextMessage) {
            cleanedMessage.extendedTextMessage.contextInfo = cleanedMessage.extendedTextMessage.contextInfo || {};
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }

// -----------------------------------------------------------------------------
// TEXT REPLACEMENT & CLEANING CONFIG
// -----------------------------------------------------------------------------
const { processAndCleanMessage } = require('./wasilib/cleaner');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// Dashboard APIs
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);
    res.json({
        connected: session?.isConnected || false,
        qr: session?.qr || null,
        dbConnected: wasi_isDbConnected()
    });
});

wasi_app.get('/api/config', (req, res) => {
    // Return minimal config for the dashboard (mostly placeholder for now as per user request to streamline)
    res.json({
        sourceJids: [],
        targetJids: [],
        oldTextRegex: [],
        newText: ""
    });
});

wasi_app.post('/api/config', (req, res) => {
    // Stub for saving - for a streamlined bot, user usually manages via .env or commands
    res.json({ success: true });
});

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) return;
        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);
    const sessionState = { sock: null, isConnected: false };
    sessions.set(sessionId, sessionState);

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;

    // Register listeners immediately to avoid missing events
    console.log(`📡 [${sessionId}] Socket created, listening for events...`);

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                sessionState.qr = await qrcode.toDataURL(qr);
            } catch (e) {
                console.error('Failed to generate QR:', e.message);
            }
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            sessionState.qr = null;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            console.log(`Session ${sessionId}: Connection closed, reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // MESSAGE HANDLER
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_sender = jidNormalizedUser(wasi_msg.key.participant || wasi_origin);
        
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";
        
        // 1. AUTO FORWARD LOGIC (Background)
        if (wasi_origin.endsWith('@g.us') && !wasi_msg.key.fromMe) {
            try {
                const groupSettings = await wasi_getGroupSettings(sessionId, wasi_origin);
                if (groupSettings && groupSettings.autoForward && groupSettings.autoForwardTargets?.length > 0) {
                    let relayMsg = processAndCleanMessage(wasi_msg.message);
                    
                    // Unwrap View Once
                    if (relayMsg.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                    if (relayMsg.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;

                    for (const targetJid of groupSettings.autoForwardTargets) {
                        try {
                            await wasi_sock.relayMessage(targetJid, relayMsg, {
                                messageId: wasi_sock.generateMessageTag()
                            });
                        } catch (err) {
                            console.error(`[AUTO-FORWARD] Failed for ${targetJid}:`, err.message);
                        }
                    }
                }
            } catch (err) { }
        }

        // 2. COMMAND HANDLER
        const prefix = '.'; 
        if (wasi_text.trim().startsWith(prefix)) {
            const wasi_parts = wasi_text.trim().slice(prefix.length).trim().split(/\s+/);
            const wasi_cmd_input = wasi_parts[0].toLowerCase();
            const wasi_args = wasi_parts.slice(1);

            if (wasi_plugins.has(wasi_cmd_input)) {
                const plugin = wasi_plugins.get(wasi_cmd_input);
                try {
                    // Minimal Context
                    const isGroup = wasi_origin.endsWith('@g.us');
                    let wasi_isAdmin = false;
                    if (isGroup) {
                        try {
                            const groupMetadata = await wasi_sock.groupMetadata(wasi_origin);
                            const senderMod = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === wasi_sender);
                            wasi_isAdmin = (senderMod?.admin === 'admin' || senderMod?.admin === 'superadmin');
                        } catch (e) { }
                    }

                    // For simplicity, we define isOwner as true if it's the bot itself or listed in config
                    const ownerNum = (config.ownerNumber || '').replace(/\D/g, '');
                    const isOwner = wasi_msg.key.fromMe || (ownerNum && wasi_sender.includes(ownerNum));

                    await plugin.wasi_handler(wasi_sock, wasi_origin, {
                        wasi_sender,
                        wasi_msg,
                        wasi_args,
                        sessionId,
                        wasi_text,
                        wasi_isGroup: isGroup,
                        wasi_isAdmin,
                        wasi_isOwner: isOwner,
                        wasi_isSudo: isOwner,
                        wasi_plugins
                    });
                } catch (err) {
                    console.error(`Error in plugin ${wasi_cmd_input}:`, err.message);
                }
            }
        }
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // 1. Start Dashboard Server IMMEDIATELY (Prevents Heroku timeout)
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Dashboard running on port ${wasi_port}`);
    });

    // 2. Load Core Commands
    wasi_loadPlugins();

    // 3. Initialize Bot in Background
    (async () => {
        try {
            // Connect Database
            if (config.mongoDbUrl) {
                const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
                if (dbResult) console.log('✅ Database connected');
            }

            // Start default session
            const sessionId = config.sessionId || 'wasi_session';
            await startSession(sessionId);
        } catch (err) {
            console.error('❌ Initialization Error:', err);
        }
    })();
}

main();
