import { PLAYER_CALENDAR_MAP, EXTERNAL_CALENDARS } from './config';
import type { ExternalEventInfo, ImportedEventRecord, ApplyExternalImportsResponse } from './types';

const googleStatus = document.getElementById('google-status')!;
const pmStatus = document.getElementById('pm-status')!;
const lastSyncEl = document.getElementById('last-sync')!;
const authBtn = document.getElementById('google-auth-btn') as HTMLButtonElement;
const syncBtn = document.getElementById('sync-btn') as HTMLButtonElement;
const playerListEl = document.getElementById('player-list')!;
const syncLogEl = document.getElementById('sync-log')!;
const errorDiv = document.getElementById('error')!;

const weekPrevBtn = document.getElementById('week-prev') as HTMLButtonElement;
const weekNextBtn = document.getElementById('week-next') as HTMLButtonElement;
const weekLabelEl = document.getElementById('week-label')!;
const extEventsContainer = document.getElementById('ext-events-container')!;
const applyBtn = document.getElementById('apply-btn') as HTMLButtonElement;
const importStatusEl = document.getElementById('import-status')!;

let weekOffset = 0;
const fetchedEvents: Map<string, ExternalEventInfo[]> = new Map();
let importedRecords: Record<string, ImportedEventRecord> = {};

const sourceToTarget: Map<string, string> = new Map();
for (const cal of EXTERNAL_CALENDARS) {
  sourceToTarget.set(cal.sourceCalendarId, cal.defaultTargetCalendarId);
}

function getTargetForSource(sourceCalendarId: string): string {
  return sourceToTarget.get(sourceCalendarId) ?? PLAYER_CALENDAR_MAP[0]?.googleCalendarId ?? '';
}

function getTargetLabel(targetCalendarId: string): string {
  return PLAYER_CALENDAR_MAP.find(m => m.googleCalendarId === targetCalendarId)?.label ?? 'Unknown';
}

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

function getWeekBounds(offset: number): { start: Date; end: Date } {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + offset * 14);
  const end = new Date(monday);
  end.setDate(end.getDate() + 14);
  return { start: monday, end };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatEventTime(isoString: string): string {
  const d = new Date(isoString);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
}

function trackingKey(sourceCalendarId: string, sourceEventId: string, targetCalendarId: string): string {
  return `${sourceCalendarId}:${sourceEventId}:${targetCalendarId}`;
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

function classifyEvent(summary: string): 'Games' | 'Practices' | 'Other' {
  const s = summary.toLowerCase();
  if (s.includes(' vs ') || s.includes(' v ') || s.startsWith('game')) return 'Games';
  if (s.includes('practice') || s.includes('training')) return 'Practices';
  return 'Other';
}

function renderEventList(
  events: ExternalEventInfo[],
  sourceCalendarId: string,
  target: string,
): HTMLElement {
  const list = document.createElement('div');
  list.className = 'ext-events';
  for (const ev of events) {
    const row = document.createElement('label');
    const imported = trackingKey(sourceCalendarId, ev.sourceEventId, target) in importedRecords;
    row.className = 'ext-event' + (imported ? ' imported' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = imported;
    cb.dataset.sourceCalendarId = sourceCalendarId;
    cb.dataset.sourceEventId = ev.sourceEventId;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'ext-event-time';
    timeSpan.textContent = formatEventTime(ev.start);

    const summarySpan = document.createElement('span');
    summarySpan.className = 'ext-event-summary';
    summarySpan.textContent = ev.summary;

    row.appendChild(cb);
    row.appendChild(timeSpan);
    row.appendChild(summarySpan);
    list.appendChild(row);
  }
  return list;
}

function renderExtEvents() {
  extEventsContainer.innerHTML = '';

  for (const cal of EXTERNAL_CALENDARS) {
    const events = fetchedEvents.get(cal.sourceCalendarId) ?? [];
    const target = getTargetForSource(cal.sourceCalendarId);
    const group = document.createElement('div');
    group.className = 'ext-cal-group';

    const label = document.createElement('div');
    label.className = 'ext-cal-label';
    label.textContent = `${cal.label} \u2192 ${getTargetLabel(target)}`;
    group.appendChild(label);

    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ext-loading';
      empty.textContent = 'No events';
      group.appendChild(empty);
    } else {
      const byType: Record<string, ExternalEventInfo[]> = { Games: [], Practices: [], Other: [] };
      for (const ev of events) {
        byType[classifyEvent(ev.summary)].push(ev);
      }
      for (const type of ['Games', 'Practices', 'Other'] as const) {
        const typeEvents = byType[type];
        if (typeEvents.length === 0) continue;
        const typeLabel = document.createElement('div');
        typeLabel.className = 'ext-type-label';
        typeLabel.textContent = `${type} (${typeEvents.length})`;
        group.appendChild(typeLabel);
        group.appendChild(renderEventList(typeEvents, cal.sourceCalendarId, target));
      }
    }

    extEventsContainer.appendChild(group);
  }

  applyBtn.disabled = false;
}

async function loadImportedRecords() {
  const data = await chrome.storage.local.get('importedExternalEvents');
  importedRecords = (data.importedExternalEvents as Record<string, ImportedEventRecord>) ?? {};
}

async function fetchExternalEvents() {
  const { start, end } = getWeekBounds(weekOffset);
  weekLabelEl.textContent = `${formatDate(start)} – ${formatDate(end)}`;

  extEventsContainer.innerHTML = '<div class="ext-loading">Loading...</div>';
  applyBtn.disabled = true;
  importStatusEl.textContent = '';
  importStatusEl.className = 'import-status';

  fetchedEvents.clear();
  await loadImportedRecords();

  const timeMin = start.toISOString();
  const timeMax = end.toISOString();

  const results = await Promise.allSettled(
    EXTERNAL_CALENDARS.map(cal =>
      chrome.runtime.sendMessage({
        type: 'FETCH_EXTERNAL_EVENTS',
        payload: { sourceCalendarId: cal.sourceCalendarId, timeMin, timeMax },
      }).then((resp: ExternalEventInfo[]) => {
        fetchedEvents.set(cal.sourceCalendarId, resp);
      })
    )
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Failed to fetch external events:', result.reason);
    }
  }

  renderExtEvents();
}

function getCheckboxState(): { toImport: { ev: ExternalEventInfo; targetCalendarId: string }[]; toRemove: string[] } {
  const toImport: { ev: ExternalEventInfo; targetCalendarId: string }[] = [];
  const toRemove: string[] = [];

  const checkboxes = Array.from(extEventsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  for (const cb of checkboxes) {
    const sourceCalendarId = cb.dataset.sourceCalendarId!;
    const sourceEventId = cb.dataset.sourceEventId!;
    const target = getTargetForSource(sourceCalendarId);
    const key = trackingKey(sourceCalendarId, sourceEventId, target);
    const wasImported = key in importedRecords;

    if (cb.checked && !wasImported) {
      const events = fetchedEvents.get(sourceCalendarId) ?? [];
      const ev = events.find(e => e.sourceEventId === sourceEventId);
      if (ev) toImport.push({ ev, targetCalendarId: target });
    } else if (!cb.checked && wasImported) {
      toRemove.push(key);
    }
  }

  return { toImport, toRemove };
}

async function applyChanges() {
  const { toImport, toRemove } = getCheckboxState();
  if (toImport.length === 0 && toRemove.length === 0) {
    importStatusEl.textContent = 'No changes';
    importStatusEl.className = 'import-status';
    return;
  }

  applyBtn.disabled = true;
  applyBtn.textContent = 'Applying...';
  importStatusEl.textContent = '';

  try {
    const byTarget = new Map<string, ExternalEventInfo[]>();
    for (const item of toImport) {
      const list = byTarget.get(item.targetCalendarId) ?? [];
      list.push(item.ev);
      byTarget.set(item.targetCalendarId, list);
    }

    let totalImported = 0;
    let totalRemoved = 0;
    const allErrors: string[] = [];

    for (const [targetCalendarId, events] of byTarget) {
      const resp: ApplyExternalImportsResponse = await chrome.runtime.sendMessage({
        type: 'APPLY_EXTERNAL_IMPORTS',
        payload: { targetCalendarId, toImport: events, toRemove: [] },
      });
      totalImported += resp.imported;
      allErrors.push(...resp.errors);
    }

    if (toRemove.length > 0) {
      const resp: ApplyExternalImportsResponse = await chrome.runtime.sendMessage({
        type: 'APPLY_EXTERNAL_IMPORTS',
        payload: { targetCalendarId: '', toImport: [], toRemove },
      });
      totalRemoved += resp.removed;
      allErrors.push(...resp.errors);
    }

    const parts: string[] = [];
    if (totalImported > 0) parts.push(`Imported ${totalImported}`);
    if (totalRemoved > 0) parts.push(`Removed ${totalRemoved}`);
    if (allErrors.length > 0) parts.push(`${allErrors.length} failed`);

    importStatusEl.textContent = parts.join(', ');
    importStatusEl.className = allErrors.length > 0 ? 'import-status error' : 'import-status ok';

    await loadImportedRecords();
    renderExtEvents();
    updateStatuses();
  } catch (err) {
    importStatusEl.textContent = err instanceof Error ? err.message : 'Apply failed';
    importStatusEl.className = 'import-status error';
  } finally {
    applyBtn.textContent = 'Apply';
    applyBtn.disabled = false;
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
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastSyncTime) {
    syncBtn.textContent = 'Sync Now';
    updateStatuses();
  }
});

weekPrevBtn.addEventListener('click', () => { weekOffset--; fetchExternalEvents(); });
weekNextBtn.addEventListener('click', () => { weekOffset++; fetchExternalEvents(); });

applyBtn.addEventListener('click', applyChanges);

updateStatuses();
renderPlayers();
fetchExternalEvents();