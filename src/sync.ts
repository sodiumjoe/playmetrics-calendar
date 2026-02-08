import type { UnifiedEvent, CalendarResponse, EventType } from './types';
import type { PlayerCalendarMapping } from './config';
import { PLAYER_CALENDAR_MAP } from './config';
import {
  listEventsByICalUID,
  listEventsByExtendedProperty,
  importEvent,
  patchEvent,
  deleteEvent,
  GCalEvent,
} from './google-calendar';

const SYNC_SOURCE = 'playmetrics-calendar-extension';
const ATTENDING_STATUSES = new Set(['present', 'late']);
const MAX_LOG_ENTRIES = 100;

interface SyncLogEntry {
  time: number;
  op: string;
  summary: string;
  ok: boolean;
}

async function logSync(op: string, summary: string, ok = true): Promise<void> {
  const entry: SyncLogEntry = { time: Date.now(), op, summary, ok };
  const stored = await chrome.storage.local.get('syncLog');
  const log: SyncLogEntry[] = (stored.syncLog as SyncLogEntry[] | undefined) ?? [];
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ syncLog: log });
}

export function eventTypeKey(pmType: string): EventType {
  if (pmType === 'Practice') return 'practice';
  if (pmType === 'Game') return 'game';
  return 'calendar_event';
}

export function buildICalUID(eventType: EventType, eventId: number, playerId: number): string {
  return `playmetrics-${eventType}-${eventId}-${playerId}@playmetrics-sync`;
}

export function buildSummary(event: UnifiedEvent): string {
  if (event.type === 'Practice') {
    const field = event.details.field?.display_name ?? '';
    const parts = [event.team_name, 'Practice'];
    if (field) parts.push(`@ ${field}`);
    return parts.join(' ');
  }
  if (event.type === 'Game') {
    const opponent = event.details.opponent_team_name || 'TBD';
    const field = event.details.field?.display_name ?? '';
    const parts = [`${event.team_name} vs ${opponent}`];
    if (field) parts.push(`@ ${field}`);
    return parts.join(' ');
  }
  return event.summary || 'Event';
}

export function buildGoogleEvent(event: UnifiedEvent, playerId: number): GCalEvent {
  const evType = eventTypeKey(event.type);
  const timezone = event.timezone || event.details.field?.timezone || 'America/Los_Angeles';
  const location = event.details.location || event.details.field?.facility_address || '';

  const descriptionParts: string[] = [];
  if (event.details.description) descriptionParts.push(event.details.description);
  if (event.details.game_type) descriptionParts.push(event.details.game_type);
  if (event.details.uniform) descriptionParts.push(`Uniform: ${event.details.uniform}`);
  if (event.details.arrival_minutes) descriptionParts.push(`Arrive ${event.details.arrival_minutes} min early`);

  return {
    summary: buildSummary(event),
    location,
    description: descriptionParts.join('\n') || undefined,
    start: { dateTime: event.start_datetime, timeZone: timezone },
    end: { dateTime: event.end_datetime, timeZone: timezone },
    iCalUID: buildICalUID(evType, event.id, playerId),
    extendedProperties: {
      private: {
        playmetricsSyncSource: SYNC_SOURCE,
        playmetricsEventType: evType,
        playmetricsEventId: String(event.id),
        playmetricsPlayerId: String(playerId),
      },
    },
  };
}

export function eventsEqual(gcal: GCalEvent, fresh: GCalEvent): boolean {
  return (
    gcal.summary === fresh.summary &&
    gcal.location === fresh.location &&
    gcal.description === fresh.description &&
    gcal.start?.dateTime === fresh.start?.dateTime &&
    gcal.end?.dateTime === fresh.end?.dateTime
  );
}

export async function upsertEvent(
  calendarId: string,
  event: UnifiedEvent,
  playerId: number,
): Promise<void> {
  const gcalEvent = buildGoogleEvent(event, playerId);
  const existing = await listEventsByICalUID(calendarId, gcalEvent.iCalUID!);

  if (existing.length === 0) {
    const result = await importEvent(calendarId, gcalEvent);
    if (result) await logSync('import', gcalEvent.summary ?? '');
    else await logSync('import', gcalEvent.summary ?? '', false);
    return;
  }

  const current = existing[0];
  if (eventsEqual(current, gcalEvent)) {
    return;
  }

  const { iCalUID, ...patchBody } = gcalEvent;
  void iCalUID;
  const result = await patchEvent(calendarId, current.id!, patchBody);
  if (result) await logSync('patch', gcalEvent.summary ?? '');
  else await logSync('patch', gcalEvent.summary ?? '', false);
}

export function getAttendingEvents(
  calendarData: CalendarResponse,
  playerId: number,
): UnifiedEvent[] {
  const now = new Date();
  const seen = new Set<string>();
  const result: UnifiedEvent[] = [];

  for (const entry of calendarData) {
    for (const event of entry.events ?? []) {
      if (new Date(event.end_datetime) < now) continue;
      const key = `${event.type}-${event.id}`;
      if (seen.has(key)) continue;
      const avail = event.details.player_availability?.find((a) => a.player_id === playerId);
      if (avail && ATTENDING_STATUSES.has(avail.status)) {
        seen.add(key);
        result.push(event);
      }
    }
  }

  return result;
}

export async function fullSync(
  calendarData: CalendarResponse,
  mappings: PlayerCalendarMapping[],
): Promise<void> {
  for (const mapping of mappings) {
    if (!mapping.enabled) continue;

    const playerId = mapping.playmetricsPlayerId;
    const calendarId = mapping.googleCalendarId;
    const attending = getAttendingEvents(calendarData, playerId);
    const attendingIds = new Set(
      attending.map((a) => `${eventTypeKey(a.type)}-${a.id}`),
    );

    console.log(`[SYNC] ${mapping.label}: ${attending.length} attending events`);

    for (const event of attending) {
      await upsertEvent(calendarId, event, playerId);
    }

    const synced = await listEventsByExtendedProperty(
      calendarId,
      {
        playmetricsSyncSource: SYNC_SOURCE,
        playmetricsPlayerId: String(playerId),
      },
      new Date().toISOString(),
    );

    for (const gcalEvent of synced) {
      const props = gcalEvent.extendedProperties?.private;
      if (!props) continue;
      const key = `${props.playmetricsEventType}-${props.playmetricsEventId}`;
      if (!attendingIds.has(key)) {
        console.log(`[SYNC] Removing no-longer-attending: ${gcalEvent.summary}`);
        const ok = await deleteEvent(calendarId, gcalEvent.id!);
        await logSync('delete', gcalEvent.summary ?? '', ok);
      }
    }
  }

  await logSync('full-sync', `${mappings.filter(m => m.enabled).length} players`);
  console.log('[SYNC] Full sync complete');
}

export function findEventInCache(
  calendarData: CalendarResponse,
  eventType: EventType,
  eventId: number,
): UnifiedEvent | null {
  const pmType = eventType === 'practice' ? 'Practice' : eventType === 'game' ? 'Game' : 'GenericCalendarEvent';
  for (const entry of calendarData) {
    for (const event of entry.events ?? []) {
      if (event.type === pmType && event.id === eventId) return event;
    }
  }
  return null;
}

export async function targetedSync(
  eventType: EventType,
  eventId: number,
  playerId: number,
  status: string,
): Promise<void> {
  const mapping = PLAYER_CALENDAR_MAP.find(
    (m) => m.enabled && m.playmetricsPlayerId === playerId,
  );
  if (!mapping) {
    console.log(`[SYNC] No mapping for player ${playerId}, skipping targeted sync`);
    return;
  }

  const isAttending = ATTENDING_STATUSES.has(status);

  if (isAttending) {
    const stored = await chrome.storage.local.get('lastCalendarData');
    const calendarData = stored.lastCalendarData as CalendarResponse | undefined;
    if (!calendarData) {
      console.log('[SYNC] No cached calendar data for targeted sync, skipping');
      return;
    }

    const found = findEventInCache(calendarData, eventType, eventId);
    if (!found) {
      console.log(`[SYNC] Event ${eventType} ${eventId} not found in cache, skipping`);
      return;
    }

    console.log(`[SYNC] Targeted upsert: ${eventType} ${eventId} for player ${playerId}`);
    await upsertEvent(mapping.googleCalendarId, found, playerId);
  } else {
    const iCalUID = buildICalUID(eventType, eventId, playerId);
    const existing = await listEventsByICalUID(mapping.googleCalendarId, iCalUID);
    if (existing.length > 0) {
      console.log(`[SYNC] Targeted delete: ${eventType} ${eventId} for player ${playerId}`);
      await deleteEvent(mapping.googleCalendarId, existing[0].id!);
    } else {
      console.log(`[SYNC] Targeted delete: event not in Google Calendar, nothing to remove`);
    }
  }
}