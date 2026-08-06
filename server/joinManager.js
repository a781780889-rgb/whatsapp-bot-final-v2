import { getDB } from './database.js';
import { getSession } from './whatsapp.js';
import { v4 as uuidv4 } from 'uuid';

let activeTasks = new Map();

export async function startJoinTask(options, io) {
    const { accountIds, linkSource, minDelay, maxDelay, autoRestart } = options;
    const taskId = uuidv4();
    const db = getDB();

    let links = [];
    if (linkSource === 'database') {
        links = await db.all("SELECT * FROM links WHERE join_status = 'Pending' AND status = 'Active'");
    }

    if (links.length === 0) return { error: 'No links found to join' };

    const task = {
        id: taskId,
        accountIds,
        links,
        currentIndex: 0,
        status: 'Running',
        stats: {
            total: links.length,
            success: 0,
            failed: 0,
            alreadyJoined: 0,
            invalid: 0,
            errors: 0,
            startTime: Date.now()
        },
        minDelay: parseInt(minDelay) || 30,
        maxDelay: parseInt(maxDelay) || 60,
        autoRestart: !!autoRestart,
        stopRequested: false,
        paused: false
    };

    activeTasks.set(taskId, task);
    processTask(taskId, io);

    return { taskId, total: links.length };
}

async function processTask(taskId, io) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const db = getDB();
    const io_emit = (event, data) => io.emit(`join-task-${event}`, { taskId, ...data });

    while (task.currentIndex < task.links.length && !task.stopRequested) {
        // Handle Pause
        if (task.paused) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }

        const link = task.links[task.currentIndex];
        const accountId = task.accountIds[task.currentIndex % task.accountIds.length];
        const sock = getSession(accountId);

        if (!sock) {
            task.stats.errors++;
            io_emit('error', { accountId, message: 'Account not connected' });
            task.currentIndex++;
            continue;
        }

        try {
            io_emit('status', { 
                currentIndex: task.currentIndex, 
                currentLink: link.url, 
                accountId,
                stats: task.stats
            });

            const code = link.url.split('chat.whatsapp.com/')[1];
            if (!code) throw new Error('Invalid invite link');

            const startTime = Date.now();
            let result, reason;

            try {
                await sock.groupAcceptInvite(code);
                result = 'Joined';
                task.stats.success++;
                await db.run('UPDATE accounts SET join_success_count = join_success_count + 1, total_groups_count = total_groups_count + 1 WHERE id = ?', [accountId]);
            } catch (err) {
                reason = err.message;
                if (reason.includes('409') || reason.includes('already-exists')) {
                    result = 'Already Joined';
                    task.stats.alreadyJoined++;
                } else if (reason.includes('404') || reason.includes('not-found')) {
                    result = 'Invalid';
                    task.stats.invalid++;
                } else if (reason.includes('403') || reason.includes('forbidden')) {
                    result = 'Expired';
                    task.stats.failed++;
                } else {
                    result = 'Failed';
                    task.stats.failed++;
                }
            }

            const duration = Date.now() - startTime;
            await db.run(
                'INSERT INTO join_logs (operation_id, account_id, link_id, url, result, reason, duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [taskId, accountId, link.id, link.url, result, reason || '', duration]
            );

            await db.run(
                'UPDATE links SET join_status = ?, last_attempt = CURRENT_TIMESTAMP, last_account_id = ?, attempts_count = attempts_count + 1, join_date = ? WHERE id = ?',
                [result, accountId, result === 'Joined' ? new Date().toISOString() : null, link.id]
            );

        } catch (error) {
            task.stats.errors++;
            console.error('Join error:', error);
        }

        task.currentIndex++;

        if (task.currentIndex < task.links.length && !task.stopRequested) {
            const delay = Math.floor(Math.random() * (task.maxDelay - task.minDelay + 1) + task.minDelay);
            io_emit('delay', { seconds: delay, nextRun: Date.now() + delay * 1000 });
            
            // Delay with pause check
            for (let i = 0; i < delay && !task.stopRequested; i++) {
                if (task.paused) {
                    while (task.paused && !task.stopRequested) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    if (!task.stopRequested && task.autoRestart) {
        // Re-fetch pending links and restart
        const newLinks = await db.all("SELECT * FROM links WHERE join_status = 'Pending' AND status = 'Active'");
        if (newLinks.length > 0) {
            task.links = newLinks;
            task.currentIndex = 0;
            io_emit('log', { message: 'Auto-restarting task with new links...' });
            return processTask(taskId, io);
        }
    }

    task.status = task.stopRequested ? 'Stopped' : 'Completed';
    io_emit('finished', { status: task.status, stats: task.stats });
    activeTasks.delete(taskId);
}

export function stopTask(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
        task.stopRequested = true;
        return true;
    }
    return false;
}

export function pauseTask(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
        task.paused = !task.paused;
        return { paused: task.paused };
    }
    return null;
}

export async function getJoinStats() {
    const db = getDB();
    const stats = await db.get(`
        SELECT 
            COUNT(*) as total_links,
            COALESCE(SUM(CASE WHEN join_status = 'Joined' THEN 1 ELSE 0 END), 0) as joined,
            COALESCE(SUM(CASE WHEN join_status = 'Pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN join_status = 'Failed' THEN 1 ELSE 0 END), 0) as failed
        FROM links
    `);
    const accounts = await db.get("SELECT COUNT(*) as active_accounts FROM accounts WHERE status = 'Connected'");
    return { ...stats, active_accounts: accounts?.active_accounts || 0 };
}

export async function getJoinLogs(limit = 100) {
    const db = getDB();
    return await db.all(`
        SELECT l.*, a.name as account_name 
        FROM join_logs l 
        LEFT JOIN accounts a ON l.account_id = a.id 
        ORDER BY l.timestamp DESC 
        LIMIT ?
    `, [limit]);
}
