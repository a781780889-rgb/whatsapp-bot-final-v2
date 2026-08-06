const socket = io();
let accounts = [];
let availableGroups = [];
let availableMentionGroups = [];
let currentJoinTaskId = null;
let currentGroupTaskId = null;
let currentMentionTaskId = null;
let isJoiningPaused = false;

// DOM Elements
const accountsGrid = document.getElementById('accounts-grid');
const emptyState = document.getElementById('empty-state');
const headerStats = document.getElementById('header-stats');
const addAccountForm = document.getElementById('addAccountForm');
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebar');

function updateIcons() { if (window.lucide) lucide.createIcons(); }

toggleSidebarBtn.onclick = () => {
    sidebar.classList.toggle('collapsed');
    document.querySelectorAll('.sidebar-text').forEach(t => t.classList.toggle('hidden'));
};

window.showSection = (section) => {
    document.querySelectorAll('main > div').forEach(div => div.classList.add('hidden'));
    const target = document.getElementById(`section-${section}`);
    if (target) target.classList.remove('hidden');
    
    document.querySelectorAll('nav a').forEach(a => {
        a.classList.remove('bg-green-500/10', 'text-green-400', 'border-green-500/20');
        a.classList.add('hover:bg-white/5', 'text-slate-400');
    });
    
    const activeMenu = document.getElementById(`menu-${section}`);
    if (activeMenu) {
        activeMenu.classList.add('bg-green-500/10', 'text-green-400', 'border-green-500/20');
        activeMenu.classList.remove('hover:bg-white/5', 'text-slate-400');
    }

    if (section === 'links') fetchLinks();
    if (section === 'join') { fetchJoinStats(); renderJoinAccountSelector(); }
    if (section === 'groups') renderGroupAccountSelector();
    if (section === 'mentions') renderMentionAccountSelector();
    updateIcons();
};

async function fetchAccounts() {
    try {
        const res = await fetch('/api/accounts');
        accounts = await res.json();
        renderAccounts();
        updateStats();
    } catch (err) { console.error(err); }
}

function renderAccounts() {
    if (accounts.length === 0) {
        accountsGrid.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');
    accountsGrid.innerHTML = accounts.map(acc => `
        <div class="card rounded-2xl p-5 flex flex-col gap-4">
            <div class="flex justify-between items-start">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center"><i data-lucide="user"></i></div>
                    <div><h4 class="font-bold text-white text-sm">${acc.name}</h4><p class="text-[10px] text-slate-500">${acc.phone || 'غير مربوط'}</p></div>
                </div>
                <span class="px-2 py-0.5 rounded text-[9px] font-bold ${acc.status === 'Connected' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}">${acc.status}</span>
            </div>
            <div class="flex gap-2">
                ${acc.status === 'Waiting QR' ? `<button onclick="showQR('${acc.id}')" class="flex-1 bg-blue-600/20 text-blue-400 py-2 rounded-xl text-[10px] font-bold">QR</button>` : ''}
                ${acc.status === 'Disconnected' ? `<button onclick="reconnect('${acc.id}')" class="flex-1 bg-green-600/20 text-green-400 py-2 rounded-xl text-[10px] font-bold">اتصال</button>` : ''}
                <button onclick="deleteAccount('${acc.id}')" class="w-8 h-8 text-slate-500 hover:text-red-500"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>
        </div>
    `).join('');
    updateIcons();
}

window.reconnect = (id) => fetch(`/api/accounts/${id}/reconnect`, { method: 'POST' }).then(fetchAccounts);
window.deleteAccount = (id) => confirm('حذف؟') && fetch(`/api/accounts/${id}`, { method: 'DELETE' }).then(fetchAccounts);

async function fetchLinks() {
    const res = await fetch('/api/links');
    const data = await res.json();
    document.getElementById('links-table-body').innerHTML = data.links.map(l => `
        <tr class="hover:bg-white/5">
            <td class="px-6 py-4 text-xs truncate max-w-xs">${l.url}</td>
            <td class="px-6 py-4"><span class="px-2 py-0.5 rounded text-[9px] ${l.status === 'Active' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}">${l.status}</span></td>
            <td class="px-6 py-4 text-[10px]">${l.tags || '-'}</td>
            <td class="px-6 py-4 text-[10px]">${l.created_at}</td>
            <td class="px-6 py-4 font-bold text-xs">${l.view_count}</td>
            <td class="px-6 py-4"><button onclick="deleteLink('${l.id}')" class="text-slate-500 hover:text-red-500"><i data-lucide="trash-2" class="w-4 h-4"></i></button></td>
        </tr>
    `).join('');
    updateIcons();
}

window.deleteLink = (id) => confirm('حذف؟') && fetch(`/api/links/${id}`, { method: 'DELETE' }).then(fetchLinks);

// Join
function renderJoinAccountSelector() {
    document.getElementById('join-account-selector').innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer">
            <input type="checkbox" name="join-accounts" value="${a.id}">
            <div class="text-right"><p class="text-xs font-bold text-white">${a.name}</p></div>
        </label>
    `).join('') || '<p class="text-red-500 text-xs">لا توجد حسابات متصلة</p>';
}

async function startJoining() {
    const ids = Array.from(document.querySelectorAll('input[name="join-accounts"]:checked')).map(i => i.value);
    if (ids.length === 0) return alert('اختر حساباً');
    const res = await fetch('/api/join/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: ids, linkSource: 'database', minDelay: document.getElementById('join-min-delay').value, maxDelay: document.getElementById('join-max-delay').value })
    });
    const data = await res.json();
    if (data.taskId) {
        currentJoinTaskId = data.taskId;
        closeModal('joinSettingsModal');
        document.getElementById('btn-start-join').disabled = true;
        document.getElementById('btn-stop-join').disabled = false;
        document.getElementById('btn-pause-join').disabled = false;
        document.getElementById('join-progress-container').classList.remove('hidden');
    }
}

window.stopJoining = () => fetch(`/api/join/stop/${currentJoinTaskId}`, { method: 'POST' }).then(() => location.reload());
window.pauseJoining = async () => {
    const res = await fetch(`/api/join/pause/${currentJoinTaskId}`, { method: 'POST' });
    const data = await res.json();
    document.getElementById('btn-pause-join').textContent = data.paused ? 'استئناف' : 'مؤقت';
};

// Groups
function renderGroupAccountSelector() {
    document.getElementById('group-account-selector').innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer">
            <input type="checkbox" name="group-accounts" value="${a.id}">
            <div class="text-right"><p class="text-xs font-bold text-white">${a.name}</p></div>
        </label>
    `).join('') || '<p class="text-red-500 text-xs">لا توجد حسابات متصلة</p>';
}

document.getElementById('btn-fetch-groups').onclick = async () => {
    const ids = Array.from(document.querySelectorAll('input[name="group-accounts"]:checked')).map(i => i.value);
    availableGroups = [];
    for (const id of ids) {
        const res = await fetch(`/api/groups/${id}`);
        const data = await res.json();
        availableGroups.push(...data.map(g => ({ ...g, accountId: id })));
    }
    document.getElementById('groups-list-container').innerHTML = availableGroups.map(g => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer">
            <input type="checkbox" name="selected-groups" value="${g.id}" data-account="${g.accountId}">
            <div class="text-right"><p class="text-xs font-bold text-white">${g.subject}</p></div>
        </label>
    `).join('');
    document.getElementById('btn-start-group-edit').disabled = false;
};

document.getElementById('btn-start-group-edit').onclick = async () => {
    const selected = Array.from(document.querySelectorAll('input[name="selected-groups"]:checked'));
    const options = {
        groups: selected.map(i => ({ id: i.value, accountId: i.dataset.account })),
        mode: document.getElementById('group-edit-mode').value,
        subject: document.getElementById('group-new-subject').value,
        description: document.getElementById('group-new-desc').value
    };
    const res = await fetch('/api/groups/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
    const data = await res.json();
    if (data.taskId) { currentGroupTaskId = data.taskId; document.getElementById('btn-start-group-edit').disabled = true; }
};

// Mentions
function renderMentionAccountSelector() {
    document.getElementById('mention-account-selector').innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer">
            <input type="checkbox" name="mention-accounts" value="${a.id}">
            <div class="text-right"><p class="text-xs font-bold text-white">${a.name}</p></div>
        </label>
    `).join('') || '<p class="text-red-500 text-xs">لا توجد حسابات متصلة</p>';
}

document.getElementById('btn-fetch-mention-groups').onclick = async () => {
    const ids = Array.from(document.querySelectorAll('input[name="mention-accounts"]:checked')).map(i => i.value);
    availableMentionGroups = [];
    for (const id of ids) {
        const res = await fetch(`/api/groups/${id}`);
        const data = await res.json();
        availableMentionGroups.push(...data.map(g => ({ ...g, accountId: id })));
    }
    document.getElementById('mention-groups-list').innerHTML = availableMentionGroups.map(g => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer">
            <input type="checkbox" name="selected-mention-groups" value="${g.id}" data-account="${g.accountId}" data-name="${g.subject}">
            <div class="text-right"><p class="text-xs font-bold text-white">${g.subject}</p></div>
        </label>
    `).join('');
    document.getElementById('btn-start-mention').disabled = false;
};

document.getElementById('btn-start-mention').onclick = async () => {
    const selected = Array.from(document.querySelectorAll('input[name="selected-mention-groups"]:checked'));
    const ids = Array.from(document.querySelectorAll('input[name="mention-accounts"]:checked')).map(i => i.value);
    const options = {
        accountIds: ids,
        groups: selected.map(i => ({ id: i.value, name: i.dataset.name })),
        message: document.getElementById('mention-message').value,
        mentionSettings: { enabled: document.getElementById('mention-enabled').checked, maxPerMessage: document.getElementById('mention-max-per-msg').value },
        executionSettings: { delay: 5 }
    };
    const res = await fetch('/api/mentions/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
    const data = await res.json();
    if (data.taskId) { currentMentionTaskId = data.taskId; document.getElementById('btn-start-mention').disabled = true; }
};

// Socket
socket.on('join-task-status', (data) => {
    const div = document.createElement('div');
    div.className = 'p-2 bg-white/5 rounded border-r-2 border-blue-500';
    div.innerHTML = `جاري معالجة: ${data.currentLink}`;
    document.getElementById('join-live-feed').prepend(div);
    document.getElementById('join-progress-bar').style.width = `${Math.round(((data.currentIndex + 1) / data.stats.total) * 100)}%`;
});

socket.on('qr', (data) => {
    QRCode.toCanvas(document.getElementById('qr-canvas'), data.qr, { width: 280 });
    openModal('qrModal');
});

socket.on('status', fetchAccounts);

// General
window.openModal = (id) => document.getElementById(id).classList.replace('hidden', 'flex');
window.closeModal = (id) => document.getElementById(id).classList.replace('flex', 'hidden');

document.getElementById('addAccountForm').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: document.getElementById('acc-name').value, type: document.querySelector('input[name="acc-type"]:checked').value })
    });
    if (res.ok) { closeModal('addAccountModal'); fetchAccounts(); }
};

document.getElementById('importLinksForm').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('file', document.getElementById('link-file').files[0]);
    document.getElementById('import-monitor').classList.remove('hidden');
    await fetch('/api/links/import', { method: 'POST', body: formData });
};

socket.on('import-progress', (data) => {
    document.getElementById('import-progress-bar').style.width = `${data.progress}%`;
    if (data.progress === 100) setTimeout(() => { closeModal('importLinksModal'); fetchLinks(); }, 1000);
});

async function updateStats() {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    headerStats.innerHTML = `<div class="text-right text-[9px] font-bold">الحسابات: ${stats.total}</div>`;
}

document.getElementById('joinSettingsForm').onsubmit = (e) => { e.preventDefault(); startJoining(); };

fetchAccounts();
showSection('accounts');
setInterval(fetchAccounts, 30000);
