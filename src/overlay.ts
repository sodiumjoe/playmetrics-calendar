import { PLAYER_CALENDAR_MAP, EXTERNAL_CALENDARS } from './config';
import type { ExternalEventInfo, ImportedEventRecord, ApplyExternalImportsResponse } from './types';

const HOST_ID = 'pm-calendar-overlay-host';

const PANEL_HTML = `
<div class="panel-header">
  <h1>PlayMetrics Calendar</h1>
  <button id="panel-close">&times;</button>
</div>
<div class="panel-body">
  <div class="status-row">
    <span class="status-label">Google</span>
    <span id="google-status" class="status-value">-</span>
  </div>
  <div class="status-row">
    <span class="status-label">PlayMetrics</span>
    <span id="pm-status" class="status-value">-</span>
  </div>
  <div class="status-row">
    <span class="status-label">Last sync</span>
    <span id="last-sync" class="status-value">-</span>
  </div>
  <button id="google-auth-btn">Sign in with Google</button>
  <button id="sync-btn">Sync Now</button>
  <h2>Players</h2>
  <ul id="player-list" class="player-list"></ul>
  <div class="import-section">
    <h2>Import Events</h2>
    <div class="week-nav">
      <button id="week-prev">&larr;</button>
      <span id="week-label" class="week-label">-</span>
      <button id="week-next">&rarr;</button>
    </div>
    <div id="ext-events-container"></div>
    <button id="apply-btn" disabled>Apply</button>
    <div id="import-status"></div>
  </div>
  <h2>Recent Activity</h2>
  <div id="sync-log" class="log-list"></div>
  <div id="error"></div>
</div>
`;

const OVERLAY_CSS = `
  #pm-toggle {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    padding: 8px 14px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    width: auto;
  }
  #pm-toggle:hover { background: #1557b0; }
  #pm-panel {
    position: fixed;
    top: 10px;
    right: 10px;
    bottom: 60px;
    width: 360px;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: #333;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #pm-panel.hidden { display: none; }
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #eee;
    flex-shrink: 0;
  }
  .panel-header h1 { font-size: 15px; margin: 0; }
  .panel-header button {
    background: none;
    border: none;
    font-size: 20px;
    cursor: pointer;
    color: #666;
    padding: 0 4px;
    line-height: 1;
    width: auto;
    margin: 0;
  }
  .panel-header button:hover { color: #333; background: none; }
  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }
  h2 {
    font-size: 13px;
    margin: 12px 0 6px 0;
    color: #666;
  }
  .status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid #eee;
  }
  .status-label { color: #666; }
  .status-value { font-weight: 500; }
  .status-value.ok { color: #2e7d32; }
  .status-value.error { color: #c62828; }
  button {
    margin-top: 8px;
    padding: 8px 16px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 13px;
    width: 100%;
  }
  button:hover { background: #f5f5f5; }
  .log-list {
    max-height: 160px;
    overflow-y: auto;
    font-size: 11px;
    margin-top: 4px;
  }
  .log-entry {
    padding: 2px 0;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    justify-content: space-between;
  }
  .log-op { font-weight: 500; min-width: 50px; }
  .log-summary { flex: 1; margin: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-time { color: #999; white-space: nowrap; }
  .log-fail { color: #c62828; }
  #error { color: #c62828; margin-top: 8px; display: none; }
  .player-list { margin: 0; padding: 0; list-style: none; }
  .player-list li { padding: 3px 0; border-bottom: 1px solid #f0f0f0; }
  .import-section { margin-top: 12px; border-top: 1px solid #ddd; padding-top: 8px; }
  .week-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .week-nav button { width: auto; margin: 0; padding: 4px 10px; font-size: 12px; }
  .week-label { font-size: 12px; font-weight: 500; }
  .ext-cal-group { margin-bottom: 6px; }
  .ext-cal-label { font-size: 11px; font-weight: 600; color: #666; margin-bottom: 4px; }
  .ext-type-label { font-size: 10px; font-weight: 500; color: #999; text-transform: uppercase; letter-spacing: 0.5px; margin: 4px 0 2px 0; }
  .ext-events { max-height: 150px; overflow-y: auto; }
  .ext-event { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid #f5f5f5; font-size: 11px; }
  .ext-event input[type="checkbox"] { margin: 0; flex-shrink: 0; }
  .ext-event-time { color: #666; white-space: nowrap; min-width: 80px; }
  .ext-event-summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ext-event.imported .ext-event-summary { color: #2e7d32; }
  #import-status { font-size: 11px; margin-top: 4px; min-height: 14px; }
  #import-status.ok { color: #2e7d32; }
  #import-status.error { color: #c62828; }
  .ext-loading { font-size: 11px; color: #999; padding: 8px 0; }
  #apply-btn { margin-top: 4px; }
`;

if (!document.getElementById(HOST_ID)) {
  initOverlay();
}

function initOverlay() {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'pm-toggle';
  toggleBtn.textContent = 'PM Cal';
  shadow.appendChild(toggleBtn);

  const panel = document.createElement('div');
  panel.id = 'pm-panel';
  panel.classList.add('hidden');
  panel.innerHTML = PANEL_HTML;
  shadow.appendChild(panel);

  const root = shadow;
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;

  const googleStatus = $('google-status');
  const pmStatus = $('pm-status');
  const lastSyncEl = $('last-sync');
  const authBtn = $<HTMLButtonElement>('google-auth-btn');
  const syncBtn = $<HTMLButtonElement>('sync-btn');
  const playerListEl = $('player-list');
  const syncLogEl = $('sync-log');
  const errorDiv = $('error');
  const weekPrevBtn = $<HTMLButtonElement>('week-prev');
  const weekNextBtn = $<HTMLButtonElement>('week-next');
  const weekLabelEl = $('week-label');
  const extEventsContainer = $('ext-events-container');
  const applyBtn = $<HTMLButtonElement>('apply-btn');
  const importStatusEl = $('import-status');
  const closeBtn = $<HTMLButtonElement>('panel-close');

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
      const result: { signedIn: boolean } = await chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_STATUS' });
      if (result.signedIn) {
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

  function renderEventList(events: ExternalEventInfo[], sourceCalendarId: string, target: string): HTMLElement {
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
    weekLabelEl.textContent = `${formatDate(start)} \u2013 ${formatDate(end)}`;

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

  async function togglePanel() {
    const isHidden = panel.classList.toggle('hidden');
    await chrome.storage.local.set({ overlayVisible: !isHidden });
  }

  toggleBtn.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', togglePanel);

  authBtn.addEventListener('click', async () => {
    try {
      const status: { signedIn: boolean } = await chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_STATUS' });
      if (status.signedIn) {
        await chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_SIGN_OUT' });
      } else {
        const result: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_SIGN_IN' });
        if (!result.ok) {
          showError(result.error ?? 'Auth failed');
          return;
        }
      }
      await updateStatuses();
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

  weekPrevBtn.addEventListener('click', () => { weekOffset--; fetchExternalEvents(); });
  weekNextBtn.addEventListener('click', () => { weekOffset++; fetchExternalEvents(); });
  applyBtn.addEventListener('click', applyChanges);

  chrome.storage.local.get('overlayVisible').then(data => {
    if (data.overlayVisible) panel.classList.remove('hidden');
  });

  updateStatuses();
  renderPlayers();
  fetchExternalEvents();
}