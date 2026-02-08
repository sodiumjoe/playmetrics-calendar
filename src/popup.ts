import { PLAYER_CALENDAR_MAP } from './config';

const googleStatus = document.getElementById('google-status')!;
const pmStatus = document.getElementById('pm-status')!;
const lastSyncEl = document.getElementById('last-sync')!;
const authBtn = document.getElementById('google-auth-btn') as HTMLButtonElement;
const syncBtn = document.getElementById('sync-btn') as HTMLButtonElement;
const playerListEl = document.getElementById('player-list')!;
const syncLogEl = document.getElementById('sync-log')!;
const errorDiv = document.getElementById('error')!;

function showError(msg: string) {
  errorDiv.textContent = msg;
  errorDiv.style.display = 'block';
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

async function updateStatuses() {
  const data = await chrome.storage.local.get([
    'firebaseToken', 'accessKey', 'lastSyncTime', 'syncLog',
  ]);

  if (data.firebaseToken && data.accessKey) {
    pmStatus.textContent = 'Connected';
    pmStatus.className = 'status-value ok';
  } else {
    pmStatus.textContent = 'Not captured';
    pmStatus.className = 'status-value error';
  }

  if (data.lastSyncTime) {
    lastSyncEl.textContent = timeAgo(data.lastSyncTime as number);
    lastSyncEl.className = 'status-value ok';
  } else {
    lastSyncEl.textContent = 'Never';
    lastSyncEl.className = 'status-value error';
  }

  try {
    const result = await chrome.identity.getAuthToken({ interactive: false });
    if (result.token) {
      googleStatus.textContent = 'Signed in';
      googleStatus.className = 'status-value ok';
      authBtn.textContent = 'Sign out of Google';
    } else {
      googleStatus.textContent = 'Not signed in';
      googleStatus.className = 'status-value error';
      authBtn.textContent = 'Sign in with Google';
    }
  } catch {
    googleStatus.textContent = 'Not signed in';
    googleStatus.className = 'status-value error';
    authBtn.textContent = 'Sign in with Google';
  }

  const log = (data.syncLog ?? []) as { time: number; op: string; summary: string; ok: boolean }[];
  syncLogEl.innerHTML = '';
  const recent = log.slice(-20).reverse();
  for (const entry of recent) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const failClass = entry.ok ? '' : ' log-fail';
    div.innerHTML = `<span class="log-op${failClass}">${entry.op}</span><span class="log-summary">${escapeHtml(entry.summary)}</span><span class="log-time">${timeAgo(entry.time)}</span>`;
    syncLogEl.appendChild(div);
  }
}

function renderPlayers() {
  playerListEl.innerHTML = '';
  for (const mapping of PLAYER_CALENDAR_MAP) {
    const li = document.createElement('li');
    li.textContent = `${mapping.label} (${mapping.enabled ? 'enabled' : 'disabled'})`;
    playerListEl.appendChild(li);
  }
}

authBtn.addEventListener('click', async () => {
  try {
    const existing = await chrome.identity.getAuthToken({ interactive: false });
    if (existing.token) {
      await chrome.identity.removeCachedAuthToken({ token: existing.token });
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${existing.token}`).catch(() => {});
      await updateStatuses();
    } else {
      await chrome.identity.getAuthToken({ interactive: true });
      await updateStatuses();
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Auth failed');
  }
});

syncBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
  syncBtn.textContent = 'Syncing...';
  setTimeout(() => {
    syncBtn.textContent = 'Sync Now';
    updateStatuses();
  }, 5000);
});

updateStatuses();
renderPlayers();