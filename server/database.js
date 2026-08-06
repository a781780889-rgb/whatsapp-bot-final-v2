import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH || './database/panel.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;

export async function initDB() {
    const SQL = await initSqlJs();
    if (fs.existsSync(dbPath)) {
        const data = fs.readFileSync(dbPath);
        db = new SQL.Database(data);
    } else {
        db = new SQL.Database();
    }

    db.run(`CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        type TEXT DEFAULT 'Messenger',
        status TEXT DEFAULT 'Disconnected',
        whatsapp_name TEXT,
        device_name TEXT,
        wa_version TEXT,
        country TEXT,
        country_code TEXT,
        last_connected TEXT,
        connection_duration INTEGER DEFAULT 0,
        reconnect_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        tags TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_activity TEXT,
        session_path TEXT,
        backup_path TEXT,
        join_success_count INTEGER DEFAULT 0,
        join_failure_count INTEGER DEFAULT 0,
        total_groups_count INTEGER DEFAULT 0,
        max_groups_limit INTEGER DEFAULT 256
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        event TEXT NOT NULL,
        details TEXT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        filename TEXT NOT NULL,
        type TEXT DEFAULT 'Manual',
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Link Management Tables
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_name TEXT,
        type TEXT,
        size INTEGER,
        status TEXT DEFAULT 'Completed',
        link_count INTEGER DEFAULT 0,
        duplicate_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS links (
        id TEXT PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        type TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        file_id TEXT,
        tags TEXT,
        notes TEXT,
        status TEXT DEFAULT 'Active',
        view_count INTEGER DEFAULT 0,
        group_name TEXT,
        last_attempt TEXT,
        last_account_id TEXT,
        attempts_count INTEGER DEFAULT 0,
        join_date TEXT,
        join_status TEXT DEFAULT 'Pending',
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE SET NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS link_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT DEFAULT 'Admin',
        operation TEXT NOT NULL,
        filename TEXT,
        link_count INTEGER DEFAULT 0,
        duplicate_count INTEGER DEFAULT 0,
        result TEXT,
        errors TEXT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS join_logs (
	        id INTEGER PRIMARY KEY AUTOINCREMENT,
	        operation_id TEXT,
	        account_id TEXT,
	        link_id TEXT,
	        url TEXT,
	        result TEXT,
	        reason TEXT,
	        duration INTEGER,
	        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
	    )`);

	    db.run(`CREATE TABLE IF NOT EXISTS mention_templates (
	        id TEXT PRIMARY KEY,
	        name TEXT NOT NULL,
	        content TEXT NOT NULL,
	        created_at TEXT DEFAULT CURRENT_TIMESTAMP
	    )`);

	    db.run(`CREATE TABLE IF NOT EXISTS mention_logs (
	        id INTEGER PRIMARY KEY AUTOINCREMENT,
	        task_id TEXT,
	        account_id TEXT,
	        group_id TEXT,
	        group_name TEXT,
	        status TEXT,
	        mention_count INTEGER,
	        error TEXT,
	        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
	    )`);

    save();
    return getDB();
}

function save() {
    try {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (e) {}
}

export function getDB() {
    return {
        all: async (sql, params = []) => {
            const stmt = db.prepare(sql);
            const rows = [];
            stmt.bind(params);
            while (stmt.step()) rows.push(stmt.getAsObject());
            stmt.free();
            return rows;
        },
        get: async (sql, params = []) => {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            const row = stmt.step() ? stmt.getAsObject() : null;
            stmt.free();
            return row;
        },
        run: async (sql, params = []) => {
            db.run(sql, params);
            save();
        },
        exec: async (sql) => {
            db.run(sql);
            save();
        }
    };
}

export async function logEvent(accountId, event, details) {
    if (!db) return;
    db.run(
        'INSERT INTO audit_logs (account_id, event, details) VALUES (?, ?, ?)',
        [accountId, event, typeof details === 'object' ? JSON.stringify(details) : details]
    );
    save();
}
