const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadContentFromMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const sharp = require('sharp');
const axios = require('axios');

// --- WEB SERVER (serves the QR code as a scannable image + satisfies Render's port check) ---
let latestQR = null;
let connectionStatus = 'connecting';

const app = express();
app.get('/', async (req, res) => {
    if (connectionStatus === 'open') {
        res.send('<html><body style="text-align:center;font-family:sans-serif;padding-top:60px"><h2>✅ Clanka is connected!</h2></body></html>');
    } else if (latestQR) {
        try {
            const qrImage = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
            res.send(`
                <html>
                <head><meta http-equiv="refresh" content="10"></head>
                <body style="text-align:center;font-family:sans-serif;padding-top:40px">
                    <h2>Scan with WhatsApp → Linked Devices</h2>
                    <img src="${qrImage}" style="width:320px;height:320px" />
                    <p>This page refreshes every 10s. QR codes expire — if it stops working, wait for a fresh one.</p>
                </body>
                </html>
            `);
        } catch (e) {
            res.status(500).send('Failed to render QR code.');
        }
    } else {
        res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;font-family:sans-serif;padding-top:60px"><h2>⏳ Waiting for QR code...</h2></body></html>');
    }
});
app.listen(process.env.PORT || 3000, () => console.log(`🌐 QR web server running on port ${process.env.PORT || 3000}`));

// --- FILE PATHS ---
const DB_PATH = './bot_db.json';
const GROUPS_PATH = './known_groups.json';

// --- DATABASE FUNCTIONS ---
function loadDB() {
    const defaultData = { warnings: {}, antilink: {}, superadmins: {}, mutes: {}, antimention: {}, stickerbans: {}, stickerstreak: {} };
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            if (!data.mutes) data.mutes = {};
            if (!data.antimention) data.antimention = {};
            if (!data.stickerbans) data.stickerbans = {};
            if (!data.stickerstreak) data.stickerstreak = {};
            return data;
        }
    } catch (e) {
        console.error('Error loading DB:', e);
    }
    return defaultData;
}

function saveDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error saving DB:', e);
    }
}

// --- GROUP TRACKER FUNCTIONS ---
function loadKnownGroups() {
    try {
        if (fs.existsSync(GROUPS_PATH)) {
            return JSON.parse(fs.readFileSync(GROUPS_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading groups:', e);
    }
    return [];
}

function saveKnownGroups(groups) {
    try {
        fs.writeFileSync(GROUPS_PATH, JSON.stringify(groups, null, 2));
    } catch (e) {
        console.error('Error saving groups:', e);
    }
}

function trackGroup(groupId) {
    if (!groupId.endsWith('@g.us')) return;
    let groups = loadKnownGroups();
    if (!groups.includes(groupId)) {
        groups.push(groupId);
        saveKnownGroups(groups);
        console.log(`📝 Added new group to tracker: ${groupId}`);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // WhatsApp periodically deprecates old client versions, which causes a
    // "Connection Failure" loop during the handshake. Fetching the current
    // version at startup keeps the bot compatible without needing a manual
    // package update every time this happens.
    let version;
    try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log(`📌 Using WhatsApp Web version: ${version.join('.')} (latest: ${versionInfo.isLatest})`);
    } catch (e) {
        console.error('⚠️ Failed to fetch latest WhatsApp version, using library default.', e);
    }

    const sock = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu('Desktop'),
        ...(version ? { version } : {}),
        retryRequestDelayMs: 10,
        maxRetries: 10,
        syncFullHistory: false,
        markOnlineOnConnect: true,
    });

    const db = loadDB();

    // --- IN-MESSAGE CACHE FOR STICKERS ---
    const messageCache = {};
    // --- NEW: CACHE FOR BOT'S OWN SENT MEDIA ---
    const botMediaCache = {};

    // Stores active typing intervals { [jid]: intervalId }
    let activeTyping = {};

    async function startTyping(jid, seconds) {
        if (activeTyping[jid]) clearInterval(activeTyping[jid]);
        await sock.sendPresenceUpdate('composing', jid);
        activeTyping[jid] = setInterval(async () => {
            await sock.sendPresenceUpdate('composing', jid);
        }, 5000);
        setTimeout(() => {
            if (activeTyping[jid]) {
                clearInterval(activeTyping[jid]);
                delete activeTyping[jid];
                sock.sendPresenceUpdate('paused', jid);
            }
        }, seconds * 1000);
    }

    // --- MUTE CHECKER ---
    setInterval(async () => {
        const now = Date.now();
        const mutes = db.mutes || {};
        let changed = false;
        for (const [id, data] of Object.entries(mutes)) {
            if (data.until && data.until < now) {
                try {
                    console.log(`⏰ Auto-unmuting group ${id}`);
                    await sock.groupSettingUpdate(id, 'not_announcement');
                    delete db.mutes[id];
                    changed = true;
                    await sock.sendMessage(id, {
                        text: `
🔊 *GROUP UNMUTED*
━━━━━━━━━━━━━━━━
All members can now chat
━━━━━━━━━━━━━━━━
`.trim()
                    });
                } catch (e) {
                    console.error(`Failed to unmute ${id}:`, e);
                }
            }
        }
        if (changed) saveDB(db);
    }, 10000);

    function normalizeNumber(s) {
        if (!s) return '';
        return String(s).replace(/[^0-9]/g, '');
    }

    function isSuperadmin(msg, groupId) {
        const sender = getSenderJid(msg);
        const sa = db.superadmins[groupId];
        return sa && sa === sender;
    }

    function findParticipantJidByTarget(target, participantJids) {
        if (!target) return null;
        if (target.includes('@')) {
            const direct = participantJids.find(j => j === target || j === target.replace(/:\d+@/, '@'));
            if (direct) return direct;
        }
        const targetDigits = normalizeNumber(target);
        if (!targetDigits) return null;
        for (const jid of participantJids) {
            const jidDigits = normalizeNumber(jid);
            if (!jidDigits) continue;
            if (jidDigits === targetDigits) return jid;
            if (jidDigits.endsWith(targetDigits)) return jid;
            if (jidDigits.includes(targetDigits)) return jid;
        }
        return null;
    }

    function extractRaw(p) {
        if (!p) return null;
        if (typeof p === 'string') return p;
        if (p.jid) return p.jid;
        if (p.id && typeof p.id === 'string') return p.id;
        if (p.participant) return p.participant;
        if (p.id && typeof p.id === 'object' && p.id.user) return `${p.id.user}@s.whatsapp.net`;
        return String(p);
    }

    function getDisplayName(targetJid, participants) {
        const phoneNum = targetJid.split('@')[0];
        const p = participants.find(x => extractRaw(x) === targetJid);
        if (p) return p.name || p.notify || phoneNum;
        return phoneNum;
    }

    async function getGroupAdminJids(groupId) {
        const meta = await sock.groupMetadata(groupId);
        const participants = meta?.participants || [];
        const admins = participants
            .filter(p => {
                const adminFlag = p.admin || p.isAdmin || p.is_super_admin || p.isSuperAdmin;
                if (typeof adminFlag === 'string') return adminFlag === 'admin' || adminFlag === 'superadmin' || adminFlag === 'creator';
                return !!adminFlag;
            })
            .map(p => extractRaw(p))
            .filter(Boolean);
        return [...new Set(admins)];
    }

    function resolveToLid(phoneJid) {
        if (!phoneJid || !phoneJid.includes('@s.whatsapp.net')) return phoneJid;
        let phoneNum = phoneJid.split('@')[0];
        if (phoneNum.includes(':')) phoneNum = phoneNum.split(':')[0];
        try {
            const mappingPath = `auth_info_baileys/lid-mapping-${phoneNum}.json`;
            if (fs.existsSync(mappingPath)) {
                const lid = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
                if (lid) return `${String(lid)}@lid`;
            }
        } catch (e) {
        }
        return phoneJid;
    }

    function getSenderJid(msg) {
        if (msg?.key?.participant) return msg.key.participant;
        if (msg?.participant) return msg.participant;
        return msg?.key?.remoteJid || null;
    }

    async function isSenderAdmin(msg) {
        const participant = getSenderJid(msg);
        if (!participant) return false;
        const groupId = msg?.key?.remoteJid;
        if (!groupId || !groupId.endsWith('@g.us')) return false;
        const admins = await getGroupAdminJids(groupId);
        return admins.includes(participant);
    }

    // --- SHARED WARNING/KICK HELPER (used by antilink/antimention/sticker moderation) ---
    async function issueWarning(groupId, participant, reason) {
        let meta;
        try {
            meta = await sock.groupMetadata(groupId);
        } catch (e) {
            console.error('Failed to fetch metadata for warning');
        }
        const name = meta ? getDisplayName(participant, meta.participants) : participant.split('@')[0];
        const key = `${groupId}_${participant}`;
        const count = (db.warnings[key] || 0) + 1;
        db.warnings[key] = count;
        saveDB(db);

        if (count >= 3) {
            let admins = [];
            try {
                admins = await getGroupAdminJids(groupId);
            } catch (e) {
                console.error('Failed to fetch admins for kick check');
            }
            const botJid = sock.user?.id || sock.user?.jid;
            const botLid = resolveToLid(botJid);
            const botIsAdmin = admins.includes(botLid);

            if (botIsAdmin) {
                try {
                    await sock.groupParticipantsUpdate(groupId, [participant], 'remove');
                    await sock.sendMessage(groupId, {
                        text: `
╔═══════════════════╗
🚫 AUTO-KICK 🚫   
╚═══════════════════╝
User: ${name}
Reason: 3 warnings
Violation: ${reason}
━━━━━━━━━━━━━━━━━━━
`.trim()
                    });
                    delete db.warnings[key];
                    saveDB(db);
                } catch (err) {
                    console.error('Auto-kick failed:', err);
                }
            } else {
                await sock.sendMessage(groupId, { text: `⚠️ ${name} has 3 warnings (Bot can't kick).` });
            }
        } else {
            await sock.sendMessage(groupId, {
                text: `
╔════════════════╗
 ⚠️  WARNING ⚠️  
╚════════════════╝
User: ${name}
Count: ${count}/3
Reason: ${reason}
━━━━━━━━━━━━━━━━
`.trim()
            });
        }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr';
            console.log('\n\n🎯 ========== SCAN WITH WHATSAPP ==========');
            console.log('Open the app URL in a browser to scan it as an image (log ASCII may not be scannable).');
            qrcode.generate(qr, { small: true });
            console.log('========================================\n\n');
        }
        if (connection === 'connecting') {
            connectionStatus = 'connecting';
            console.log('⏳ Connecting to WhatsApp...');
        }
        if (connection === 'open') {
            connectionStatus = 'open';
            latestQR = null;
            console.log('✅ BOT CONNECTED SUCCESSFULLY!');
            const startupMsg = `
╔═══════════════════╗
⚡ *Clanka ONLINE*
╚═══════════════════╝

🟢 *SYSTEM STATUS: ACTIVE*
━━━━━━━━━━━━━━━━━━━━━
📡 Connection: Established
🔐 Security: Enabled  
⚙️  Commands: Ready

Type *!help* for menu
━━━━━━━━━━━━━━━━━━━━━
`.trim();
            const botJid = sock.user?.id.split(':')[0] + '@s.whatsapp.net';
            await sock.sendMessage(botJid, { text: startupMsg });
            setTimeout(async () => {
                console.log('📢 Broadcasting startup message to tracked groups...');
                const knownGroups = loadKnownGroups();
                let count = 0;
                for (const id of knownGroups) {
                    try {
                        await sock.sendMessage(id, { text: startupMsg });
                        count++;
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e) {
                        console.error(`Failed to send to ${id}`);
                    }
                }
                console.log(`📢 Sent startup message to ${count} groups.`);
                console.log('📝 Bot is ready.\n');
            }, 1000);
        }
        if (connection === 'close') {
            connectionStatus = 'connecting';
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed:', lastDisconnect?.error?.message);
            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 5 seconds...\n');
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                console.log('🚪 Logged out. Scan QR code to log back in.');
                process.exit();
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        for (const msg of m.messages) {
            if (!msg.message) return;
            if (msg.key.fromMe) return;

            // --- CACHING LOGIC ---
            if (msg.message.stickerMessage || msg.message.imageMessage) {
                messageCache[msg.key.id] = msg;
                console.log(`📦 Cached message ${msg.key.id} for media conversion`);
            }

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const sender = msg.key.remoteJid;
            const isAdmin = await isSenderAdmin(msg);

            trackGroup(sender);

            const botId = sock.user?.id || sock.user?.jid;
            const rawBotJid = botId ? (botId.includes('@') ? botId.split(':')[0] + (botId.includes('@lid') ? '@lid' : '@s.whatsapp.net') : botId) : null;
            const botLid = resolveToLid(rawBotJid);

            console.log(`\n📩 Message from ${sender}:\n${text}\n`);

            // --- STICKER MODERATION (per-user sticker bans + anti-spam streak) ---
            if (sender.endsWith('@g.us')) {
                const participant = getSenderJid(msg);
                const streakKey = `${sender}_${participant}`;

                if (msg.message.stickerMessage) {
                    const banKey = `${sender}_${participant}`;

                    if (db.stickerbans[banKey]) {
                        try {
                            await sock.sendMessage(sender, { delete: msg.key });
                        } catch (err) {
                            console.error('Failed to delete banned sticker:', err);
                        }
                        await issueWarning(sender, participant, 'Sent a sticker while sticker-banned');
                        continue;
                    }

                    db.stickerstreak[streakKey] = (db.stickerstreak[streakKey] || 0) + 1;
                    saveDB(db);

                    if (db.stickerstreak[streakKey] > 6) {
                        try {
                            await sock.sendMessage(sender, { delete: msg.key });
                        } catch (err) {
                            console.error('Failed to delete spam sticker:', err);
                        }
                        db.stickerstreak[streakKey] = 0;
                        saveDB(db);
                        await issueWarning(sender, participant, 'More than 6 stickers in a row');
                        continue;
                    }
                } else if (db.stickerstreak[streakKey]) {
                    db.stickerstreak[streakKey] = 0;
                    saveDB(db);
                }
            }

            // ANTILINK & ANTIMENTION
            if (!msg.key.fromMe) {
                let triggered = false;
                let warnReason = "";

                if (db.antilink[sender] && !triggered) {
                    const linkRegex = /(https?:\/\/)?(www\.)?[a-zA-Z0-9]+\.[a-zA-Z]{2,}|wa\.me|chat\.whatsapp\.com/gi;
                    if (linkRegex.test(text)) {
                        triggered = true;
                        warnReason = "Link detected";
                    }
                }

                if (db.antimention[sender] && !triggered) {
                    const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                    const mentions = ctx.mentionedJid || [];
                    if (mentions.length > 0) {
                        triggered = true;
                        warnReason = "Mention detected";
                    }
                }

                if (triggered) {
                    const participant = getSenderJid(msg);
                    let meta;
                    try {
                        meta = await sock.groupMetadata(sender);
                    } catch (e) {
                        console.error('Failed to fetch metadata for antilink/mention');
                    }
                    const admins = meta?.participants
                        .filter(p => {
                            const adminFlag = p.admin || p.isAdmin || p.is_super_admin || p.isSuperAdmin;
                            if (typeof adminFlag === 'string') return adminFlag === 'admin' || adminFlag === 'superadmin' || adminFlag === 'creator';
                            return !!adminFlag;
                        })
                        .map(p => extractRaw(p)) || [];
                    const targetLid = resolveToLid(participant);

                    if (admins.includes(targetLid)) {
                        console.log(`🛡️ Admin triggered ${warnReason}, ignoring.`);
                    } else {
                        try {
                            await sock.sendMessage(sender, { delete: msg.key });
                            console.log(`🛡️ Deleted message for ${warnReason} from ${participant}`);
                        } catch (err) {
                            console.error('Failed to delete:', err);
                        }

                        const key = `${sender}_${participant}`;
                        const count = (db.warnings[key] || 0) + 1;
                        db.warnings[key] = count;
                        saveDB(db);

                        const name = meta ? getDisplayName(participant, meta.participants) : participant;

                        if (count >= 3) {
                            const botJid = sock.user?.id || sock.user?.jid;
                            const botLid = resolveToLid(botJid);
                            const botIsAdmin = admins.includes(botLid);

                            if (botIsAdmin) {
                                try {
                                    await sock.groupParticipantsUpdate(sender, [participant], 'remove');
                                    await sock.sendMessage(sender, {
                                        text: `
╔═══════════════════╗
🚫 AUTO-KICK 🚫   
╚═══════════════════╝
User: ${name}
Reason: 3 warnings
Violation: ${warnReason}
━━━━━━━━━━━━━━━━━━━
`.trim()
                                    });
                                    delete db.warnings[key];
                                    saveDB(db);
                                } catch (err) {
                                    console.error('Auto-kick failed:', err);
                                }
                            } else {
                                await sock.sendMessage(sender, { text: `⚠️ ${name} has 3 warnings (Bot can't kick).` });
                            }
                        } else {
                            await sock.sendMessage(sender, {
                                text: `
╔════════════════╗
 ⚠️  WARNING ⚠️  
╚════════════════╝
User: ${name}
Count: ${count}/3
Reason: ${warnReason}
━━━━━━━━━━━━━━━━
`.trim()
                            });
                        }
                        return;
                    }
                }
            }

            let reply = '';

            if (text.startsWith('!')) {
                const parts = text.slice(1).trim().split(/\s+/);
                const cmd = parts[0]?.toLowerCase() || '';
                const args = parts.slice(1);

                if (activeTyping[sender]) {
                    clearInterval(activeTyping[sender]);
                    delete activeTyping[sender];
                    sock.sendPresenceUpdate('paused', sender);
                }

                // PUBLIC COMMANDS
                if (cmd === 'participants') {
                    const groupId = msg.key.remoteJid;
                    if (!groupId || !groupId.endsWith('@g.us')) reply = 'This command only works in groups.';
                    else {
                        try {
                            const meta = await sock.groupMetadata(groupId);
                            const participants = meta?.participants || [];
                            const list = participants.slice(0, 50).map(p => p.jid || p.id || p.participant || (p.id && p.id.user ? `${p.id.user}@s.whatsapp.net` : String(p)));
                            reply = `Participants (${list.length}${participants.length > 50 ? '+' : ''}):\n` + list.join('\n');
                        } catch (e) {
                            reply = 'Failed to fetch participants.';
                        }
                    }
                } else if (cmd === 'admins') {
                    const groupId = msg.key.remoteJid;
                    if (!groupId || !groupId.endsWith('@g.us')) reply = 'This command only works in groups.';
                    else {
                        try {
                            const admins = await getGroupAdminJids(groupId);
                            if (!admins || admins.length === 0) reply = 'No admins found.';
                            else reply = 'Group admins (raw JIDs):\n' + admins.join('\n');
                        } catch (e) {
                            reply = 'Failed to fetch admins.';
                        }
                    }
                } else if (cmd === 'ping') {
                    if (args.length === 0) reply = '⚡ *PONG!* ⚡';
                    else reply = args.join(' ');
                } else if (cmd === 'rps' || cmd === 'roshambo') {
                    const choices = ['rock', 'paper', 'scissors'];
                    const userPick = args[0]?.toLowerCase();
                    if (!choices.includes(userPick)) {
                        reply = 'Usage: !rps rock/paper/scissors';
                    } else {
                        const botPick = choices[Math.floor(Math.random() * choices.length)];
                        let result = '';
                        if (userPick === botPick) result = `🤝 *DRAW!* Both chose ${userPick}`;
                        else if (
                            (userPick === 'rock' && botPick === 'scissors') ||
                            (userPick === 'paper' && botPick === 'rock') ||
                            (userPick === 'scissors' && botPick === 'paper')
                        ) {
                            result = '🎉 *VICTORY!* You dominated the bot!';
                        } else {
                            result = '🤖 *BOT WINS!* Better luck next time!';
                        }
                        reply = `
╔═══════════════╗
  🎮 RPS GAME  
╚═══════════════╝
You: ${userPick}
Bot: ${botPick}

 ${result}
`.trim();
                    }
                } else if (cmd.startsWith('waifu')) {
                    try {
                        const axios = require('axios');

                        // Fetch a random SFW waifu from waifu.pics
                        const response = await axios.get(`https://api.waifu.pics/sfw/waifu`);
                        const imgUrl = response.data.url;

                        // Compress the image on-the-fly using images.weserv.nl
                        const compressedUrl = `https://images.weserv.nl/?url=${encodeURIComponent(imgUrl)}&w=512&h=512&fit=cover`;

                        // Send the compressed image
                        await sock.sendMessage(sender, {
                            image: { url: compressedUrl },
                            caption: `Here is your waifu 💖`
                        });

                        reply = null;
                    } catch (e) {
                        console.error('Waifu error:', e);
                        reply = '❌ Error fetching waifu.';
                    }
                }
                else if (cmd === 'autotype') {
                    const seconds = parseInt(args[0]);
                    if (isNaN(seconds) || seconds < 1 || seconds > 30) {
                        reply = 'Usage: !autotype (1-30)';
                    } else {
                        reply = `⌨️ I will type for ${seconds} seconds...`;
                        startTyping(sender, seconds);
                    }
                } else if (cmd === 'toimg') {
                    const ctx = msg.message.extendedTextMessage?.contextInfo;
                    if (!ctx || !ctx.stanzaId) {
                        reply = 'Reply to a sticker to convert it!';
                    } else {
                        const quotedId = ctx.stanzaId;
                        let msgToDownload = messageCache[quotedId];
                        let buffer = null;

                        // Check if it's a user message
                        if (!msgToDownload) {
                            // Check if it's a message the bot just sent
                            if (botMediaCache[quotedId]) {
                                buffer = botMediaCache[quotedId].buffer;
                            }
                        }

                        if (!buffer && !msgToDownload) {
                            reply = '⚠️ Bot does not have this sticker in memory.\n\nStickers must be sent **while the bot is running** and **recently**.';
                        } else if (msgToDownload && !msgToDownload.message.stickerMessage) {
                            reply = 'The quoted message is not a sticker.';
                        } else {
                            try {
                                reply = `
⚡ *CONVERTING* ⚡
━━━━━━━━━━━━━━━
Sticker → Image
Processing...
`.trim();

                                if (!buffer) {
                                    // Download from Baileys
                                    const stream = await downloadContentFromMessage(
                                        msgToDownload.message.stickerMessage,
                                        'sticker'
                                    );
                                    let tempBuffer = Buffer.from([]);
                                    for await (const chunk of stream) {
                                        tempBuffer = Buffer.concat([tempBuffer, chunk]);
                                    }
                                    buffer = tempBuffer;
                                }

                                const imageBuffer = await sharp(buffer)
                                    .toFormat('png')
                                    .toBuffer();

                                await sock.sendMessage(sender, {
                                    image: imageBuffer,
                                    caption: `
✅ *CONVERSION COMPLETE*
━━━━━━━━━━━━━━━━━━━━
Sticker → PNG Image
━━━━━━━━━━━━━━━━━━━━
`.trim()
                                });
                                reply = null;
                            } catch (e) {
                                console.error('Toimg error:', e);
                                reply = `❌ Error converting sticker. (${e.message})`;
                            }
                        }
                    }
                } else if (cmd === 'tosticker') {
                    const ctx = msg.message.extendedTextMessage?.contextInfo;
                    if (!ctx || !ctx.stanzaId) {
                        reply = 'Reply to an image to convert it!';
                    } else {
                        const quotedId = ctx.stanzaId;
                        const msgToDownload = messageCache[quotedId];

                        if (!msgToDownload) {
                            reply = '⚠️ Bot does not have this image in memory.';
                        } else if (!msgToDownload.message.imageMessage) {
                            reply = 'The quoted message is not an image.';
                        } else {
                            try {
                                reply = `
⚡ *CONVERTING* ⚡
━━━━━━━━━━━━━━━
Image → Sticker
Processing...
`.trim();

                                const stream = await downloadContentFromMessage(
                                    msgToDownload.message.imageMessage,
                                    'image'
                                );

                                let buffer = Buffer.from([]);
                                for await (const chunk of stream) {
                                    buffer = Buffer.concat([buffer, chunk]);
                                }

                                const stickerBuffer = await sharp(buffer)
                                    .resize(512, 512, { fit: 'cover', position: 'center' })
                                    .webp({ quality: 80 })
                                    .toBuffer();

                                // Send Sticker
                                const sentMsg = await sock.sendMessage(sender, { sticker: stickerBuffer });

                                // --- NEW: Cache bot's own media to memory ---
                                if (sentMsg?.key?.id) {
                                    botMediaCache[sentMsg.key.id] = {
                                        type: 'sticker',
                                        buffer: stickerBuffer
                                    };
                                }

                                reply = null;
                            } catch (e) {
                                console.error('Tosticker error:', e);
                                reply = `❌ Error converting image. (${e.message})`;
                            }
                        }
                    }
                } else if (cmd === 'add') {
                    const groupId = msg.key.remoteJid;
                    if (!groupId || !groupId.endsWith('@g.us')) reply = 'This command only works in groups.';
                    else {
                        const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                        let targetJid = null;
                        let rawArg = null;

                        if (ctx.mentionedJid && ctx.mentionedJid.length > 0) {
                            targetJid = ctx.mentionedJid[0];
                            rawArg = '@user';
                        } else if (args[0]) {
                            let rawNumber = args[0].replace(/\D/g, '');
                            if (rawNumber.length > 5) {
                                targetJid = `${rawNumber}@s.whatsapp.net`;
                                rawArg = args[0];
                            }
                        }

                        if (!targetJid) {
                            reply = 'Usage: !add @user or !add 1555...';
                        } else {
                            const admins = await getGroupAdminJids(groupId);
                            const botJid = sock.user?.id || sock.user?.jid;
                            const botLid = resolveToLid(botJid);
                            const botIsAdmin = admins.includes(botLid);

                            if (!botIsAdmin) {
                                reply = `
❌ *ACCESS DENIED*
━━━━━━━━━━━━━━━━
Bot requires admin privileges
to add participants
━━━━━━━━━━━━━━━━
`.trim();
                            } else {
                                try {
                                    const response = await sock.groupParticipantsUpdate(groupId, [targetJid], 'add');
                                    const result = response[0];
                                    const echoTarget = rawArg || targetJid.split('@')[0];

                                    if (result.status == 200) reply = `✅ *USER ADDED* → ${echoTarget}`;
                                    else if (result.status === 403) reply = `❌ *FAILED* → Privacy settings or invalid number`;
                                    else if (result.status === 408) reply = `❌ *FAILED* → User left recently (cooldown active)`;
                                    else if (result.status === 409) reply = `❌ *ALREADY PRESENT* → User is already in this group`;
                                    else reply = `Error: ${result.status}`;
                                } catch (err) {
                                    reply = 'Failed to add.';
                                }
                            }
                        }
                    }
                }
                // ADMIN ONLY COMMANDS
                else {
                    if (!isAdmin) {
                        reply = '❌ You are not an admin';
                    } else {
                        if (cmd === 'mute') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const admins = await getGroupAdminJids(groupId);
                                const botJid = sock.user?.id || sock.user?.jid;
                                const botLid = resolveToLid(botJid);
                                const botIsAdmin = admins.includes(botLid);

                                if (!botIsAdmin) reply = `
❌ *INSUFFICIENT PRIVILEGES*
━━━━━━━━━━━━━━━━━━━━━━
Bot needs admin status to
mute/unmute the group
━━━━━━━━━━━━━━━━━━━━━━
`.trim();
                                else if (!args[0]) reply = 'Usage: !mute (e.g. 30, 1h, 2d)';
                                else {
                                    const timeStr = args[0].toLowerCase();
                                    let ms = 0;
                                    if (timeStr.endsWith('h')) ms = parseInt(timeStr) * 3600000;
                                    else if (timeStr.endsWith('d')) ms = parseInt(timeStr) * 86400000;
                                    else ms = parseInt(timeStr) * 60000;

                                    if (isNaN(ms) || ms <= 0) reply = 'Invalid time format.';
                                    else {
                                        try {
                                            await sock.groupSettingUpdate(groupId, 'announcement');
                                            db.mutes[groupId] = { until: Date.now() + ms };
                                            saveDB(db);
                                            reply = `
🔇 *MUTE ACTIVATED*
━━━━━━━━━━━━━━━━
Duration: ${args[0]}
Only admins can send messages
━━━━━━━━━━━━━━━━
`.trim();
                                        } catch (e) {
                                            reply = `❌ Failed to mute group. Reason: ${e.message || 'Unknown error'}`;
                                        }
                                    }
                                }
                            }
                        } else if (cmd === 'unmute') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const admins = await getGroupAdminJids(groupId);
                                const botJid = sock.user?.id || sock.user?.jid;
                                const botLid = resolveToLid(botJid);
                                const botIsAdmin = admins.includes(botLid);

                                if (!botIsAdmin) reply = `
❌ *INSUFFICIENT PRIVILEGES*
━━━━━━━━━━━━━━━━━━━━━━
Bot needs admin status to
mute/unmute the group
━━━━━━━━━━━━━━━━━━━━━━
`.trim();
                                else {
                                    try {
                                        await sock.groupSettingUpdate(groupId, 'not_announcement');
                                        delete db.mutes[groupId];
                                        saveDB(db);
                                        reply = `
🔊 *GROUP UNMUTED*
━━━━━━━━━━━━━━━━
All members can now chat
━━━━━━━━━━━━━━━━
`.trim();
                                    } catch (e) {
                                        reply = `❌ Failed to unmute group. Reason: ${e.message || 'Unknown error'}`;
                                    }
                                }
                            }
                        } else if (cmd === 'antimention') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else if (!args[0]) reply = 'Usage: !antimention on/off';
                            else if (args[0].toLowerCase() === 'on') {
                                db.antimention[groupId] = true;
                                saveDB(db);
                                reply = `
🛡️ *ANTIMENTION ACTIVATED*
━━━━━━━━━━━━━━━━━━━━━
⚠️  Mention detection: ON
🚫 Auto-moderation: ACTIVE
━━━━━━━━━━━━━━━━━━━━━
`.trim();
                            } else if (args[0].toLowerCase() === 'off') {
                                delete db.antimention[groupId];
                                saveDB(db);
                                reply = `
🛑 *ANTIMENTION DEACTIVATED*
━━━━━━━━━━━━━━━━━━━━━━━
Mentions are now allowed
━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
                            } else reply = 'Use on or off.';
                        } else if (cmd === 'stickerban') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;
                                const lastArg = args[args.length - 1]?.toLowerCase();
                                const turnOff = lastArg === 'off';

                                if (ctx.participant) target = ctx.participant;
                                else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];
                                else if (args[0] && args[0].toLowerCase() !== 'off') {
                                    let raw = args[0].replace(/\D/g, '');
                                    if (raw.length > 5) target = `${raw}@s.whatsapp.net`;
                                }

                                if (!target) reply = 'Usage: !stickerban @user (reply or mention) — add "off" to lift the ban';
                                else {
                                    const banKey = `${groupId}_${target}`;
                                    const name = target.split('@')[0];

                                    if (turnOff) {
                                        delete db.stickerbans[banKey];
                                        saveDB(db);
                                        reply = `✅ Sticker ban lifted for ${name}.`;
                                    } else {
                                        db.stickerbans[banKey] = true;
                                        saveDB(db);
                                        reply = `
🚫 *STICKER BAN*
━━━━━━━━━━━━━━━━
User: ${name}
They can no longer send stickers.
Stickers will be deleted + warned.
━━━━━━━━━━━━━━━━
`.trim();
                                    }
                                }
                            }
                        } else if (cmd === 'setname') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else if (args.length === 0) reply = 'Usage: !setname New Group Name';
                            else {
                                const newName = args.join(' ');
                                try {
                                    await sock.groupUpdateSubject(groupId, newName);
                                    reply = `✅ Group name updated to "${newName}"`;
                                } catch (e) {
                                    reply = 'Failed to update group name.';
                                }
                            }
                        } else if (cmd === 'setdesc') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else if (args.length === 0) reply = 'Usage: !setdesc Description text here';
                            else {
                                const newDesc = args.join(' ');
                                try {
                                    await sock.groupUpdateDescription(groupId, newDesc);
                                    reply = `✅ Group description updated.`;
                                } catch (e) {
                                    reply = 'Failed to update description.';
                                }
                            }
                        } else if (cmd === 'kick') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;

                                if (ctx.participant) target = ctx.participant;
                                if (!target && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];
                                if (!target && args[0]) target = args[0];

                                if (!target) reply = 'Usage: !kick @user or reply to a user.';
                                else {
                                    if (!target.includes('@') || /^@?\d+$/.test(target.replace(/[^\d@]/g, ''))) {
                                        let raw = String(target).replace(/^@/, '').replace(/\D/g, '');
                                        if (!raw) reply = 'Could not parse number.';
                                        else target = `${raw}@s.whatsapp.net`;
                                    }

                                    // --- NEW: SELF-KICK PREVENTION ---
                                    const botJid = sock.user?.id || sock.user?.jid;
                                    const botLid = resolveToLid(botJid);

                                    if (target === botJid || target === botLid) {
                                        reply = 'Are you serious?';
                                    } else {
                                        // --- EXISTING KICK LOGIC ---
                                        if (target) {
                                            let meta = null;
                                            try {
                                                meta = await sock.groupMetadata(groupId);
                                            } catch (err) {
                                                reply = 'Failed to fetch metadata.';
                                            }

                                            if (meta) {
                                                const participants = meta?.participants || [];
                                                const participantJids = participants.map(p => {
                                                    if (typeof p === 'string') return p;
                                                    if (p.jid) return p.jid;
                                                    if (p.id && typeof p.id === 'string') return p.id;
                                                    if (p.participant) return p.participant;
                                                    if (p.id && typeof p.id === 'object' && p.id.user) return `${p.id.user}@s.whatsapp.net`;
                                                    return String(p);
                                                }).filter(Boolean);

                                                const matchedJid = findParticipantJidByTarget(target, participantJids) || (participantJids.includes(target) ? target : null);

                                                if (!matchedJid) reply = 'User not in this group.';
                                                else {
                                                    const name = getDisplayName(matchedJid, participants);
                                                    const admins = participants.filter(p => {
                                                        const adminFlag = p.admin || p.isAdmin || p.is_super_admin || p.isSuperAdmin;
                                                        if (typeof adminFlag === 'string') return adminFlag === 'admin' || adminFlag === 'superadmin' || adminFlag === 'creator';
                                                        return !!adminFlag;
                                                    }).map(p => extractRaw(p));

                                                    const botJid2 = sock.user?.id || sock.user?.jid;
                                                    const botLid2 = resolveToLid(botJid);
                                                    const botIsAdmin = admins.includes(botLid);

                                                    if (!botIsAdmin) reply = `
❌ *ACCESS DENIED*
━━━━━━━━━━━━━━━━
Bot requires admin privileges
to remove participants
━━━━━━━━━━━━━━━━
`.trim();
                                                    else {
                                                        try {
                                                            await sock.groupParticipantsUpdate(groupId, [matchedJid], 'remove');
                                                            reply = `
╔═══════════════╗
 🚫 KICKED 🚫  
╚═══════════════╝
User: ${name}
Status: REMOVED
━━━━━━━━━━━━━━━
`.trim();
                                                        } catch (err) {
                                                            reply = 'Failed to remove user.';
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    // ------------------------------
                                }
                            }
                        } else if (cmd === 'warn') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;

                                if (ctx.participant) target = ctx.participant;
                                else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];

                                if (!target) reply = 'Usage: !warn @user';
                                else if (target === getSenderJid(msg)) reply = 'Cannot warn yourself.';
                                else {
                                    let meta;
                                    try {
                                        meta = await sock.groupMetadata(groupId);
                                    } catch (e) {
                                        reply = 'Failed to fetch metadata.';
                                    }

                                    if (meta) {
                                        const admins = meta?.participants.filter(p => {
                                            const adminFlag = p.admin || p.isAdmin || p.is_super_admin || p.isSuperAdmin;
                                            if (typeof adminFlag === 'string') return adminFlag === 'admin' || adminFlag === 'superadmin' || adminFlag === 'creator';
                                            return !!adminFlag;
                                        }).map(p => extractRaw(p));

                                        const targetLid = resolveToLid(target);

                                        if (admins.includes(targetLid)) reply = 'Cannot warn admin.';
                                        else {
                                            const name = getDisplayName(target, meta.participants);
                                            const key = `${groupId}_${target}`;
                                            const count = (db.warnings[key] || 0) + 1;
                                            db.warnings[key] = count;
                                            saveDB(db);

                                            if (count >= 3) {
                                                const botJid = sock.user?.id || sock.user?.jid;
                                                const botLid = resolveToLid(botJid);
                                                const botIsAdmin = admins.includes(botLid);

                                                if (botIsAdmin) {
                                                    try {
                                                        await sock.groupParticipantsUpdate(groupId, [target], 'remove');
                                                        reply = `
╔═══════════════════╗
 🚫 AUTO-KICK 🚫   
╚═══════════════════╝
User: ${name}
Reason: 3 warnings
Violation: Manual warn
━━━━━━━━━━━━━━━━━━━
`.trim();
                                                        delete db.warnings[key];
                                                        saveDB(db);
                                                    } catch (err) {
                                                        reply = 'Failed to kick.';
                                                    }
                                                } else reply = `User has 3 warnings (Bot not admin).`;
                                            } else reply = `
╔════════════════╗
 ⚠️  WARNING ⚠️  
╚════════════════╝
User: ${name}
Count: ${count}/3
Reason: Manual warn
━━━━━━━━━━━━━━━━
`.trim();
                                        }
                                    }
                                }
                            }
                        } else if (cmd === 'unwarn') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;

                                if (ctx.participant) target = ctx.participant;
                                else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];

                                if (!target) reply = 'Usage: !unwarn @user';
                                else {
                                    let meta;
                                    try {
                                        meta = await sock.groupMetadata(groupId);
                                    } catch (e) {
                                        reply = 'Failed to fetch metadata.';
                                    }

                                    if (meta) {
                                        const name = getDisplayName(target, meta.participants);
                                        const key = `${groupId}_${target}`;

                                        if (db.warnings[key]) {
                                            delete db.warnings[key];
                                            saveDB(db);
                                            reply = `✅ Cleared warnings for ${name}.`;
                                        } else {
                                            reply = `${name} has no warnings.`;
                                        }
                                    }
                                }
                            }
                        } else if (cmd === 'warns') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;

                                if (ctx.participant) target = ctx.participant;
                                else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];
                                else if (args[0]) {
                                    let raw = args[0].replace(/\D/g, '');
                                    if (raw.length > 5) target = `${raw}@s.whatsapp.net`;
                                    else target = args[0];
                                }

                                if (target) {
                                    let meta;
                                    try {
                                        meta = await sock.groupMetadata(groupId);
                                    } catch (e) {
                                        reply = 'Failed to fetch metadata.';
                                    }

                                    if (meta) {
                                        const name = getDisplayName(target, meta.participants);
                                        const key = `${groupId}_${target}`;
                                        const count = db.warnings[key] || 0;
                                        reply = `Warnings for ${name}: ${count}/3`;
                                    }
                                } else {
                                    reply = 'Mention or reply to check warnings.';
                                }
                            }
                        } else if (cmd === 'antilink') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else if (!args[0]) reply = 'Usage: !antilink on/off';
                            else if (args[0].toLowerCase() === 'on') {
                                db.antilink[groupId] = true;
                                saveDB(db);
                                reply = `
🛡️ *ANTILINK ACTIVATED*
━━━━━━━━━━━━━━━━━━━━
⚠️  Link detection: ON
🚫 Auto-moderation: ACTIVE
━━━━━━━━━━━━━━━━━━━━
`.trim();
                            } else if (args[0].toLowerCase() === 'off') {
                                delete db.antilink[groupId];
                                saveDB(db);
                                reply = `
🛑 *ANTILINK DEACTIVATED*
━━━━━━━━━━━━━━━━━━━━━━
Link posting is now allowed
━━━━━━━━━━━━━━━━━━━━━━
`.trim();
                            } else reply = 'Use on or off.';
                        } else if (cmd === 'superadmin') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else {
                                const sender = getSenderJid(msg);
                                const currentSA = db.superadmins[groupId];

                                if (!currentSA) {
                                    db.superadmins[groupId] = sender;
                                    saveDB(db);
                                    reply = `
╔══════════════════╗
 👑 SUPERADMIN 👑 
╚══════════════════╝
You now have supreme control
Type !help for commands
━━━━━━━━━━━━━━━━━━━━
`.trim();
                                } else if (currentSA === sender) {
                                    const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                    let target = null;

                                    if (ctx.participant) target = ctx.participant;
                                    else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];

                                    if (target) {
                                        db.superadmins[groupId] = target;
                                        saveDB(db);
                                        reply = `
👑 *SUPERADMIN TRANSFERRED*
━━━━━━━━━━━━━━━━━━━━
New admin: ${target.split('@')[0]}
━━━━━━━━━━━━━━━━━━━━
`.trim();
                                    } else reply = 'Mention a user to transfer rights.';
                                } else reply = '❌ You are not the Superadmin.';
                            }
                        } else if (cmd === 'promote') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else if (!isSuperadmin(msg, groupId)) reply = '👑 Only Superadmin.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;

                                if (ctx.participant) target = ctx.participant;
                                else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];
                                else if (args[0]) {
                                    let raw = args[0].replace(/\D/g, '');
                                    if (raw.length > 5) target = `${raw}@s.whatsapp.net`;
                                }

                                if (!target) reply = 'Usage: !promote @user';
                                else {
                                    let meta;
                                    try {
                                        meta = await sock.groupMetadata(groupId);
                                    } catch (e) {
                                        reply = 'Failed to fetch metadata.';
                                    }

                                    if (meta) {
                                        const name = getDisplayName(target, meta.participants);
                                        const admins = meta?.participants.filter(p => {
                                            const adminFlag = p.admin || p.isAdmin || p.is_super_admin || p.isSuperAdmin;
                                            if (typeof adminFlag === 'string') return adminFlag === 'admin' || adminFlag === 'superadmin' || adminFlag === 'creator';
                                            return !!adminFlag;
                                        }).map(p => extractRaw(p));

                                        const botJid = sock.user?.id || sock.user?.jid;
                                        const botLid = resolveToLid(botJid);
                                        const botIsAdmin = admins.includes(botLid);

                                        if (!botIsAdmin) reply = `
❌ *ACCESS DENIED*
━━━━━━━━━━━━━━━━
Bot requires admin privileges
to promote members
━━━━━━━━━━━━━━━━
`.trim();
                                        else {
                                            try {
                                                await sock.groupParticipantsUpdate(groupId, [target], 'promote');
                                                reply = `⬆️ *PROMOTED* → ${name}`;
                                            } catch (err) {
                                                reply = 'Failed to promote.';
                                            }
                                        }
                                    }
                                }
                            }
                        } else if (cmd === 'demote') {
                            const groupId = msg.key.remoteJid;
                            if (!groupId || !groupId.endsWith('@g.us')) reply = 'Groups only.';
                            else if (!isSuperadmin(msg, groupId)) reply = '👑 Only Superadmin.';
                            else {
                                const ctx = msg.message.extendedTextMessage?.contextInfo || {};
                                let target = null;

                                if (ctx.participant) target = ctx.participant;
                                else if (ctx.mentionedJid && ctx.mentionedJid.length > 0) target = ctx.mentionedJid[0];
                                else if (args[0]) {
                                    let raw = args[0].replace(/\D/g, '');
                                    if (raw.length > 5) target = `${raw}@s.whatsapp.net`;
                                }

                                if (!target) reply = 'Usage: !demote @user';
                                else {
                                    let meta;
                                    try {
                                        meta = await sock.groupMetadata(groupId);
                                    } catch (e) {
                                        reply = 'Failed to fetch metadata.';
                                    }

                                    if (meta) {
                                        const name = getDisplayName(target, meta.participants);
                                        const admins = meta?.participants.filter(p => {
                                            const adminFlag = p.admin || p.isAdmin || p.is_super_admin || p.isSuperAdmin;
                                            if (typeof adminFlag === 'string') return adminFlag === 'admin' || adminFlag === 'superadmin' || adminFlag === 'creator';
                                            return !!adminFlag;
                                        }).map(p => extractRaw(p));

                                        const botJid = sock.user?.id || sock.user?.jid;
                                        const botLid = resolveToLid(botJid);
                                        const botIsAdmin = admins.includes(botLid);

                                        if (!botIsAdmin) reply = `
❌ *ACCESS DENIED*
━━━━━━━━━━━━━━━━
Bot requires admin privileges
to demote members
━━━━━━━━━━━━━━━━
`.trim();
                                        else {
                                            try {
                                                await sock.groupParticipantsUpdate(groupId, [target], 'demote');
                                                reply = `⬇️ *DEMOTED* → ${name}`;
                                            } catch (err) {
                                                reply = 'Failed to demote.';
                                            }
                                        }
                                    }
                                }
                            }
                        } else if (cmd === 'help') {
                            reply = `
╔═══════════════════╗
  ⚡ *Clanka BOT v2.0* 
╚═══════════════════╝

┏━━━━━━━━━━━━━━━━━━━┓
┃  📊 *INFORMATION*
┣━━━━━━━━━━━━━━━━━━━┫
┃ ▸ !participants
┃ ▸ !admins
┗━━━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━━━┓
┃  🛡️ *ADMIN CONTROL*
┣━━━━━━━━━━━━━━━━━━━┫
┃ ▸ !kick @user
┃ ▸ !warn @user
┃ ▸ !unwarn @user
┃ ▸ !warns @user
┃ ▸ !antilink on/off
┃ ▸ !antimention on/off
┃ ▸ !stickerban @user [off]
┃ ▸ !mute <time>
┃ ▸ !unmute
┃ ▸ !setname <n>
┃ ▸ !setdesc <text>
┗━━━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━━━┓
┃  🎮 *FUN ZONE*
┣━━━━━━━━━━━━━━━━━━━┫
┃ ▸ !ping <text>
┃ ▸ !add <number>
┃ ▸ !rps <choice>
┃ ▸ !autotype <sec>
┃ ▸ !toimg (reply to sticker)
┃ ▸ !tosticker (reply to image)
┃ ▸ !waifu (fetch a random waifu)
┗━━━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━━━┓
┃  👑 *SUPERADMIN*
┣━━━━━━━━━━━━━━━━━━━┫
┃ ▸ !superadmin
┃ ▸ !promote @user
┃ ▸ !demote @user
┗━━━━━━━━━━━━━━━━━━━┛

⚡ *Powered by Clanka* ⚡
`.trim();
                        } else reply = '❓ Unknown command. Type !help';
                    }
                }
            } else {
                const context = msg.message.extendedTextMessage?.contextInfo;
                const replyParticipant = context?.participant ? (context.participant.includes('@') ? context.participant.split(':')[0] : context.participant) : null;
                const mentions = (context?.mentionedJid || []).map(j => j.includes('@') ? j.split(':')[0] : j);

                const isRepliedToBot = replyParticipant && (replyParticipant === rawBotJid || replyParticipant === botLid);
                const isMentioned = mentions.includes(rawBotJid) || mentions.includes(botLid);

                if (isRepliedToBot || isMentioned || !sender.endsWith('@g.us')) {
                    let cleanText = text;
                    if (rawBotJid) cleanText = cleanText.replace(new RegExp(`@${rawBotJid.split("@")[0]}`, 'g'), '');
                    if (botLid) cleanText = cleanText.replace(new RegExp(`@${botLid.split("@")[0]}`, 'g'), ''); cleanText = cleanText.trim();

                    const low = cleanText.toLowerCase();
                    const greetingMap = {
                        'hi': 'Hey there! 👋',
                        'hello': 'Greetings! 🤖',
                        'hey': 'Yo! What\'s up?',
                        'yo': 'Sup?',
                        'good morning': 'Good morning! ☀️',
                        'good night': 'Sleep tight! 🌙',
                        'howdy': 'Howdy partner! 🤠',
                        'sup': 'Not much, just botting around. You?',
                    };

                    const matchedGreeting = Object.keys(greetingMap).find(g => low === g || low.startsWith(g + ' ') || low.startsWith(g + '!'));
                    if (matchedGreeting) reply = greetingMap[matchedGreeting];
                    else if (low === 'help') reply = 'Commands:\n- Mention me for greetings\n- !help for list';
                    else reply = `I heard you! You said: "${text}"`;
                }
            }

            if (reply) {
                await sock.sendMessage(sender, { text: reply });
                console.log(`✅ Sent reply to ${sender}`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

console.log('🤖 WhatsApp Bot Starting...\n');
connectToWhatsApp().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
