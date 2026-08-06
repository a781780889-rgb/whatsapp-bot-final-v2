import { getDB } from './database.js';
import { getSession } from './whatsapp.js';
import { v4 as uuidv4 } from 'uuid';

let activeTasks = new Map();

export async function getGroupParticipants(accountId, groupId) {
    const sock = getSession(accountId);
    if (!sock) throw new Error('Account not connected');

    try {
        const metadata = await sock.groupMetadata(groupId);
        return metadata.participants || [];
    } catch (error) {
        console.error('Failed to fetch participants:', error);
        throw error;
    }
}

export async function startMentionTask(options, io) {
    const { accountIds, groups, message, mentionSettings, executionSettings } = options;
    const taskId = uuidv4();
    const db = getDB();

    const task = {
        id: taskId,
        accountIds,
        groups, // Array of { id, name }
        message,
        mentionSettings: {
            enabled: mentionSettings?.enabled ?? true,
            maxPerMessage: parseInt(mentionSettings?.maxPerMessage) || 20,
            excludeAdmins: mentionSettings?.excludeAdmins ?? false,
            excludeMe: mentionSettings?.excludeMe ?? true
        },
        executionSettings: {
            delay: parseInt(executionSettings?.delay) || 10,
            concurrent: parseInt(executionSettings?.concurrent) || 1
        },
        currentIndex: 0,
        status: 'Running',
        stats: {
            totalGroups: groups.length,
            completedGroups: 0,
            sentMessages: 0,
            failedMessages: 0,
            totalMentions: 0,
            startTime: Date.now()
        },
        stopRequested: false
    };

    activeTasks.set(taskId, task);
    processMentionTask(taskId, io);

    return { taskId, total: groups.length };
}

async function processMentionTask(taskId, io) {
    const task = activeTasks.get(taskId);
    if (!task || task.status !== 'Running') return;

    const db = getDB();
    const io_emit = (event, data) => io.emit(`mention-task-${event}`, { taskId, ...data });

    for (const group of task.groups) {
        if (task.stopRequested) break;

        const accountId = task.accountIds[task.currentIndex % task.accountIds.length];
        const sock = getSession(accountId);

        if (!sock) {
            task.stats.failedMessages++;
            task.currentIndex++;
            continue;
        }

        try {
            io_emit('status', {
                currentIndex: task.currentIndex,
                currentGroup: group.name,
                accountId,
                stats: task.stats
            });

            let participants = [];
            if (task.mentionSettings.enabled) {
                const allParticipants = await getGroupParticipants(accountId, group.id);
                participants = allParticipants.filter(p => {
                    if (task.mentionSettings.excludeMe && p.id === sock.user.id) return false;
                    if (task.mentionSettings.excludeAdmins && p.admin) return false;
                    return true;
                }).map(p => p.id);
            }

            if (participants.length > 0 && task.mentionSettings.enabled) {
                // Chunk participants
                const chunkSize = task.mentionSettings.maxPerMessage;
                for (let i = 0; i < participants.length; i += chunkSize) {
                    if (task.stopRequested) break;
                    
                    const chunk = participants.slice(i, i + chunkSize);
                    await sock.sendMessage(group.id, {
                        text: task.message,
                        mentions: chunk
                    });
                    
                    task.stats.sentMessages++;
                    task.stats.totalMentions += chunk.length;
                    
                    // Small delay between chunks in the same group
                    if (i + chunkSize < participants.length) {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            } else {
                // Send without mentions
                await sock.sendMessage(group.id, { text: task.message });
                task.stats.sentMessages++;
            }

            task.stats.completedGroups++;
            
            // Log success
            await db.run(
                'INSERT INTO mention_logs (task_id, account_id, group_id, group_name, status, mention_count) VALUES (?, ?, ?, ?, ?, ?)',
                [taskId, accountId, group.id, group.name, 'Success', participants.length]
            );

        } catch (error) {
            task.stats.failedMessages++;
            console.error('Mention task error:', error);
            await db.run(
                'INSERT INTO mention_logs (task_id, account_id, group_id, group_name, status, error) VALUES (?, ?, ?, ?, ?, ?)',
                [taskId, accountId, group.id, group.name, 'Failed', error.message]
            );
        }

        task.currentIndex++;

        if (task.currentIndex < task.groups.length && !task.stopRequested) {
            const delay = task.executionSettings.delay;
            io_emit('delay', { seconds: delay });
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }

    task.status = task.stopRequested ? 'Stopped' : 'Completed';
    io_emit('finished', { status: task.status, stats: task.stats });
    activeTasks.delete(taskId);
}

export function stopMentionTask(taskId) {
    const task = activeTasks.get(taskId);
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
