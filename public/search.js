let currentSearchTaskId = null;
let searchResults = [];
let isSearchPaused = false;

// Initialize search section
function initSearchSection() {
    document.getElementById('search-time-period').addEventListener('change', (e) => {
        const customDates = document.getElementById('search-custom-dates');
        customDates.classList.toggle('hidden', e.target.value !== 'custom');
    });

    document.getElementById('btn-start-search').addEventListener('click', startSearch);
    document.getElementById('btn-stop-search').addEventListener('click', stopSearch);
    document.getElementById('btn-pause-search').addEventListener('click', pauseSearch);
    document.getElementById('search-filter-url').addEventListener('input', filterSearchResults);
    document.getElementById('search-filter-type').addEventListener('change', filterSearchResults);
}

function renderSearchAccountSelector() {
    const selector = document.getElementById('search-account-selector');
    selector.innerHTML = accounts.filter(a => a.status === 'Connected').map(a => `
        <label class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 cursor-pointer">
            <input type="checkbox" name="search-accounts" value="${a.id}">
            <div class="text-right"><p class="text-xs font-bold text-white">${a.name}</p></div>
        </label>
    `).join('') || '<p class="text-red-500 text-xs">لا توجد حسابات متصلة</p>';
}

async function startSearch() {
    const accountIds = Array.from(document.querySelectorAll('input[name="search-accounts"]:checked')).map(i => i.value);
    if (accountIds.length === 0) return alert('اختر حساباً واحداً على الأقل');

    const scanType = document.getElementById('search-scan-type').value;
    const timePeriod = document.getElementById('search-time-period').value;
    const startDate = timePeriod === 'custom' ? document.getElementById('search-start-date').value : null;
    const endDate = timePeriod === 'custom' ? document.getElementById('search-end-date').value : null;

    const res = await fetch('/api/search/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accountIds,
            scanType,
            timePeriod,
            startDate,
            endDate
        })
    });

    const data = await res.json();
    if (data.taskId) {
        currentSearchTaskId = data.taskId;
        document.getElementById('btn-start-search').disabled = true;
        document.getElementById('btn-stop-search').disabled = false;
        document.getElementById('btn-pause-search').disabled = false;
        resetSearchDashboard();
        fetchSearchResults();
    } else if (data.error) {
        alert('خطأ: ' + data.error);
    }
}

async function stopSearch() {
    if (!currentSearchTaskId) return;
    await fetch(`/api/search/stop/${currentSearchTaskId}`, { method: 'POST' });
    currentSearchTaskId = null;
    document.getElementById('btn-start-search').disabled = false;
    document.getElementById('btn-stop-search').disabled = true;
    document.getElementById('btn-pause-search').disabled = true;
}

async function pauseSearch() {
    if (!currentSearchTaskId) return;
    const res = await fetch(`/api/search/pause/${currentSearchTaskId}`, { method: 'POST' });
    const data = await res.json();
    isSearchPaused = data.paused;
    document.getElementById('btn-pause-search').textContent = data.paused ? 'استئناف' : 'مؤقت';
}

function resetSearchDashboard() {
    document.getElementById('search-current-account').textContent = '-';
    document.getElementById('search-current-group').textContent = '-';
    document.getElementById('search-progress-percent').textContent = '0%';
    document.getElementById('search-completed-groups').textContent = '0';
    document.getElementById('search-messages-scanned').textContent = '0';
    document.getElementById('search-links-found').textContent = '0';
    document.getElementById('search-progress-bar').style.width = '0%';
    document.getElementById('search-progress-text').textContent = '0/0';
    document.getElementById('search-live-feed').innerHTML = '';
}

async function fetchSearchResults() {
    try {
        const res = await fetch('/api/search/results');
        const results = await res.json();
        searchResults = results;
        renderSearchResults(results);
    } catch (err) {
        console.error('Error fetching search results:', err);
    }
}

function renderSearchResults(results) {
    const tbody = document.getElementById('search-results-table');
    
    if (results.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-500">لا توجد نتائج</td></tr>';
        return;
    }

    tbody.innerHTML = results.map(r => `
        <tr class="hover:bg-white/5 transition-colors">
            <td class="px-4 py-3">
                <a href="${r.url}" target="_blank" class="text-blue-400 hover:text-blue-300 truncate max-w-xs block">
                    ${r.url.substring(0, 40)}...
                </a>
            </td>
            <td class="px-4 py-3">
                <span class="px-2 py-1 rounded text-[9px] bg-blue-500/20 text-blue-400">
                    ${r.link_type || 'عام'}
                </span>
            </td>
            <td class="px-4 py-3 text-[10px] truncate max-w-xs">${r.group_name || '-'}</td>
            <td class="px-4 py-3 text-center">${r.occurrence_count || 1}</td>
            <td class="px-4 py-3">
                <span class="px-2 py-1 rounded text-[9px] ${
                    r.join_status === 'Joined' ? 'bg-green-500/20 text-green-400' :
                    r.join_status === 'Failed' ? 'bg-red-500/20 text-red-400' :
                    'bg-yellow-500/20 text-yellow-400'
                }">
                    ${r.join_status || 'لم يتم'}
                </span>
            </td>
            <td class="px-4 py-3 text-center">
                <button onclick="deleteSearchResult('${r.id}')" class="text-slate-500 hover:text-red-500 text-[10px]">حذف</button>
            </td>
        </tr>
    `).join('');
}

function filterSearchResults() {
    const searchUrl = document.getElementById('search-filter-url').value.toLowerCase();
    const filterType = document.getElementById('search-filter-type').value;

    const filtered = searchResults.filter(r => {
        const matchUrl = !searchUrl || r.url.toLowerCase().includes(searchUrl);
        const matchType = !filterType || r.link_type === filterType;
        return matchUrl && matchType;
    });

    renderSearchResults(filtered);
}

async function deleteSearchResult(resultId) {
    if (!confirm('هل تريد حذف هذا الرابط؟')) return;
    
    await fetch(`/api/search/result/${resultId}`, { method: 'DELETE' });
    fetchSearchResults();
}

async function exportSearchResults() {
    if (!currentSearchTaskId) return alert('لا توجد نتائج للتصدير');
    
    const res = await fetch(`/api/search/export/${currentSearchTaskId}?format=csv`);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'search-results.csv';
    a.click();
}

// Socket.IO listeners for real-time updates
socket.on('search-task-status', (data) => {
    if (data.taskId !== currentSearchTaskId) return;
    
    document.getElementById('search-current-account').textContent = data.currentAccount || '-';
    document.getElementById('search-current-group').textContent = data.currentGroup || '-';
    document.getElementById('search-links-found').textContent = data.stats?.linksFound || 0;
});

socket.on('search-task-progress', (data) => {
    if (data.taskId !== currentSearchTaskId) return;
    
    const { stats, groupProgress } = data;
    const [completed, total] = groupProgress.split('/').map(Number);
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    document.getElementById('search-current-account').textContent = data.currentAccount || '-';
    document.getElementById('search-current-group').textContent = data.currentGroup || '-';
    document.getElementById('search-progress-percent').textContent = percent + '%';
    document.getElementById('search-completed-groups').textContent = stats?.completedGroups || 0;
    document.getElementById('search-messages-scanned').textContent = stats?.messagesScanned || 0;
    document.getElementById('search-links-found').textContent = stats?.linksFound || 0;
    document.getElementById('search-progress-bar').style.width = percent + '%';
    document.getElementById('search-progress-text').textContent = `${completed}/${total}`;
});

socket.on('search-task-link-found', (data) => {
    if (data.taskId !== currentSearchTaskId) return;
    
    const feed = document.getElementById('search-live-feed');
    const div = document.createElement('div');
    div.className = 'p-2 bg-white/5 rounded border-r-2 border-blue-500 text-[9px]';
    div.innerHTML = `🔗 ${data.url.substring(0, 50)}... (${data.linkType})`;
    feed.prepend(div);
    
    if (feed.children.length > 50) {
        feed.removeChild(feed.lastChild);
    }
});

socket.on('search-task-finished', (data) => {
    if (data.taskId !== currentSearchTaskId) return;
    
    currentSearchTaskId = null;
    document.getElementById('btn-start-search').disabled = false;
    document.getElementById('btn-stop-search').disabled = true;
    document.getElementById('btn-pause-search').disabled = true;
    document.getElementById('btn-pause-search').textContent = 'مؤقت';
    
    const feed = document.getElementById('search-live-feed');
    const div = document.createElement('div');
    div.className = 'p-2 bg-green-500/20 rounded border-r-2 border-green-500 text-[9px]';
    div.innerHTML = `✓ اكتمل البحث - ${data.stats?.linksFound || 0} رابط`;
    feed.prepend(div);
    
    fetchSearchResults();
});

socket.on('search-task-error', (data) => {
    if (data.taskId !== currentSearchTaskId) return;
    
    const feed = document.getElementById('search-live-feed');
    const div = document.createElement('div');
    div.className = 'p-2 bg-red-500/20 rounded border-r-2 border-red-500 text-[9px]';
    div.innerHTML = `✗ خطأ: ${data.message}`;
    feed.prepend(div);
});

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('search-account-selector')) {
        initSearchSection();
    }
});

// Update account selector when accounts change
const originalFetchAccounts = window.fetchAccounts;
window.fetchAccounts = async function() {
    await originalFetchAccounts.call(this);
    renderSearchAccountSelector();
};
