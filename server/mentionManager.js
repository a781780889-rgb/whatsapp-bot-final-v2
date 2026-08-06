import { getDB } from './database.js';
import { getSession } from './whatsapp.js';
import { v4 as uuidv4 } from 'uuid';

let activeMentionTasks = new Map();

export async function startMentionTask(options, io) {
    const { accountIds, groups, message, mentionSettings, executionSettings } = options;
    const taskId = uuidv4();
    const db = getDB();

    const task = {
        id: taskId,
        accountIds,
        groups,
        message,
        mentionSettings,
        executionSettings,
        status: 'Running',
        currentIndex: 0,
        stats: {
            totalGroups: groups.length,
            sentMessages: 0,
            totalMentions: 0,
            errors: 0
        },
        stopRequested: false
    };

    activeMentionTasks.set(taskId, task);
    processMentionTask(taskId, io);

    return { taskId };
}

async function processMentionTask(taskId, io) {
    const task = activeMentionTasks.get(taskId);
    if (!task) return;

    const db = getDB();
    const io_emit = (event, data) => io.emit(`mention-task-${event}`, { taskId, ...data });

    for (let i = 0; i < task.groups.length && !task.stopRequested; i++) {
        const group = task.groups[i];
        const accountId = task.accountIds[i % task.accountIds.length];
        const sock = getSession(accountId);

        if (!sock) {
            task.stats.errors++;
            continue;
        }

        try {
            io_emit('status', {
                currentIndex: i,
                currentGroup: group.name,
                stats: task.stats
            });

            const groupMetadata = await sock.groupMetadata(group.id);
            let participants = groupMetadata.participants;

            if (task.mentionSettings.excludeAdmins) {
                participants = participants.filter(p => !p.admin);
            }
            if (task.mentionSettings.excludeMe) {
                participants = participants.filter(p => p.id !== sock.user.id);
            }

            const mentions = participants.map(p => p.id);
            const maxPerMsg = parseInt(task.mentionSettings.maxPerMessage) || 20;

            for (let j = 0; j < mentions.length; j += maxPerMsg) {
                if (task.stopRequested) break;
                
                const chunk = mentions.slice(j, j + maxPerMsg);
                await sock.sendMessage(group.id, {
                    text: task.message,
                    mentions: chunk
                });
                
                task.stats.sentMessages++;
                task.stats.totalMentions += chunk.length;
                
                if (j + maxPerMsg < mentions.length) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            await db.run(
                'INSERT INTO mention_logs (task_id, account_id, group_id, group_name, status, mention_count) VALUES (?, ?, ?, ?, ?, ?)',
                [taskId, accountId, group.id, group.name, 'Success', mentions.length]
            );

        } catch (error) {
            task.stats.errors++;
            console.error('Mention error:', error);
            await db.run(
                'INSERT INTO mention_logs (task_id, account_id, group_id, group_name, status, error) VALUES (?, ?, ?, ?, ?, ?)',
                [taskId, accountId, group.id, group.name, 'Failed', error.message]
            );
        }

        if (i < task.groups.length - 1 && !task.stopRequested) {
            const delay = parseInt(task.executionSettings.delay) || 5;
            io_emit('delay', { seconds: delay });
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }

    task.status = task.stopRequested ? 'Stopped' : 'Completed';
    io_emit('finished', { status: task.status, stats: task.stats });
    activeMentionTasks.delete(taskId);
}

export function stopMentionTask(taskId) {
    const task = activeMentionTasks.get(taskId);
    if (task) {
        task.stopRequested = true;
        return true;
    }
    return false;
}

export async function saveMentionTemplate(name, content) {
    const db = getDB();
    const id = uuidv4();
    await db.run('INSERT INTO mention_templates (id, name, content) VALUES (?, ?, ?)', [id, name, content]);
    return { id, name };
}

export async function getMentionTemplates() {
    const db = getDB();
    return await db.all('SELECT * FROM mention_templates ORDER BY created_at DESC');
}

export async function deleteMentionTemplate(id) {
    const db = getDB();
    await db.run('DELETE FROM mention_templates WHERE id = ?', [id]);
    return true;
}
