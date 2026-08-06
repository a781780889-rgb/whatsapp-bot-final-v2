import { getDB } from './database.js';
import { getSession } from './whatsapp.js';
import { v4 as uuidv4 } from 'uuid';

let activeTasks = new Map();

export async function getAccountGroups(accountId) {
    const sock = getSession(accountId);
    if (!sock) throw new Error('Account not connected');

    try {
        const groups = await sock.groupFetchAllParticipating();
        return Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject,
            description: g.desc?.toString() || '',
            participantsCount: g.participants.length,
            isAdmin: g.participants.find(p => p.id === sock.user.id)?.admin !== null
        }));
    } catch (error) {
        console.error('Failed to fetch groups:', error);
        throw error;
    }
}

export async function startGroupEditTask(options, io) {
    const { accountIds, groupIds, subject, description, mode, settings } = options;
    const taskId = uuidv4();
    const db = getDB();

    const task = {
        id: taskId,
        accountIds,
        groupIds, // Array of group IDs to edit
        subject,
        description,
        mode, // 'subject', 'description', 'both'
        currentIndex: 0,
        status: 'Running',
        stats: {
            total: groupIds.length,
            success: 0,
            failed: 0,
            noPermission: 0,
            startTime: Date.now()
        },
        settings: {
            concurrent: settings?.concurrent || 1,
            delay: settings?.delay || 5,
            accountDelay: settings?.accountDelay || 10
        },
        stopRequested: false
    };

    activeTasks.set(taskId, task);
    processTask(taskId, io);

    return { taskId, total: groupIds.length };
}

async function processTask(taskId, io) {
    const task = activeTasks.get(taskId);
    if (!task || task.status !== 'Running') return;

    const db = getDB();
    const io_emit = (event, data) => io.emit(`group-task-${event}`, { taskId, ...data });

    for (const groupId of task.groupIds) {
        if (task.stopRequested) break;

        // Simple round-robin for accounts
        const accountId = task.accountIds[task.currentIndex % task.accountIds.length];
        const sock = getSession(accountId);

        if (!sock) {
            task.stats.failed++;
            task.currentIndex++;
            continue;
        }

        try {
            io_emit('status', {
                currentIndex: task.currentIndex,
                currentGroup: groupId,
                accountId,
                stats: task.stats
            });

            const startTime = Date.now();
            let result = 'Success';
            let reason = '';

            try {
                // In a real scenario, we'd check permissions first, but Baileys will throw if not admin
                if (task.mode === 'subject' || task.mode === 'both') {
                    await sock.groupUpdateSubject(groupId, task.subject);
                }
                if (task.mode === 'description' || task.mode === 'both') {
                    await sock.groupUpdateDescription(groupId, task.description);
                }
                task.stats.success++;
            } catch (err) {
                reason = err.message;
                if (reason.includes('403') || reason.includes('forbidden')) {
                    task.stats.noPermission++;
                    result = 'No Permission';
                } else {
                    task.stats.failed++;
                    result = 'Failed';
                }
            }

            const duration = Date.now() - startTime;

            // Log operation to audit_logs or a new table
            await db.run(
                'INSERT INTO audit_logs (account_id, event, details) VALUES (?, ?, ?)',
                [accountId, 'Group Edit', JSON.stringify({
                    groupId,
                    mode: task.mode,
                    result,
                    reason,
                    duration
                })]
            );

        } catch (error) {
            console.error('Group edit error:', error);
        }

        task.currentIndex++;

        if (task.currentIndex < task.groupIds.length && !task.stopRequested) {
            const delay = task.settings.delay;
            io_emit('delay', { seconds: delay });
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }

    task.status = task.stopRequested ? 'Stopped' : 'Completed';
    io_emit('finished', { status: task.status, stats: task.stats });
    activeTasks.delete(taskId);
}

export function stopGroupTask(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
        task.stopRequested = true;
        return true;
    }
    return false;
}
