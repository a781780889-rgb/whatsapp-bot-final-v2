const socket = io();
let accounts = [];
let systemStats = { cpu: 0, memory: 0, uptime: '0s' };

// Link Management State
let currentLinkPage = 1;
let linkSearch = '';
let linkStatus = '';

// Join Task State
let currentJoinTaskId = null;
let isJoiningPaused = false;

// DOM Elements
const accountsGrid = document.getElementById('accounts-grid');
const emptyState = document.getElementById('empty-state');
const headerStats = document.getElementById('header-stats');
const addAccountForm = document.getElementById('addAccountForm');
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebar');
const globalSearch = document.getElementById('global-search');
const ramUsageBar = document.getElementById('ram-usage-bar');
const ramUsageText = document.getElementById('ram-usage-text');
const systemUptimeText = document.getElementById('system-uptime');

// Initialize Lucide icons
function updateIcons() {
    if (window.lucide) lucide.createIcons();
}

// Sidebar Toggle
toggleSidebarBtn.onclick = () => {
    sidebar.classList.toggle('collapsed');
    const texts = document.querySelectorAll('.sidebar-text');
    texts.forEach(t => t.classList.toggle('hidden'));
};

// Global Search
globalSearch.oninput = (e) => {
    const query = e.target.value.toLowerCase();
    const filtered = accounts.filter(acc => 
        acc.name.toLowerCase().includes(query) || 
        (acc.phone && acc.phone.includes(query)) ||
        acc.type.toLowerCase().includes(query)
    );
    renderAccounts(filtered);
};

// Section Management
window.showSection = (section) => {
    document.querySelectorAll('main > div').forEach(div => div.classList.add('hidden'));
    document.getElementById(`section-${section}`).classList.remove('hidden');
    
    document.querySelectorAll('nav a').forEach(a => {
        a.classList.remove('bg-green-500/10', 'text-green-400', 'border-green-500/20');
        a.classList.add('hover:bg-white/5', 'text-slate-400');
    });
    
    const activeMenu = document.getElementById(`menu-${section}`);
    if (activeMenu) {
        activeMenu.classList.add('bg-green-500/10', 'text-green-400', 'border-green-500/20');
        activeMenu.classList.remove('hover:bg-white/5', 'text-slate-400');
    }

    const titles = {
        'accounts': { t: 'إدارة حسابات واتساب', s: 'إدارة وربط حسابات الواتساب الخاصة بك' },
        'links': { t: 'إدارة الروابط والملفات', s: 'استيراد وتنظيم روابط الدعوات' },
        'join': { t: 'الانضمام التلقائي للمجموعات', s: 'بدء ومتابعة مهام الانضمام للمجموعات' },
        'groups': { t: 'تعديل المجموعات (الوصف - الموضوع)', s: 'تحديث معلومات المجموعات بشكل جماعي' },
        'mentions': { t: 'ذكر المستخدمين (Mentions)', s: 'إرسال إعلانات مع إشارات للأعضاء' }
    };

    if (titles[section]) {
        document.getElementById('page-title').textContent = titles[section].t;
        document.getElementById('page-subtitle').textContent = titles[section].s;
        document.getElementById('breadcrumb-current').textContent = titles[section].t;
    }

    if (section === 'links') { fetchLinkStats(); fetchLinks(); }
    if (section === 'join') { fetchJoinStats(); renderJoinAccountSelector(); }
    if (section === 'groups') { renderGroupAccountSelector(); }
    if (section === 'mentions') { renderMentionAccountSelector(); fetchMentionTemplates(); }
};

// Fetch Accounts
async function fetchAccounts() {
    try {
        const res = await fetch('/api/accounts');
        accounts = await res.json();
        renderAccounts();
        updateStats();
        if (!document.getElementById('section-join').classList.contains('hidden')) {
            renderJoinAccounts();
        }
    } catch (err) {
        console.error('Failed to fetch accounts:', err);
    }
}

function renderAccounts(data = accounts) {
    if (data.length === 0) {
        accountsGrid.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');
    accountsGrid.innerHTML = data.map(acc => `
        <div class="card rounded-2xl p-5 flex flex-col gap-4 group relative overflow-hidden">
            <div class="flex justify-between items-start z-10">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400">
                        <i data-lucide="${acc.type === 'Business' ? 'briefcase' : 'user'}" class="w-5 h-5"></i>
                    </div>
                    <div>
                        <h4 class="font-bold text-white text-sm">${acc.name}</h4>
                        <p class="text-[10px] text-slate-500 font-mono">${acc.phone || 'غير مربوط'}</p>
                    </div>
                </div>
                <span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase ${getStatusBadgeClass(acc.status)}">
                    ${getStatusText(acc.status)}
                </span>
            </div>
            <div class="flex gap-2 mt-2">
                ${acc.status === 'Waiting QR' ? `<button onclick="showQR('${acc.id}')" class="flex-1 bg-blue-600/20 text-blue-400 py-2 rounded-xl text-[10px] font-bold">عرض QR</button>` : ''}
                ${acc.status === 'Disconnected' ? `<button onclick="reconnect('${acc.id}')" class="flex-1 bg-green-600/20 text-green-400 py-2 rounded-xl text-[10px] font-bold">اتصال</button>` : ''}
                <button onclick="deleteAccount('${acc.id}')" class="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-red-500"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>
        </div>
    `).join('');
    updateIcons();
}

function getStatusBadgeClass(status) {
    if (status === 'Connected') return 'bg-green-500/10 text-green-500';
    if (status === 'Waiting QR') return 'bg-blue-500/10 text-blue-500';
    return 'bg-red-500/10 text-red-500';
}

function getStatusText(status) {
    const map = { 'Connected': 'متصل', 'Waiting QR': 'بانتظار QR', 'Disconnected': 'منفصل' };
    return map[status] || status;
}

function formatDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return 'لا يوجد';
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(date);
}

// Link Management
async function fetchLinkStats() {
    const res = await fetch('/api/links/stats');
    const stats = await res.json();
    const container = document.getElementById('links-stats');
    const cards = [
        { l: 'إجمالي الروابط', v: stats.total, c: 'blue' },
        { l: 'روابط جديدة', v: stats.new_links, c: 'green' },
        { l: 'المكررة', v: stats.duplicates, c: 'yellow' },
        { l: 'النشطة', v: stats.active, c: 'emerald' }
    ];
    container.innerHTML = cards.map(c => `
        <div class="card p-4 rounded-2xl">
            <p class="text-[9px] text-slate-500 font-bold uppercase">${c.l}</p>
            <h3 class="text-xl font-bold text-white mt-1">${c.v}</h3>
        </div>
    `).join('');
}

async function fetchLinks(page = 1) {
    currentLinkPage = page;
    const res = await fetch(`/api/links?page=${page}&search=${linkSearch}&status=${linkStatus}`);
    const data = await res.json();
    const tbody = document.getElementById('links-table-body');
    tbody.innerHTML = data.links.map(l => `
        <tr class="hover:bg-white/5">
            <td class="px-6 py-4 text-white text-xs truncate max-w-xs">${l.url}</td>
            <td class="px-6 py-4"><span class="px-2 py-0.5 rounded text-[9px] ${l.status === 'Active' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}">${l.status}</span></td>
            <td class="px-6 py-4 text-slate-500 text-[10px]">${l.tags || '-'}</td>
            <td class="px-6 py-4 text-slate-500 text-[10px]">${formatDate(l.created_at)}</td>
            <td class="px-6 py-4 text-white font-bold text-xs">${l.view_count}</td>
            <td class="px-6 py-4 text-left"><button onclick="deleteLink('${l.id}')" class="text-slate-500 hover:text-red-500"><i data-lucide="trash-2" class="w-4 h-4"></i></button></td>
        </tr>
    `).join('');
    updateIcons();
}

// Join Links Logic
async function fetchJoinStats() {
    const res = await fetch('/api/join/stats');
    const stats = await res.json();
    document.getElementById('join-live-stats').innerHTML = `
        <div class="flex justify-between p-3 bg-white/5 rounded-xl"><span class="text-xs text-slate-400">إجمالي الروابط</span><span class="text-sm font-bold text-white">${stats.total_links}</span></div>
        <div class="flex justify-between p-3 bg-white/5 rounded-xl"><span class="text-xs text-slate-400">بانتظار الانضمام</span><span class="text-sm font-bold text-blue-500">${stats.pending}</span></div>
        <div class="flex justify-between p-3 bg-white/5 rounded-xl"><span class="text-xs text-slate-400">تم الانضمام</span><span class="text-sm font-bold text-green-500">${stats.joined}</span></div>
        <div class="flex justify-between p-3 bg-white/5 rounded-xl"><span class="text-xs text-slate-400">عمليات فاشلة</span><span class="text-sm font-bold text-red-500">${stats.failed}</span></div>
    `;
}

function renderJoinAccountSelector() {
    const container = document.getElementById('join-account-selector');
    container.innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer hover:bg-white/10">
            <input type="checkbox" name="join-accounts" value="${a.id}" class="w-4 h-4 text-green-500">
            <div class="text-right">
                <p class="text-xs font-bold text-white">${a.name}</p>
                <p class="text-[9px] text-slate-500">${a.phone}</p>
            </div>
        </label>
    `).join('') || '<p class="col-span-2 text-center text-red-500 text-xs">لا توجد حسابات متصلة حالياً</p>';
}

function renderJoinAccounts() {
    const container = document.getElementById('join-accounts-list');
    container.innerHTML = accounts.map(a => `
        <div class="p-4 bg-white/5 rounded-2xl border border-white/5">
            <div class="flex justify-between items-center mb-2">
                <span class="text-xs font-bold text-white">${a.name}</span>
                <span class="text-[9px] ${a.status === 'Connected' ? 'text-green-500' : 'text-red-500'}">${a.status}</span>
            </div>
            <div class="grid grid-cols-2 gap-2 text-[9px] text-slate-500">
                <span>نجاح: <b class="text-green-500">${a.join_success_count || 0}</b></span>
                <span>فشل: <b class="text-red-500">${a.join_failure_count || 0}</b></span>
            </div>
        </div>
    `).join('');
}

async function startJoining() {
    const selectedAccounts = Array.from(document.querySelectorAll('input[name="join-accounts"]:checked')).map(i => i.value);
    if (selectedAccounts.length === 0) return alert('يرجى اختيار حساب واحد على الأقل');

    const options = {
        accountIds: selectedAccounts,
        linkSource: document.getElementById('join-source').value,
        minDelay: document.getElementById('join-min-delay').value,
        maxDelay: document.getElementById('join-max-delay').value,
        autoRestart: document.getElementById('join-auto-restart').checked
    };

    const res = await fetch('/api/join/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
    });
    const result = await res.json();
    if (result.taskId) {
        currentJoinTaskId = result.taskId;
        closeModal('joinSettingsModal');
        document.getElementById('btn-start-join').disabled = true;
        document.getElementById('btn-stop-join').disabled = false;
        document.getElementById('btn-pause-join').disabled = false;
        document.getElementById('join-progress-container').classList.remove('hidden');
        document.getElementById('join-live-feed').innerHTML = '<div class="text-blue-500 font-bold">بدء المهمة...</div>';
    }
}

async function stopJoining() {
    if (!currentJoinTaskId) return;
    await fetch(`/api/join/stop/${currentJoinTaskId}`, { method: 'POST' });
    document.getElementById('btn-start-join').disabled = false;
    document.getElementById('btn-stop-join').disabled = true;
    document.getElementById('btn-pause-join').disabled = true;
}

async function resetJoinStatus() {
    if (!confirm('سيتم إعادة تعيين جميع الروابط (عدا المنضم إليها) إلى حالة "بانتظار الانضمام". هل أنت متأكد؟')) return;
    await fetch('/api/join/reset', { method: 'POST' });
    fetchJoinStats();
    alert('تمت إعادة التعيين بنجاح');
}

// Group Management Logic
let currentGroupTaskId = null;
let availableGroups = [];

function renderGroupAccountSelector() {
    const container = document.getElementById('group-account-selector');
    container.innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer hover:bg-white/10">
            <input type="checkbox" name="group-accounts" value="${a.id}" class="w-4 h-4 text-green-500">
            <div class="text-right">
                <p class="text-xs font-bold text-white">${a.name}</p>
                <p class="text-[9px] text-slate-500">${a.phone}</p>
            </div>
        </label>
    `).join('') || '<p class="text-center text-red-500 text-[10px] py-2">لا توجد حسابات متصلة</p>';
}

document.getElementById('group-edit-mode').onchange = (e) => {
    const mode = e.target.value;
    document.getElementById('group-subject-container').classList.toggle('hidden', mode === 'description');
    document.getElementById('group-desc-container').classList.toggle('hidden', mode === 'subject');
};

document.getElementById('btn-fetch-groups').onclick = async () => {
    const selectedAccounts = Array.from(document.querySelectorAll('input[name="group-accounts"]:checked')).map(i => i.value);
    if (selectedAccounts.length === 0) return alert('يرجى اختيار حساب واحد على الأقل');
    
    const btn = document.getElementById('btn-fetch-groups');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> جاري الجلب...';
    updateIcons();

    availableGroups = [];
    try {
        for (const accId of selectedAccounts) {
            const res = await fetch(`/api/groups/${accId}`);
            const groups = await res.json();
            availableGroups.push(...groups.map(g => ({ ...g, accountId: accId })));
        }
        renderGroupsList();
    } catch (err) {
        alert('فشل جلب المجموعات: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> جلب المجموعات';
        updateIcons();
    }
};

function renderGroupsList() {
    const container = document.getElementById('groups-list-container');
    if (availableGroups.length === 0) {
        container.innerHTML = '<div class="text-center py-10 text-slate-500 text-sm">لم يتم العثور على مجموعات</div>';
        return;
    }

    container.innerHTML = availableGroups.map((g, idx) => `
        <label class="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 hover:bg-white/10 cursor-pointer group">
            <div class="flex items-center gap-4">
                <input type="checkbox" name="target-groups" value="${g.id}" data-idx="${idx}" class="w-5 h-5 text-blue-500 rounded-lg">
                <div>
                    <h4 class="text-sm font-bold text-white">${g.subject}</h4>
                    <p class="text-[10px] text-slate-500">${g.participantsCount} عضو • ${g.isAdmin ? '<span class="text-green-500">مشرف</span>' : '<span class="text-red-500">عضو فقط</span>'}</p>
                </div>
            </div>
            <div class="text-left">
                <p class="text-[9px] text-slate-600 font-mono">${g.id}</p>
            </div>
        </label>
    `).join('');
    
    document.querySelectorAll('input[name="target-groups"]').forEach(i => {
        i.onchange = updateSelectedCount;
    });
    updateSelectedCount();
}

function updateSelectedCount() {
    const count = document.querySelectorAll('input[name="target-groups"]:checked').length;
    document.getElementById('selected-groups-count').textContent = `${count} مختارة`;
    document.getElementById('btn-start-group-edit').disabled = count === 0;
}

document.getElementById('btn-select-all-groups').onclick = () => {
    const all = document.querySelectorAll('input[name="target-groups"]');
    const checked = document.querySelectorAll('input[name="target-groups"]:checked');
    all.forEach(i => i.checked = checked.length < all.length);
    updateSelectedCount();
};

document.getElementById('btn-start-group-edit').onclick = async () => {
    const selectedGroupIds = Array.from(document.querySelectorAll('input[name="target-groups"]:checked')).map(i => i.value);
    const selectedAccountIds = Array.from(document.querySelectorAll('input[name="group-accounts"]:checked')).map(i => i.value);
    const mode = document.getElementById('group-edit-mode').value;
    const subject = document.getElementById('group-new-subject').value;
    const description = document.getElementById('group-new-desc').value;
    const delay = document.getElementById('group-delay').value;

    if (mode !== 'description' && !subject) return alert('يرجى إدخال اسم المجموعة الجديد');
    if (mode !== 'subject' && !description) return alert('يرجى إدخال الوصف الجديد');

    const res = await fetch('/api/groups/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accountIds: selectedAccountIds,
            groupIds: selectedGroupIds,
            mode,
            subject,
            description,
            settings: { delay: parseInt(delay) }
        })
    });

    const result = await res.json();
    if (result.taskId) {
        currentGroupTaskId = result.taskId;
        document.getElementById('group-progress-container').classList.remove('hidden');
        document.getElementById('btn-start-group-edit').disabled = true;
        document.getElementById('btn-stop-group-edit').disabled = false;
        document.getElementById('group-live-feed').innerHTML = '<div class="text-blue-500 font-bold">بدء عملية التعديل...</div>';
    }
};

document.getElementById('btn-stop-group-edit').onclick = async () => {
    if (!currentGroupTaskId) return;
    await fetch(`/api/groups/stop/${currentGroupTaskId}`, { method: 'POST' });
    document.getElementById('btn-start-group-edit').disabled = false;
    document.getElementById('btn-stop-group-edit').disabled = true;
};

// Mention Management Logic
let currentMentionTaskId = null;
let mentionTemplates = [];
let availableMentionGroups = [];

function renderMentionAccountSelector() {
    const container = document.getElementById('mention-account-selector');
    container.innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer hover:bg-white/10">
            <input type="checkbox" name="mention-accounts" value="${a.id}" class="w-4 h-4 text-green-500">
            <div class="text-right">
                <p class="text-xs font-bold text-white">${a.name}</p>
                <p class="text-[9px] text-slate-500">${a.phone}</p>
            </div>
        </label>
    `).join('') || '<p class="text-center text-red-500 text-[10px] py-2">لا توجد حسابات متصلة</p>';
}

async function fetchMentionTemplates() {
    const res = await fetch('/api/mentions/templates');
    mentionTemplates = await res.json();
    const select = document.getElementById('mention-template-select');
    select.innerHTML = '<option value="">اختر قالباً...</option>' + mentionTemplates.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

document.getElementById('mention-template-select').onchange = (e) => {
    const template = mentionTemplates.find(t => t.id === e.target.value);
    if (template) document.getElementById('mention-message').value = template.content;
};

document.getElementById('mentionTemplateForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('template-name').value;
    const content = document.getElementById('mention-message').value;
    if (!content) return alert('يرجى كتابة نص الإعلان أولاً');

    const res = await fetch('/api/mentions/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
    });
    if (res.ok) {
        closeModal('mentionTemplateModal');
        fetchMentionTemplates();
        alert('تم حفظ القالب بنجاح');
    }
};

document.getElementById('btn-mention-fetch-groups').onclick = async () => {
    const selectedAccounts = Array.from(document.querySelectorAll('input[name="mention-accounts"]:checked')).map(i => i.value);
    if (selectedAccounts.length === 0) return alert('يرجى اختيار حساب واحد على الأقل');
    
    const btn = document.getElementById('btn-mention-fetch-groups');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> جاري الجلب...';
    updateIcons();

    availableMentionGroups = [];
    try {
        for (const accId of selectedAccounts) {
            const res = await fetch(`/api/groups/${accId}`);
            const groups = await res.json();
            availableMentionGroups.push(...groups.map(g => ({ ...g, accountId: accId })));
        }
        renderMentionGroupsList();
    } catch (err) {
        alert('فشل جلب المجموعات: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="refresh-cw" class="w-3 h-3"></i> تحديث';
        updateIcons();
    }
};

function renderMentionGroupsList() {
    const container = document.getElementById('mention-groups-list');
    if (availableMentionGroups.length === 0) {
        container.innerHTML = '<div class="text-center py-10 text-slate-500 text-xs">لم يتم العثور على مجموعات</div>';
        return;
    }

    container.innerHTML = availableMentionGroups.map(g => `
        <label class="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 cursor-pointer group">
            <div class="flex items-center gap-3">
                <input type="checkbox" name="mention-target-groups" value="${g.id}" data-name="${g.subject}" class="w-4 h-4 text-blue-500 rounded">
                <div>
                    <h4 class="text-xs font-bold text-white">${g.subject}</h4>
                    <p class="text-[9px] text-slate-500">${g.participantsCount} عضو</p>
                </div>
            </div>
        </label>
    `).join('');
}

document.getElementById('btn-start-mention').onclick = async () => {
    const message = document.getElementById('mention-message').value;
    const selectedGroupInputs = Array.from(document.querySelectorAll('input[name="mention-target-groups"]:checked'));
    const selectedAccountIds = Array.from(document.querySelectorAll('input[name="mention-accounts"]:checked')).map(i => i.value);

    if (!message) return alert('يرجى كتابة نص الإعلان');
    if (selectedGroupInputs.length === 0) return alert('يرجى اختيار مجموعة واحدة على الأقل');

    const groups = selectedGroupInputs.map(i => ({ id: i.value, name: i.dataset.name }));
    
    const options = {
        accountIds: selectedAccountIds,
        groups,
        message,
        mentionSettings: {
            enabled: document.getElementById('mention-enabled').checked,
            maxPerMessage: document.getElementById('mention-max-per-msg').value,
            excludeAdmins: document.getElementById('mention-exclude-admins').checked,
            excludeMe: document.getElementById('mention-exclude-me').checked
        },
        executionSettings: {
            delay: document.getElementById('mention-delay').value,
            concurrent: document.getElementById('mention-concurrent').value
        }
    };

    const res = await fetch('/api/mentions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
    });

    const result = await res.json();
    if (result.taskId) {
        currentMentionTaskId = result.taskId;
        document.getElementById('mention-progress-container').classList.remove('hidden');
        document.getElementById('btn-start-mention').disabled = true;
        document.getElementById('btn-stop-mention').disabled = false;
        document.getElementById('mention-live-feed').innerHTML = '<div class="text-blue-500 font-bold">بدء عملية الإرسال...</div>';
    }
};

document.getElementById('btn-stop-mention').onclick = async () => {
    if (!currentMentionTaskId) return;
    await fetch(`/api/mentions/stop/${currentMentionTaskId}`, { method: 'POST' });
    document.getElementById('btn-start-mention').disabled = false;
    document.getElementById('btn-stop-mention').disabled = true;
};

// Socket Events for Mention Task
socket.on('mention-task-status', (data) => {
    const feed = document.getElementById('mention-live-feed');
    const div = document.createElement('div');
    div.className = 'p-2 bg-white/5 rounded-lg border-r-2 border-green-500';
    div.innerHTML = `<span class="text-slate-500 text-[8px]">${new Date().toLocaleTimeString()}</span> <span class="text-white">جاري المعالجة: ${data.currentGroup}</span>`;
    feed.prepend(div);

    const percent = Math.round(((data.currentIndex + 1) / data.stats.totalGroups) * 100);
    document.getElementById('mention-progress-bar').style.width = `${percent}%`;
    document.getElementById('mention-progress-percent').textContent = `${percent}%`;
    
    document.getElementById('stat-mention-sent').textContent = data.stats.sentMessages;
    document.getElementById('stat-mention-total').textContent = data.stats.totalMentions;
});

socket.on('mention-task-finished', (data) => {
    const feed = document.getElementById('mention-live-feed');
    const div = document.createElement('div');
    div.className = 'p-3 bg-green-500/10 rounded-xl border border-green-500/20 text-green-500 font-bold';
    div.textContent = `انتهت المهمة. الحالة: ${data.status}. إجمالي الإشارات: ${data.stats.totalMentions}`;
    feed.prepend(div);
    document.getElementById('btn-start-mention').disabled = false;
    document.getElementById('btn-stop-mention').disabled = true;
});

socket.on('mention-task-delay', (data) => {
    const feed = document.getElementById('mention-live-feed');
    const div = document.createElement('div');
    div.className = 'text-[8px] text-slate-500 italic px-2';
    div.textContent = `انتظار ${data.seconds} ثانية...`;
    feed.prepend(div);
});

// Socket Events for Group Task
socket.on('group-task-status', (data) => {
    const feed = document.getElementById('group-live-feed');
    const div = document.createElement('div');
    div.className = 'p-2 bg-white/5 rounded-lg border-r-2 border-blue-500';
    div.innerHTML = `<span class="text-slate-500 text-[10px]">${new Date().toLocaleTimeString()}</span> <span class="text-white">جاري تعديل: ${data.currentGroup}</span>`;
    feed.prepend(div);

    const percent = Math.round(((data.currentIndex + 1) / data.stats.total) * 100);
    document.getElementById('group-progress-bar').style.width = `${percent}%`;
    document.getElementById('group-progress-percent').textContent = `${percent}%`;
    
    document.getElementById('stat-group-success').textContent = data.stats.success;
    document.getElementById('stat-group-failed').textContent = data.stats.failed;
    document.getElementById('stat-group-noperm').textContent = data.stats.noPermission;
    document.getElementById('stat-group-remaining').textContent = data.stats.total - (data.currentIndex + 1);
});

socket.on('group-task-finished', (data) => {
    const feed = document.getElementById('group-live-feed');
    const div = document.createElement('div');
    div.className = 'p-3 bg-green-500/10 rounded-xl border border-green-500/20 text-green-500 font-bold';
    div.textContent = `انتهت عملية التعديل. الحالة: ${data.status}. المجموعات الناجحة: ${data.stats.success}`;
    feed.prepend(div);
    document.getElementById('btn-start-group-edit').disabled = false;
    document.getElementById('btn-stop-group-edit').disabled = true;
});

socket.on('group-task-delay', (data) => {
    const feed = document.getElementById('group-live-feed');
    const div = document.createElement('div');
    div.className = 'text-[10px] text-slate-500 italic px-2';
    div.textContent = `انتظار ${data.seconds} ثانية قبل المجموعة القادمة...`;
    feed.prepend(div);
});

// Socket Events for Join Task
socket.on('join-task-status', (data) => {
    const feed = document.getElementById('join-live-feed');
    const div = document.createElement('div');
    div.className = 'p-2 bg-white/5 rounded-lg border-r-2 border-blue-500';
    div.innerHTML = `<span class="text-slate-500 text-[10px]">${new Date().toLocaleTimeString()}</span> <span class="text-white">جاري معالجة: ${data.currentLink}</span>`;
    feed.prepend(div);

    const percent = Math.round(((data.currentIndex + 1) / data.stats.total) * 100);
    document.getElementById('join-progress-bar').style.width = `${percent}%`;
    document.getElementById('join-progress-percent').textContent = `${percent}%`;
    
    document.getElementById('stat-join-success').textContent = data.stats.success;
    document.getElementById('stat-join-failed').textContent = data.stats.failed;
    document.getElementById('stat-join-exists').textContent = data.stats.alreadyJoined;
    document.getElementById('stat-join-invalid').textContent = data.stats.invalid;
});

socket.on('join-task-finished', (data) => {
    const feed = document.getElementById('join-live-feed');
    const div = document.createElement('div');
    div.className = 'p-3 bg-green-500/10 rounded-xl border border-green-500/20 text-green-500 font-bold';
    div.textContent = `انتهت المهمة بنجاح. تم الانضمام لـ ${data.stats.success} مجموعة.`;
    feed.prepend(div);
    stopJoining();
    fetchJoinStats();
    fetchAccounts();
});

socket.on('join-task-delay', (data) => {
    const feed = document.getElementById('join-live-feed');
    const div = document.createElement('div');
    div.className = 'text-[10px] text-slate-500 italic px-2';
    div.textContent = `انتظار ${data.seconds} ثانية قبل العملية القادمة...`;
    feed.prepend(div);
});

// Modals & General
window.openModal = (id) => { document.getElementById(id).classList.remove('hidden'); document.getElementById(id).classList.add('flex'); };
window.closeModal = (id) => { document.getElementById(id).classList.add('hidden'); document.getElementById(id).classList.remove('flex'); };

document.getElementById('joinSettingsForm').onsubmit = (e) => { e.preventDefault(); startJoining(); };
document.getElementById('importLinksForm').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('file', document.getElementById('link-file').files[0]);
    document.getElementById('import-monitor').classList.remove('hidden');
    const res = await fetch('/api/links/import', { method: 'POST', body: formData });
    const result = await res.json();
    console.log(result);
};

socket.on('import-progress', (data) => {
    document.getElementById('import-progress-bar').style.width = `${data.progress}%`;
    if (data.progress === 100) {
        setTimeout(() => { closeModal('importLinksModal'); fetchLinkStats(); fetchLinks(); }, 1000);
    }
});

// Initial Stats
async function updateStats() {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    headerStats.innerHTML = `<div class="text-right"><p class="text-[9px] text-slate-500 font-bold uppercase">إجمالي الحسابات</p><h3 class="text-lg font-bold text-white">${stats.total}</h3></div>`;
}

// Start
fetchAccounts();
showSection('accounts');
setInterval(fetchAccounts, 30000);

// Add Account Form Submit Handler
addAccountForm.onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('acc-name').value.trim();
    const type = document.querySelector('input[name="acc-type"]:checked')?.value || 'Messenger';
    if (!name) return alert('يرجى إدخال اسم الحساب');
    try {
        const res = await fetch('/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, type })
        });
        const result = await res.json();
        if (result.id) {
            closeModal('addAccountModal');
            addAccountForm.reset();
            fetchAccounts();
        } else {
            alert('فشل إضافة الحساب: ' + (result.error || 'خطأ غير معروف'));
        }
    } catch (err) {
        alert('خطأ في الاتصال: ' + err.message);
    }
};
