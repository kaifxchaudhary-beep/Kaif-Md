require('dotenv').config();
const {
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

wasi_app.get('/ping', (req, res) => res.send('pong'));

// -----------------------------------------------------------------------------
// SAFE TEXT REPLACE (NO REGEX ❌)
// -----------------------------------------------------------------------------
const OLD_TEXTS = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(t => t.trim()).filter(Boolean)
    : [];

const NEW_TEXT = process.env.NEW_TEXT || "";

// -----------------------------------------------------------------------------
// CLEAN TEXT
// -----------------------------------------------------------------------------
function cleanText(text) {
    if (!text) return text;

    const removeList = [
        /Forwarded many times/gi,
        /Forwarded message/gi,
        /Broadcast:/gi
    ];

    removeList.forEach(r => text = text.replace(r, ''));

    return text.trim();
}

// -----------------------------------------------------------------------------
// SAFE REPLACE FUNCTION
// -----------------------------------------------------------------------------
function replaceCaption(text) {
    if (!text) return text;

    let result = text;

    OLD_TEXTS.forEach(t => {
        result = result.split(t).join(NEW_TEXT);
    });

    return result;
}

// -----------------------------------------------------------------------------
// AUTO RENAME (OPTIONAL 🔥)
// -----------------------------------------------------------------------------
function autoRename(message) {
    if (message.documentMessage) {
        message.documentMessage.fileName = "KAIF-MD-FILE";
    }
    return message;
}

// -----------------------------------------------------------------------------
// PROCESS MESSAGE
// -----------------------------------------------------------------------------
function processMessage(msg) {
    try {
        let m = structuredClone(msg);

        // remove forwarded tag
        if (m?.extendedTextMessage?.contextInfo) {
            m.extendedTextMessage.contextInfo.isForwarded = false;
            m.extendedTextMessage.contextInfo.forwardingScore = 0;
        }

        // get text
        let text =
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.imageMessage?.caption ||
            m.videoMessage?.caption ||
            m.documentMessage?.caption ||
            "";

        text = cleanText(text);
        text = replaceCaption(text);

        // put back
        if (m.conversation) m.conversation = text;
        if (m.extendedTextMessage?.text) m.extendedTextMessage.text = text;
        if (m.imageMessage?.caption) m.imageMessage.caption = text;
        if (m.videoMessage?.caption) m.videoMessage.caption = text;
        if (m.documentMessage?.caption) m.documentMessage.caption = text;

        return autoRename(m);

    } catch (e) {
        console.error("Process error:", e);
        return msg;
    }
}

// -----------------------------------------------------------------------------
// START SESSION
// -----------------------------------------------------------------------------
async function startSession(sessionId) {

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);

    wasi_sock.ev.on('creds.update', saveCreds);

    wasi_sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {

        if (qr) console.log("QR:", qr);

        if (connection === 'close') {
            const code = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : 500;

            if (code !== DisconnectReason.loggedOut) {
                startSession(sessionId);
            } else {
                wasi_clearSession(sessionId);
            }
        }

        if (connection === 'open') {
            console.log("✅ Connected");
        }
    });

    // -------------------------------------------------------------------------
    // MESSAGE LISTENER
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async ({ messages }) => {

        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;

        let relayMsg = processMessage(msg.message);

        // unwrap view once
        relayMsg =
            relayMsg?.viewOnceMessageV2?.message ||
            relayMsg?.viewOnceMessage?.message ||
            relayMsg;

        try {
            await wasi_sock.relayMessage(
                process.env.TARGET_JID,
                relayMsg,
                { messageId: wasi_sock.generateMessageTag() }
            );

            console.log("✅ Forwarded");

        } catch (err) {
            console.error("Forward error:", err);
        }
    });
}

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
wasi_app.listen(wasi_port, () => {
    console.log("Server running:", wasi_port);
});

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
(async () => {

    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
        console.log("DB Connected");
    }

    await startSession(config.sessionId || "wasi_session");

})();
