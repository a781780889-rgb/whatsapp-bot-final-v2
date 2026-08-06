import { getDB, logEvent } from './database.js';
import { getSession } from './whatsapp.js';
import { v4 as uuidv4 } from 'uuid';

let activeTasks = new Map();

// URL detection regex patterns
const URL_PATTERNS = {
    whatsapp_group: /https?:\/\/(www\.)?chat\.whatsapp\.com\/[a-zA-Z0-9]+/gi,
    whatsapp_channel: /https?:\/\/(www\.)?whatsapp\.com\/channel\/[a-zA-Z0-9]+/gi,
    telegram: /https?:\/\/(www\.)?t\.me\/[a-zA-Z0-9_]+/gi,
    discord: /https?:\/\/(www\.)?discord\.(gg|com\/invite)\/[a-zA-Z0-9]+/gi,
    facebook: /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9._\-]+/gi,
    twitter: /https?:\/\/(www\.)?twitter\.com\/[a-zA-Z0-9_]+/gi,
    instagram: /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+/gi,
    youtube: /https?:\/\/(www\.)?youtube\.com\/[a-zA-Z0-9_\-]+/gi,
    tiktok: /https?:\/\/(www\.)?tiktok\.com\/@[a-zA-Z0-9._\-]+/gi,
    shortlink: /https?:\/\/(bit\.ly|tinyurl\.com|short\.link|ow\.ly|goo\.gl|is\.gd)\/[a-zA-Z0-9]+/gi,
    generic: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi
};

function detectLinkType(url) {
    for (const [type, pattern] of Object.entries(URL_PATTERNS)) {
        if (type === 'generic') continue;
        if (pattern.test(url)) {
            pattern.lastIndex = 0;
            return type;
        }
    }
    return 'generic';
}

function normalizeUrl(url) {
    try {
        url = url.trim().replace(/\/$/, '');
        if (url.includes('whatsapp.com') || url.includes('t.me') || url.includes('discord')) {
            url = url.toLowerCase();
        }
        return url;
    } catch {
        return url;
    }
}

function extractUrls(text) {
    if (!text) return [];
    const urls = new Set();
    
    for (const pattern of Object.values(URL_PATTERNS)) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const url = normalizeUrl(match[0]);
            if (url && url.length > 10) {
                urls.add(url);
            }
        }
    }
    
    return Array.from(urls);
}

export async function startSearchTask(options, io) {
    const {
        accountIds,
        scanType = 'Normal',
        timePeriod = 'all',
        startDate = null,
        endDate = null
    } = options;

    if (!accountIds || accountIds.length === 0) {
        return { error: 'No accounts selected' };
    }

    const taskId = uuidv4();
    const db = getDB();

    const task = {
        id: taskId,
        accountIds,
        scanType,
        timePeriod,
        startDate,
        endDate,
        currentAccountIndex: 0,
        currentGroupIndex: 0,
        status: 'Running',
        paused: false,
        stopRequested: false,
        stats: {
            totalGroups: 0,
            completedGroups: 0,
            messagesScanned: 0,
            linksFound: 0,
            newLinks: 0,
            duplicateLinks: 0,
            errors: 0,
            startTime: Date.now()
        },
        currentAccount: null,
        currentGroup: null
    };

    activeTasks.set(taskId, task);

    // Save task to database
    await db.run(
        `INSERT INTO search_tasks 
        (id, status, account_ids, scan_type, time_period, start_date, end_date, stats_total_groups, stats_completed_groups, stats_messages_scanned, stats_links_found, stats_new_links, stats_duplicate_links, stats_errors)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, 'Running', JSON.stringify(accountIds), scanType, timePeriod, startDate, endDate, 0, 0, 0, 0, 0, 0, 0]
    );

    await logEvent(null, 'Search Task Started', { taskId, accountIds, scanType });

    // Start processing asynchronously
    processSearchTask(taskId, io).catch(err => console.error('Search task error:', err));

    return { taskId, message: 'Search task started' };
}

async function processSearchTask(taskId, io) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const db = getDB();
    const io_emit = (event, data) => io.emit(`search-task-${event}`, { taskId, ...data });

    try {
        for (let accountIdx = 0; accountIdx < task.accountIds.length && !task.stopRequested; accountIdx++) {
            if (task.paused) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                accountIdx--;
                continue;
            }

            const accountId = task.accountIds[accountIdx];
            task.currentAccountIndex = accountIdx;
            task.currentAccount = accountId;

            const sock = getSession(accountId);
            if (!sock) {
                task.stats.errors++;
                io_emit('error', { accountId, message: 'Account not connected' });
                continue;
            }

            try {
                // Get all groups for this account
                const groups = await sock.groupFetchAllParticipating();
                const groupIds = Object.keys(groups);
                task.stats.totalGroups += groupIds.length;

                io_emit('status', {
                    currentAccount: accountId,
                    totalGroups: groupIds.length,
                    stats: task.stats
                });

                for (let groupIdx = 0; groupIdx < groupIds.length && !task.stopRequested; groupIdx++) {
                    if (task.paused) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        groupIdx--;
                        continue;
                    }

                    const groupId = groupIds[groupIdx];
                    const group = groups[groupId];
                    task.currentGroupIndex = groupIdx;
                    task.currentGroup = group.subject;

                    io_emit('progress', {
                        currentAccount: accountId,
                        currentGroup: group.subject,
                        groupProgress: `${groupIdx + 1}/${groupIds.length}`,
                        stats: task.stats
                    });

                    try {
                        // Get messages from group
                        const messages = await getGroupMessages(sock, groupId, task.scanType, task.timePeriod, task.startDate, task.endDate);

                        for (const msg of messages) {
                            if (task.stopRequested) break;

                            task.stats.messagesScanned++;

                            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                            if (!text) continue;

                            const urls = extractUrls(text);
                            for (const url of urls) {
                                if (task.stopRequested) break;

                                const linkType = detectLinkType(url);
                                const resultId = uuidv4();

                                // Check if URL already exists in this task
                                const existing = await db.get(
                                    'SELECT id, occurrence_count FROM search_results WHERE task_id = ? AND url = ?',
                                    [taskId, url]
                                );

                                if (existing) {
                                    // Update existing record
                                    await db.run(
                                        `UPDATE search_results 
                                        SET occurrence_count = occurrence_count + 1, 
                                            last_found_at = CURRENT_TIMESTAMP,
                                            accounts_found_in = CASE 
                                                WHEN accounts_found_in LIKE ? THEN accounts_found_in
                                                ELSE accounts_found_in || ',' || ?
                                            END,
                                            groups_found_in = CASE 
                                                WHEN groups_found_in LIKE ? THEN groups_found_in
                                                ELSE groups_found_in || ',' || ?
                                            END,
                                            updated_at = CURRENT_TIMESTAMP
                                        WHERE id = ?`,
                                        [`%${accountId}%`, accountId, `%${group.subject}%`, group.subject, existing.id]
                                    );
                                    task.stats.duplicateLinks++;
                                } else {
                                    // Insert new record
                                    await db.run(
                                        `INSERT INTO search_results 
                                        (id, task_id, url, link_type, account_id, group_id, group_name, message_id, message_text, occurrence_count, accounts_found_in, groups_found_in)
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [resultId, taskId, url, linkType, accountId, groupId, group.subject, msg.key.id, text.substring(0, 200), 1, accountId, group.subject]
                                    );
                                    task.stats.newLinks++;
                                    task.stats.linksFound++;

                                    io_emit('link-found', {
                                        url,
                                        linkType,
                                        group: group.subject,
                                        account: accountId
                                    });
                                }
                            }
                        }

                        task.stats.completedGroups++;

                        // Log operation
                        await db.run(
                            `INSERT INTO search_operations_log 
                            (task_id, operation, account_id, group_id, group_name, message_count, links_found, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [taskId, 'Group Scan', accountId, groupId, group.subject, messages.length, urls.length, 'Completed']
                        );

                    } catch (groupError) {
                        task.stats.errors++;
                        console.error(`Error scanning group ${group.subject}:`, groupError);
                        
                        await db.run(
                            `INSERT INTO search_operations_log 
                            (task_id, operation, account_id, group_id, group_name, status, error_message)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [taskId, 'Group Scan', accountId, groupId, group.subject, 'Failed', groupError.message]
                        );
                    }

                    // Small delay between groups
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } catch (accountError) {
                task.stats.errors++;
                console.error(`Error processing account ${accountId}:`, accountError);
                io_emit('error', { accountId, message: accountError.message });
            }

            // Delay between accounts
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Task completed
        task.status = task.stopRequested ? 'Stopped' : 'Completed';
        const duration = Math.round((Date.now() - task.stats.startTime) / 1000);

        await db.run(
            `UPDATE search_tasks 
            SET status = ?, completed_at = CURRENT_TIMESTAMP, 
                stats_total_groups = ?, stats_completed_groups = ?, 
                stats_messages_scanned = ?, stats_links_found = ?, 
                stats_new_links = ?, stats_duplicate_links = ?, stats_errors = ?
            WHERE id = ?`,
            [task.status, task.stats.totalGroups, task.stats.completedGroups, 
             task.stats.messagesScanned, task.stats.linksFound, 
             task.stats.newLinks, task.stats.duplicateLinks, task.stats.errors, taskId]
        );

        io_emit('finished', {
            status: task.status,
            stats: task.stats,
            duration
        });

        await logEvent(null, 'Search Task Completed', { taskId, stats: task.stats, duration });

    } catch (error) {
        console.error('Fatal search task error:', error);
        task.status = 'Failed';
        
        await db.run(
            'UPDATE search_tasks SET status = ? WHERE id = ?',
            ['Failed', taskId]
        );

        io_emit('error', { message: error.message });
    }

    activeTasks.delete(taskId);
}

async function getGroupMessages(sock, groupId, scanType, timePeriod, startDate, endDate) {
    try {
        const messages = [];
        let limit = 50; // Default for Normal scan

        if (scanType === 'Medium') limit = 150;
        if (scanType === 'Deep') limit = 500;

        // Fetch messages from group using Baileys store
        let allMessages = [];
        try {
            // Access messages from the store
            const store = sock.store;
            if (store && store.messages && store.messages[groupId]) {
                allMessages = Object.values(store.messages[groupId]).slice(0, limit);
            }
        } catch (e) {
            console.warn('Could not fetch messages from store:', e.message);
            return [];
        }

        if (allMessages.length === 0) {
            return [];
        }

        // Filter by time period if needed
        for (const msg of allMessages) {
            if (!msg.messageTimestamp) continue;

            const msgTime = new Date(msg.messageTimestamp * 1000);
            let include = true;

            if (timePeriod !== 'all') {
                const now = new Date();
                let cutoffDate;

                switch (timePeriod) {
                    case 'today':
                        cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                        break;
                    case '3days':
                        cutoffDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
                        break;
                    case 'week':
                        cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                        break;
                    case 'month':
                        cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                        break;
                    case 'year':
                        cutoffDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                        break;
                    case 'custom':
                        if (startDate) cutoffDate = new Date(startDate);
                        if (endDate && msgTime > new Date(endDate)) include = false;
                        break;
                }

                if (cutoffDate && msgTime < cutoffDate) include = false;
            }

            if (include) {
                messages.push(msg);
            }
        }

        return messages;
    } catch (error) {
        console.error('Error fetching group messages:', error);
        return [];
    }
}

export function stopSearchTask(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
        task.stopRequested = true;
        return true;
    }
    return false;
}

export function pauseSearchTask(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
        task.paused = !task.paused;
        return { paused: task.paused };
    }
    return null;
}

export async function getSearchStats() {
    const db = getDB();
    const stats = await db.get(`
        SELECT 
            COUNT(*) as total_tasks,
            SUM(CASE WHEN status = 'Running' THEN 1 ELSE 0 END) as running_tasks,
            SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_tasks,
            SUM(CASE WHEN status = 'Stopped' THEN 1 ELSE 0 END) as stopped_tasks,
            SUM(stats_links_found) as total_links_found,
            SUM(stats_new_links) as total_new_links
        FROM search_tasks
    `);
    return stats || { total_tasks: 0, running_tasks: 0, completed_tasks: 0, stopped_tasks: 0, total_links_found: 0, total_new_links: 0 };
}

export async function getSearchResults(filters = {}) {
    const db = getDB();
    let query = 'SELECT * FROM search_results WHERE 1=1';
    const values = [];

    if (filters.taskId) {
        query += ' AND task_id = ?';
        values.push(filters.taskId);
    }

    if (filters.linkType) {
        query += ' AND link_type = ?';
        values.push(filters.linkType);
    }

    if (filters.accountId) {
        query += ' AND account_id = ?';
        values.push(filters.accountId);
    }

    if (filters.search) {
        query += ' AND (url LIKE ? OR group_name LIKE ?)';
        const searchTerm = `%${filters.search}%`;
        values.push(searchTerm, searchTerm);
    }

    if (filters.joinStatus) {
        query += ' AND join_status = ?';
        values.push(filters.joinStatus);
    }

    query += ' ORDER BY last_found_at DESC LIMIT 1000';

    return await db.all(query, values);
}

export async function getSearchTaskDetails(taskId) {
    const db = getDB();
    const task = await db.get('SELECT * FROM search_tasks WHERE id = ?', [taskId]);
    const results = await db.all('SELECT * FROM search_results WHERE task_id = ? ORDER BY last_found_at DESC', [taskId]);
    const logs = await db.all('SELECT * FROM search_operations_log WHERE task_id = ? ORDER BY timestamp DESC', [taskId]);

    return { task, results, logs };
}

export async function deleteSearchTask(taskId) {
    const db = getDB();
    await db.run('DELETE FROM search_tasks WHERE id = ?', [taskId]);
    return { success: true };
}

export async function updateSearchResultStatus(resultId, joinStatus) {
    const db = getDB();
    await db.run(
        'UPDATE search_results SET join_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [joinStatus, resultId]
    );
    return { success: true };
}

export async function exportSearchResults(taskId, format = 'json') {
    const db = getDB();
    const results = await db.all(
        'SELECT url, link_type, group_name, account_id, occurrence_count, join_status, first_found_at FROM search_results WHERE task_id = ? ORDER BY last_found_at DESC',
        [taskId]
    );

    if (format === 'csv') {
        let csv = 'URL,Type,Group,Account,Count,Status,Found Date\n';
        results.forEach(r => {
            csv += `"${r.url}","${r.link_type}","${r.group_name}","${r.account_id}",${r.occurrence_count},"${r.join_status}","${r.first_found_at}"\n`;
        });
        return csv;
    }

    return results;
}
