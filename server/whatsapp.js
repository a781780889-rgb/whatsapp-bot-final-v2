import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { getDB, logEvent } from './database.js';
import { EventEmitter } from 'events';

const logger = pino({ level: 'silent' });
const sessions = new Map();
export const waEvents = new EventEmitter();

export async function connectToWhatsApp(accountId, io) {
    const db = getDB();
    const account = await db.get('SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!account) return;

    const sessionDir = path.join(process.env.SESSION_PATH || './sessions', accountId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: [account.name, account.type === 'Business' ? 'Safari' : 'Chrome', '1.0.0']
    });

    sessions.set(accountId, sock);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            waEvents.emit('qr', { accountId, qr });
            await db.run('UPDATE accounts SET status = ? WHERE id = ?', ['Waiting QR', accountId]);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed for', accountId, 'reconnecting:', shouldReconnect);

            await db.run('UPDATE accounts SET status = ? WHERE id = ?', ['Disconnected', accountId]);
            waEvents.emit('status', { accountId, status: 'Disconnected' });

            if (shouldReconnect) {
                await db.run('UPDATE accounts SET reconnect_count = reconnect_count + 1 WHERE id = ?', [accountId]);
                setTimeout(() => connectToWhatsApp(accountId, io), 5000);
            } else {
                sessions.delete(accountId);
                await logEvent(accountId, 'Logout', 'User logged out or session expired');
            }
        } else if (connection === 'open') {
            console.log('Opened connection for', accountId);
            const user = sock.user;
            const phone = user.id.split(':')[0];
            const countryCode = phone.substring(0, 2);
            await db.run(
                'UPDATE accounts SET status = ?, phone = ?, whatsapp_name = ?, last_connected = ?, country_code = ? WHERE id = ?',
                ['Connected', phone, user.name || account.name, new Date().toISOString(), countryCode, accountId]
            );
            waEvents.emit('status', { accountId, status: 'Connected', user });
            await logEvent(accountId, 'Connection Success', 'Account connected successfully');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

export function getSession(accountId) {
    return sessions.get(accountId);
}

export async function disconnectSession(accountId) {
    const sock = sessions.get(accountId);
    if (sock) {
        try {
            await sock.logout();
        } catch (e) {}
        sessions.delete(accountId);
    }
}
