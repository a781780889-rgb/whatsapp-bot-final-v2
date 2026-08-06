import { getDB } from './database.js';
import { getSession } from './whatsapp.js';
import { v4 as uuidv4 } from 'uuid';

let activeGroupTasks = new Map();

export async function getAccountGroups(accountId) {
    const sock = getSession(accountId);
    if (!sock) throw new Error('Account not connected');

    try {
        const groups = await sock.groupFetchAllParticipating();
        return Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject,
            description: g.desc?.toString() || '',
            participantsCount: g.participants?.length || 0,
            isAdmin: g.participants?.find(p => p.id === sock.user.id)?.admin || false
        }));
    } catch (error) {
        console.error('Failed to fetch groups:', error);
        throw error;
    }
}

export async function startGroupEditTask(options, io) {
    const { groups, mode, subject, description, delay } = options;
    const taskId = uuidv4();

    const task = {
        id: taskId,
        groups, // Array of { id, accountId }
        mode,
        subject,
        description,
        delay: parseInt(delay) || 5,
        status: 'Running',
        currentIndex: 0,
        stats: {
            total: groups.length,
            success: 0,
            failed: 0,
            noPermission: 0
        },
        stopRequested: false
    };

    activeGroupTasks.set(taskId, task);
    processGroupTask(taskId, io);

    return { taskId };
}

async function processGroupTask(taskId, io) {
    const task = activeGroupTasks.get(taskId);
    if (!task) return;

    const db = getDB();
    const io_emit = (event, data) => io.emit(`group-task-${event}`, { taskId, ...data });

    for (let i = 0; i < task.groups.length && !task.stopRequested; i++) {
        const groupInfo = task.groups[i];
        const sock = getSession(groupInfo.accountId);

        if (!sock) {
            task.stats.failed++;
            continue;
        }

        try {
            const metadata = await sock.groupMetadata(groupInfo.id);
            io_emit('status', {
                currentIndex: i,
                currentGroup: metadata.subject,
                stats: task.stats
            });

            const isAdmin = metadata.participants.find(p => p.id === sock.user.id)?.admin;
            if (!isAdmin) {
                task.stats.noPermission++;
            } else {
                if (task.mode === 'subject' || task.mode === 'both') {
                    await sock.groupUpdateSubject(groupInfo.id, task.subject);
                }
                if (task.mode === 'description' || task.mode === 'both') {
                    await sock.groupUpdateDescription(groupInfo.id, task.description);
                }
                task.stats.success++;
            }

        } catch (error) {
            task.stats.failed++;
            console.error('Group edit error:', error);
        }

        if (i < task.groups.length - 1 && !task.stopRequested) {
            io_emit('delay', { seconds: task.delay });
            await new Promise(resolve => setTimeout(resolve, task.delay * 1000));
        }
    }

    task.status = task.stopRequested ? 'Stopped' : 'Completed';
    io_emit('finished', { status: task.status, stats: task.stats });
    activeGroupTasks.delete(taskId);
}

export function stopGroupTask(taskId) {
    const task = activeGroupTasks.get(taskId);
    if (task) {
        task.stopRequested = true;
        return true;
    }
    return false;
}
