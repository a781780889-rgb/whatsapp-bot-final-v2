import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { initDB, getDB, logEvent } from './database.js';
import { connectToWhatsApp, waEvents, disconnectSession } from './whatsapp.js';
import fs from 'fs';
import { createRequire } from 'module';
import multer from 'multer';
import { getLinkStats, importLinks, getLinks } from './linkManager.js';
import { startJoinTask, stopTask, pauseTask, getJoinStats, getJoinLogs } from './joinManager.js';
import { getAccountGroups, startGroupEditTask, stopGroupTask } from './groupManager.js';
import { startMentionTask, stopMentionTask, saveMentionTemplate, getMentionTemplates, deleteMentionTemplate } from './mentionManager.js';
import { startSearchTask, stopSearchTask, pauseSearchTask, getSearchStats, getSearchResults, getSearchTaskDetails, deleteSearchTask, updateSearchResultStatus, exportSearchResults } from './searchManager.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// API Routes
app.get('/api/accounts', async (req, res) => {
    const db = getDB();
    const accounts = await db.all('SELECT * FROM accounts ORDER BY created_at DESC');
    res.json(accounts);
});

app.post('/api/accounts', async (req, res) => {
    const { name, type } = req.body;
    const id = uuidv4();
    const db = getDB();
    await db.run(
        'INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)',
        [id, name, type || 'Messenger']
    );
    await logEvent(id, 'Account Created', `Account ${name} added to system`);
    connectToWhatsApp(id, io);
    res.json({ id, name, status: 'Connecting' });
});

app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const db = getDB();
    await disconnectSession(id);
    await db.run('DELETE FROM accounts WHERE id = ?', [id]);
    const sessionDir = path.join(process.env.SESSION_PATH || './sessions', id);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    res.json({ success: true });
});

app.post('/api/accounts/:id/reconnect', async (req, res) => {
    const { id } = req.params;
    connectToWhatsApp(id, io);
    res.json({ success: true });
});

app.get('/api/accounts/:id/backup', async (req, res) => {
    const { id } = req.params;
    const sessionDir = path.join(process.env.SESSION_PATH || './sessions', id);
    if (!fs.existsSync(sessionDir)) {
        return res.status(404).json({ error: 'Session not found' });
    }
    res.attachment(`session-${id}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    archive.directory(sessionDir, false);
    archive.finalize();
});

app.get('/api/stats', async (req, res) => {
    const db = getDB();
    const stats = await db.get(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'Connected' THEN 1 ELSE 0 END) as connected,
            SUM(CASE WHEN status = 'Disconnected' THEN 1 ELSE 0 END) as disconnected,
            SUM(CASE WHEN status = 'Waiting QR' THEN 1 ELSE 0 END) as waiting_qr,
            SUM(CASE WHEN type = 'Business' THEN 1 ELSE 0 END) as business,
            SUM(CASE WHEN type = 'Messenger' THEN 1 ELSE 0 END) as messenger
        FROM accounts
    `);
    res.json(stats || { total: 0, connected: 0, disconnected: 0, waiting_qr: 0, business: 0, messenger: 0 });
});

// Link Management API
app.get('/api/links/stats', async (req, res) => {
    try {
        const stats = await getLinkStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/links', async (req, res) => {
    try {
        if (req.query.export === 'true') {
            const db = getDB();
            let query = 'SELECT url, status, tags, created_at FROM links WHERE 1=1';
            const values = [];
            
            if (req.query.search) {
                query += ' AND (url LIKE ? OR tags LIKE ? OR notes LIKE ?)';
                const s = `%${req.query.search}%`;
                values.push(s, s, s);
            }
            if (req.query.status) {
                query += ' AND status = ?';
                values.push(req.query.status);
            }
            
            const links = await db.all(query, values);
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=links-export.csv');
            
            let csvContent = 'URL,Status,Tags,CreatedAt\n';
            links.forEach(link => {
                csvContent += `"${link.url}","${link.status}","${link.tags || ''}","${link.created_at}"\n`;
            });
            
            return res.send(csvContent);
        }
        
        const data = await getLinks(req.query);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/links/import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        importLinks(req.file, 'Admin', io);
        res.json({ message: 'Import started', filename: req.file.originalname });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/links/logs', async (req, res) => {
    const db = getDB();
    const logs = await db.all('SELECT * FROM link_operations ORDER BY timestamp DESC LIMIT 100');
    res.json(logs);
});

app.delete('/api/links/:id', async (req, res) => {
    const db = getDB();
    await db.run('DELETE FROM links WHERE id = ?', [req.params.id]);
    res.json({ success: true });
});

app.patch('/api/links/:id', async (req, res) => {
    const { status, tags, notes } = req.body;
    const db = getDB();
    await db.run(
        'UPDATE links SET status = ?, tags = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, tags, notes, req.params.id]
    );
    res.json({ success: true });
});

// Join Links API
app.get('/api/join/stats', async (req, res) => {
    try {
        const stats = await getJoinStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/join/start', async (req, res) => {
    try {
        const result = await startJoinTask(req.body, io);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/join/stop/:taskId', async (req, res) => {
    try {
        const success = stopTask(req.params.taskId);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/join/pause/:taskId', async (req, res) => {
    try {
        const result = pauseTask(req.params.taskId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/join/logs', async (req, res) => {
    try {
        const logs = await getJoinLogs();
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/join/logs', async (req, res) => {
    const db = getDB();
    await db.run('DELETE FROM join_logs');
    res.json({ success: true });
});

app.post('/api/join/reset', async (req, res) => {
    const db = getDB();
    await db.run("UPDATE links SET join_status = 'Pending' WHERE join_status != 'Joined'");
    res.json({ success: true });
});

// Group Management API
app.get('/api/groups/:accountId', async (req, res) => {
    try {
        const groups = await getAccountGroups(req.params.accountId);
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/groups/edit', async (req, res) => {
    try {
        const result = await startGroupEditTask(req.body, io);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/groups/stop/:taskId', async (req, res) => {
    try {
        const success = stopGroupTask(req.params.taskId);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Mention Management API
app.post('/api/mentions/start', async (req, res) => {
    try {
        const result = await startMentionTask(req.body, io);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mentions/stop/:taskId', async (req, res) => {
    try {
        const success = stopMentionTask(req.params.taskId);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/mentions/templates', async (req, res) => {
    try {
        const templates = await getMentionTemplates();
        res.json(templates);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mentions/templates', async (req, res) => {
    try {
        const { name, content } = req.body;
        const result = await saveMentionTemplate(name, content);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/mentions/templates/:id', async (req, res) => {
    try {
        await deleteMentionTemplate(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/mentions/logs', async (req, res) => {
    const db = getDB();
    const logs = await db.all('SELECT * FROM mention_logs ORDER BY timestamp DESC LIMIT 100');
    res.json(logs);
});

// Search Links API
app.post('/api/search/start', async (req, res) => {
    try {
        const result = await startSearchTask(req.body, io);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/search/stop/:taskId', async (req, res) => {
    try {
        const success = stopSearchTask(req.params.taskId);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/search/pause/:taskId', async (req, res) => {
    try {
        const result = pauseSearchTask(req.params.taskId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/stats', async (req, res) => {
    try {
        const stats = await getSearchStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/results', async (req, res) => {
    try {
        const results = await getSearchResults(req.query);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/task/:taskId', async (req, res) => {
    try {
        const details = await getSearchTaskDetails(req.params.taskId);
        res.json(details);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/search/task/:taskId', async (req, res) => {
    try {
        const result = await deleteSearchTask(req.params.taskId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/search/result/:resultId', async (req, res) => {
    try {
        const { joinStatus } = req.body;
        const result = await updateSearchResultStatus(req.params.resultId, joinStatus);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/export/:taskId', async (req, res) => {
    try {
        const format = req.query.format || 'json';
        const data = await exportSearchResults(req.params.taskId, format);
        
        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=search-results.csv');
            res.send(data);
        } else {
            res.json(data);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('Client connected');
});

waEvents.on('qr', (data) => {
    io.emit('qr', data);
});

waEvents.on('status', (data) => {
    io.emit('status', data);
});

const PORT = process.env.PORT || 3000;

async function start() {
    await initDB();
    console.log('Database initialized');

    const db = getDB();
    const accounts = await db.all('SELECT id FROM accounts');
    for (const account of accounts) {
        connectToWhatsApp(account.id, io);
    }

    httpServer.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
});
