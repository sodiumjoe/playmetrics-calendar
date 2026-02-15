import type {
  BackgroundMessage,
  CalendarResponse,
  FetchExternalEventsMessage,
  ApplyExternalImportsMessage,
  ExternalEventInfo,
  ApplyExternalImportsResponse,
} from './types';
import { PLAYER_CALENDAR_MAP, SYNC_INTERVAL_MINUTES } from './config';
import { fullSync, targetedSync, importExternalEvent, removeImportedEvent, syncExternalImports } from './sync';
import { listEvents, GCalEvent } from './google-calendar';

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
  try {
    await syncExternalImports();
  } catch (err) {
    console.error('[SYNC] External import sync failed:', err);
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
  | FetchExternalEventsMessage
  | ApplyExternalImportsMessage
  | { type: 'SYNC_NOW' }
  | { type: 'GOOGLE_AUTH_STATUS' }
  | { type: 'GOOGLE_AUTH_SIGN_IN' }
  | { type: 'GOOGLE_AUTH_SIGN_OUT' };

function gcalEventToInfo(ev: GCalEvent, sourceCalendarId: string): ExternalEventInfo {
  return {
    sourceCalendarId,
    sourceEventId: ev.id ?? '',
    summary: ev.summary ?? '',
    start: ev.start?.dateTime ?? '',
    end: ev.end?.dateTime ?? '',
    location: ev.location,
    description: ev.description,
    timeZone: ev.start?.timeZone,
  };
}

chrome.runtime.onMessage.addListener((message: AnyMessage, _sender, sendResponse) => {
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

    case 'FETCH_EXTERNAL_EVENTS': {
      const { sourceCalendarId, timeMin, timeMax } = message.payload;
      listEvents(sourceCalendarId, timeMin, timeMax)
        .then((events: GCalEvent[]) => {
          sendResponse(events.map(ev => gcalEventToInfo(ev, sourceCalendarId)));
        })
        .catch((err) => {
          console.error('[EXT] Fetch external events failed:', err);
          sendResponse([]);
        });
      return true;
    }

    case 'APPLY_EXTERNAL_IMPORTS': {
      const { targetCalendarId, toImport, toRemove } = message.payload;
      (async () => {
        const result: ApplyExternalImportsResponse = { imported: 0, removed: 0, errors: [] };
        for (const ev of toImport) {
          try {
            const ok = await importExternalEvent(ev, targetCalendarId);
            if (ok) result.imported++;
            else result.errors.push(`Import failed: ${ev.summary}`);
          } catch (err) {
            result.errors.push(`Import error: ${ev.summary}`);
            console.error('[EXT] Import error:', err);
          }
        }
        for (const key of toRemove) {
          try {
            const ok = await removeImportedEvent(key);
            if (ok) result.removed++;
            else result.errors.push(`Remove failed: ${key}`);
          } catch (err) {
            result.errors.push(`Remove error: ${key}`);
            console.error('[EXT] Remove error:', err);
          }
        }
        sendResponse(result);
      })();
      return true;
    }

    case 'GOOGLE_AUTH_STATUS': {
      (async () => {
        try {
          const result = await chrome.identity.getAuthToken({ interactive: false });
          sendResponse({ signedIn: !!result.token });
        } catch {
          sendResponse({ signedIn: false });
        }
      })();
      return true;
    }

    case 'GOOGLE_AUTH_SIGN_IN': {
      (async () => {
        try {
          await chrome.identity.getAuthToken({ interactive: true });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : 'Auth failed' });
        }
      })();
      return true;
    }

    case 'GOOGLE_AUTH_SIGN_OUT': {
      (async () => {
        try {
          const existing = await chrome.identity.getAuthToken({ interactive: false });
          if (existing.token) {
            await chrome.identity.removeCachedAuthToken({ token: existing.token });
            await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${existing.token}`).catch(() => {});
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : 'Sign out failed' });
        }
      })();
      return true;
    }
  }
});