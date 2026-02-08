import type { BackgroundMessage, CalendarResponse } from './types';
import { PLAYER_CALENDAR_MAP, SYNC_INTERVAL_MINUTES } from './config';
import { fullSync, targetedSync } from './sync';

const PM_CALENDAR_URL = 'https://api.playmetrics.com/user/calendars';
const PM_POPULATE = 'team,team:calendar_events,team:calendar_events:player_availability';
const ALARM_NAME = 'playmetrics-sync';

chrome.runtime.onInstalled.addListener(() => {
  console.log('PlayMetrics Calendar extension installed');
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES });
});

function redactToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.substring(0, 4) + '...' + token.substring(token.length - 4);
}

function summarizeCalendarData(data: CalendarResponse): void {
  let total = 0;
  const typeCounts: Record<string, number> = {};
  for (const entry of data) {
    const events = entry.events ?? [];
    total += events.length;
    for (const ev of events) {
      typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
    }
  }
  const breakdown = Object.entries(typeCounts).map(([t, c]) => `${c} ${t}`).join(', ');
  console.log(`[PM] Calendar data: ${data.length} teams, ${total} events (${breakdown})`);
}

function buildCalendarFilterParam(): string {
  const start = new Date();
  const end = new Date();
  end.setMonth(end.getMonth() + 6);
  const fmt = (d: Date) => d.toISOString().split('T')[0];
  return JSON.stringify({
    start_date: fmt(start),
    end_date: fmt(end),
    limit: 20,
    offset: 0,
    only_my_events: true,
  });
}

async function fetchPlayMetricsCalendar(): Promise<CalendarResponse | null> {
  const stored = await chrome.storage.local.get(['firebaseToken', 'accessKey']);
  if (!stored.firebaseToken || !stored.accessKey) {
    console.log('[PM] No stored auth tokens, skipping periodic fetch');
    return null;
  }

  const params = new URLSearchParams({
    populate: PM_POPULATE,
    calendar_filter: buildCalendarFilterParam(),
  });

  try {
    const resp = await fetch(`${PM_CALENDAR_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Firebase-Token': stored.firebaseToken as string,
        'pm-access-key': stored.accessKey as string,
      },
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.log('[PM] Auth token expired, clearing stored tokens');
        await chrome.storage.local.remove(['firebaseToken', 'accessKey']);
      } else {
        console.error(`[PM] Fetch failed: ${resp.status}`);
      }
      return null;
    }

    const data: CalendarResponse = await resp.json();
    return data;
  } catch (err) {
    console.error('[PM] Fetch error:', err);
    return null;
  }
}

async function periodicSync(): Promise<void> {
  console.log('[SYNC] Periodic sync starting');
  try {
    const data = await fetchPlayMetricsCalendar();
    if (!data) return;
    summarizeCalendarData(data);
    await chrome.storage.local.set({ lastCalendarData: data, lastSyncTime: Date.now() });
    await fullSync(data, PLAYER_CALENDAR_MAP);
  } catch (err) {
    console.error('[SYNC] Periodic sync failed:', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    periodicSync();
  }
});

const attendanceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 1500;

function debouncedTargetedSync(
  eventType: Parameters<typeof targetedSync>[0],
  eventId: number,
  playerId: number,
  status: string,
) {
  const key = `${eventType}-${eventId}-${playerId}`;
  const existing = attendanceTimers.get(key);
  if (existing) clearTimeout(existing);
  attendanceTimers.set(
    key,
    setTimeout(() => {
      attendanceTimers.delete(key);
      targetedSync(eventType, eventId, playerId, status).catch((err) =>
        console.error('[SYNC] Targeted sync failed:', err)
      );
    }, DEBOUNCE_MS),
  );
}

type AnyMessage =
  | BackgroundMessage
  | { type: 'SYNC_NOW' };

chrome.runtime.onMessage.addListener((message: AnyMessage) => {
  switch (message.type) {
    case 'AUTH_TOKEN': {
      const { firebaseToken, accessKey } = message.payload;
      console.log(`[PM] Auth captured: firebase=${redactToken(firebaseToken)} access=${redactToken(accessKey)}`);
      chrome.storage.local.set({ firebaseToken, accessKey });
      break;
    }

    case 'CALENDAR_DATA': {
      const { data } = message.payload;
      summarizeCalendarData(data);
      chrome.storage.local.set({ lastCalendarData: data, lastSyncTime: Date.now() });
      fullSync(data, PLAYER_CALENDAR_MAP).catch((err) =>
        console.error('[SYNC] Full sync failed:', err)
      );
      break;
    }

    case 'ATTENDANCE_UPDATE': {
      const { eventType, eventId, playerId, status } = message.payload;
      console.log(
        `[PM] Attendance update: ${eventType} ${eventId}, player ${playerId} → ${status}`
      );
      debouncedTargetedSync(eventType, eventId, playerId, status);
      break;
    }

    case 'SYNC_NOW': {
      periodicSync();
      break;
    }
  }
});