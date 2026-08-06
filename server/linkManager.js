import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import * as XLSX from 'xlsx';
import { getDB } from './database.js';

export async function getLinkStats() {
    const db = getDB();
    const stats = await db.get(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN created_at >= date('now', '-1 day') THEN 1 ELSE 0 END) as new_links,
            SUM(duplicate_count) as total_duplicates,
            SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) as inactive,
            (SELECT COUNT(*) FROM files) as file_count,
            (SELECT MAX(created_at) FROM links) as last_update,
            (SELECT MAX(timestamp) FROM link_operations WHERE operation = 'Import') as last_import
        FROM links
    `);
    
    // Fallback for nulls
    return {
        total: stats.total || 0,
        new_links: stats.new_links || 0,
        duplicates: stats.total_duplicates || 0,
        active: stats.active || 0,
        inactive: stats.inactive || 0,
        file_count: stats.file_count || 0,
        last_update: stats.last_update || 'N/A',
        last_import: stats.last_import || 'N/A'
    };
}

export async function importLinks(file, user = 'Admin', io) {
    const db = getDB();
    const fileId = uuidv4();
    const startTime = Date.now();
    
    // Create file record
    await db.run(
        'INSERT INTO files (id, filename, original_name, type, size, status) VALUES (?, ?, ?, ?, ?, ?)',
        [fileId, file.filename, file.originalname, file.mimetype, file.size, 'Processing']
    );

    let links = [];
    const ext = path.extname(file.originalname).toLowerCase();
    
    try {
        if (ext === '.txt') {
            const content = fs.readFileSync(file.path, 'utf8');
            links = content.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
        } else if (ext === '.csv') {
            links = await new Promise((resolve) => {
                const results = [];
                fs.createReadStream(file.path)
                    .pipe(csv())
                    .on('data', (data) => {
                        const val = Object.values(data)[0];
                        if (val) results.push(val.trim());
                    })
                    .on('end', () => resolve(results));
            });
        } else if (ext === '.json') {
            const content = fs.readFileSync(file.path, 'utf8');
            const data = JSON.parse(content);
            links = Array.isArray(data) ? data : (data.links || []);
        } else if (ext === '.xlsx' || ext === '.xls') {
            const workbook = XLSX.readFile(file.path);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            links = data.flat().map(v => String(v).trim()).filter(v => v.length > 0);
        }

        let newCount = 0;
        let dupCount = 0;
        let errCount = 0;
        
        // Process links one by one for deduplication
        for (let i = 0; i < links.length; i++) {
            const url = links[i];
            try {
                const existing = await db.get('SELECT id, view_count FROM links WHERE url = ?', [url]);
                if (existing) {
                    await db.run('UPDATE links SET view_count = view_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [existing.id]);
                    dupCount++;
                } else {
                    await db.run(
                        'INSERT INTO links (id, url, file_id) VALUES (?, ?, ?)',
                        [uuidv4(), url, fileId]
                    );
                    newCount++;
                }
            } catch (e) {
                errCount++;
            }
            
            // Progress update via WebSocket every 100 links
            if (i % 100 === 0 || i === links.length - 1) {
                io.emit('import-progress', {
                    fileId,
                    progress: Math.round(((i + 1) / links.length) * 100),
                    newCount,
                    dupCount,
                    errCount
                });
            }
        }

        const duration = Date.now() - startTime;
        await db.run(
            'UPDATE files SET status = ?, link_count = ?, duplicate_count = ?, error_count = ?, duration = ? WHERE id = ?',
            ['Completed', newCount, dupCount, errCount, duration, fileId]
        );

        await db.run(
            'INSERT INTO link_operations (user, operation, filename, link_count, duplicate_count, result) VALUES (?, ?, ?, ?, ?, ?)',
            [user, 'Import', file.originalname, newCount, dupCount, 'Success']
        );

        return { fileId, newCount, dupCount, errCount };
    } catch (error) {
        await db.run('UPDATE files SET status = ? WHERE id = ?', ['Error', fileId]);
        await db.run(
            'INSERT INTO link_operations (user, operation, filename, result, errors) VALUES (?, ?, ?, ?, ?)',
            [user, 'Import', file.originalname, 'Failed', error.message]
        );
        throw error;
    }
}

export async function getLinks(params) {
    const { page = 1, limit = 50, search = '', status = '', fileId = '', type = '' } = params;
    const offset = (page - 1) * limit;
    const db = getDB();
    
    let query = 'SELECT * FROM links WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM links WHERE 1=1';
    const values = [];
    
    if (search) {
        query += ' AND (url LIKE ? OR tags LIKE ? OR notes LIKE ?)';
        countQuery += ' AND (url LIKE ? OR tags LIKE ? OR notes LIKE ?)';
        const s = `%${search}%`;
        values.push(s, s, s);
    }
    
    if (status) {
        query += ' AND status = ?';
        countQuery += ' AND status = ?';
        values.push(status);
    }
    
    if (fileId) {
        query += ' AND file_id = ?';
        countQuery += ' AND file_id = ?';
        values.push(fileId);
    }
    
    if (type) {
        query += ' AND type = ?';
        countQuery += ' AND type = ?';
        values.push(type);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const countValues = [...values];
    values.push(limit, offset);
    
    const rows = await db.all(query, values);
    const total = await db.get(countQuery, countValues);
    
    return {
        links: rows,
        total: total.total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total.total / limit)
    };
}
