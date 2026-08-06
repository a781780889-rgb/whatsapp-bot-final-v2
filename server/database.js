import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.internal')
        ? false
        : { rejectUnauthorized: false }
});

export async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS accounts (
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
        await client.query(`CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            account_id TEXT,
            event TEXT NOT NULL,
            details TEXT,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS backups (
            id SERIAL PRIMARY KEY,
            account_id TEXT,
            filename TEXT NOT NULL,
            type TEXT DEFAULT 'Manual',
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS files (
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
        await client.query(`CREATE TABLE IF NOT EXISTS links (
            id TEXT PRIMARY KEY,
            url TEXT UNIQUE NOT NULL,
            type TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
            tags TEXT,
            notes TEXT,
            status TEXT DEFAULT 'Active',
            view_count INTEGER DEFAULT 0,
            group_name TEXT,
            last_attempt TEXT,
            last_account_id TEXT,
            attempts_count INTEGER DEFAULT 0,
            join_date TEXT,
            join_status TEXT DEFAULT 'Pending'
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS link_operations (
            id SERIAL PRIMARY KEY,
            "user" TEXT DEFAULT 'Admin',
            operation TEXT NOT NULL,
            filename TEXT,
            link_count INTEGER DEFAULT 0,
            duplicate_count INTEGER DEFAULT 0,
            result TEXT,
            errors TEXT,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS join_logs (
            id SERIAL PRIMARY KEY,
            operation_id TEXT,
            account_id TEXT,
            link_id TEXT,
            url TEXT,
            result TEXT,
            reason TEXT,
            duration INTEGER,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS mention_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS mention_logs (
            id SERIAL PRIMARY KEY,
            task_id TEXT,
            account_id TEXT,
            group_id TEXT,
            group_name TEXT,
            status TEXT,
            mention_count INTEGER,
            error TEXT,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS search_tasks (
            id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'Running',
            account_ids TEXT NOT NULL,
            scan_type TEXT DEFAULT 'Normal',
            time_period TEXT DEFAULT 'all',
            start_date TEXT,
            end_date TEXT,
            current_account_index INTEGER DEFAULT 0,
            current_group_index INTEGER DEFAULT 0,
            paused BOOLEAN DEFAULT false,
            stop_requested BOOLEAN DEFAULT false,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            stats_total_groups INTEGER DEFAULT 0,
            stats_completed_groups INTEGER DEFAULT 0,
            stats_messages_scanned INTEGER DEFAULT 0,
            stats_links_found INTEGER DEFAULT 0,
            stats_new_links INTEGER DEFAULT 0,
            stats_duplicate_links INTEGER DEFAULT 0,
            stats_errors INTEGER DEFAULT 0,
            created_by TEXT DEFAULT 'Admin',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS search_results (
            id TEXT PRIMARY KEY,
            task_id TEXT REFERENCES search_tasks(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            link_type TEXT,
            account_id TEXT,
            group_id TEXT,
            group_name TEXT,
            message_id TEXT,
            message_text TEXT,
            occurrence_count INTEGER DEFAULT 1,
            first_found_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_found_at TEXT DEFAULT CURRENT_TIMESTAMP,
            accounts_found_in TEXT,
            groups_found_in TEXT,
            join_status TEXT DEFAULT 'Not Joined',
            is_valid BOOLEAN DEFAULT true,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(task_id, url)
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS search_operations_log (
            id SERIAL PRIMARY KEY,
            task_id TEXT REFERENCES search_tasks(id) ON DELETE CASCADE,
            operation TEXT NOT NULL,
            account_id TEXT,
            group_id TEXT,
            group_name TEXT,
            message_count INTEGER DEFAULT 0,
            links_found INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Processing',
            error_message TEXT,
            duration INTEGER,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_search_results_url ON search_results(url)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_search_results_task_id ON search_results(task_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_search_results_link_type ON search_results(link_type)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_search_results_account_id ON search_results(account_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_search_tasks_status ON search_tasks(status)`);
    } finally {
        client.release();
    }
    return getDB();
}

export function getDB() {
    return {
        all: async (sql, params = []) => {
            let i = 0;
            const pgSql = sql.replace(/\?/g, () => `$${++i}`);
            const result = await pool.query(pgSql, params);
            return result.rows;
        },
        get: async (sql, params = []) => {
            let i = 0;
            const pgSql = sql.replace(/\?/g, () => `$${++i}`);
            const result = await pool.query(pgSql, params);
            return result.rows[0] || null;
        },
        run: async (sql, params = []) => {
            let i = 0;
            const pgSql = sql.replace(/\?/g, () => `$${++i}`);
            await pool.query(pgSql, params);
        },
        exec: async (sql) => {
            await pool.query(sql);
        }
    };
}

export async function logEvent(accountId, event, details) {
    try {
        await pool.query(
            'INSERT INTO audit_logs (account_id, event, details) VALUES ($1, $2, $3)',
            [accountId, event, typeof details === 'object' ? JSON.stringify(details) : details]
        );
    } catch (e) {
        console.error('logEvent error:', e.message);
    }
}
