import type { UnifiedEvent, CalendarResponse, EventType, ExternalEventInfo, ImportedEventRecord } from './types';
import type { PlayerCalendarMapping } from './config';
import { PLAYER_CALENDAR_MAP } from './config';
import {
  listEventsByICalUID,
  listEventsByExtendedProperty,
  getEvent,
  importEvent,
  insertEvent,
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

const EXT_IMPORT_SOURCE = 'external-calendar-import';

function extTrackingKey(sourceCalendarId: string, sourceEventId: string, targetCalendarId: string): string {
  return `${sourceCalendarId}:${sourceEventId}:${targetCalendarId}`;
}

async function getImportedRecords(): Promise<Record<string, ImportedEventRecord>> {
  const data = await chrome.storage.local.get('importedExternalEvents');
  return (data.importedExternalEvents as Record<string, ImportedEventRecord>) ?? {};
}

async function saveImportedRecords(records: Record<string, ImportedEventRecord>): Promise<void> {
  await chrome.storage.local.set({ importedExternalEvents: records });
}

export async function importExternalEvent(
  ev: ExternalEventInfo,
  targetCalendarId: string,
): Promise<boolean> {
  const eventBody: GCalEvent = {
    summary: ev.summary,
    location: ev.location,
    description: ev.description,
    start: { dateTime: ev.start, timeZone: ev.timeZone },
    end: { dateTime: ev.end, timeZone: ev.timeZone },
    extendedProperties: {
      private: {
        externalImportSource: EXT_IMPORT_SOURCE,
        externalSourceCalendarId: ev.sourceCalendarId,
        externalSourceEventId: ev.sourceEventId,
      },
    },
  };

  const created = await insertEvent(targetCalendarId, eventBody);
  if (!created) {
    await logSync('ext-import', ev.summary, false);
    return false;
  }

  const records = await getImportedRecords();
  const key = extTrackingKey(ev.sourceCalendarId, ev.sourceEventId, targetCalendarId);
  records[key] = {
    sourceCalendarId: ev.sourceCalendarId,
    sourceEventId: ev.sourceEventId,
    targetCalendarId,
    targetEventId: created.id!,
    summary: ev.summary,
    lastSynced: Date.now(),
  };
  await saveImportedRecords(records);
  await logSync('ext-import', ev.summary);
  return true;
}

export async function removeImportedEvent(trackingKey: string): Promise<boolean> {
  const records = await getImportedRecords();
  const record = records[trackingKey];
  if (!record) return false;

  const ok = await deleteEvent(record.targetCalendarId, record.targetEventId);
  delete records[trackingKey];
  await saveImportedRecords(records);
  await logSync('ext-remove', record.summary, ok);
  return ok;
}

export async function syncExternalImports(): Promise<void> {
  const records = await getImportedRecords();
  const keys = Object.keys(records);
  if (keys.length === 0) return;

  console.log(`[SYNC] Syncing ${keys.length} external imports`);
  let updated = false;

  for (const key of keys) {
    const record = records[key];
    const sourceEvent = await getEvent(record.sourceCalendarId, record.sourceEventId);

    if (!sourceEvent) {
      console.log(`[SYNC] Source event gone, removing: ${record.summary}`);
      const ok = await deleteEvent(record.targetCalendarId, record.targetEventId);
      await logSync('ext-delete', record.summary, ok);
      delete records[key];
      updated = true;
      continue;
    }

    const targetEvent = await getEvent(record.targetCalendarId, record.targetEventId);
    if (!targetEvent) {
      console.log(`[SYNC] Target event gone, removing tracking: ${record.summary}`);
      delete records[key];
      updated = true;
      continue;
    }

    const needsPatch =
      sourceEvent.summary !== targetEvent.summary ||
      sourceEvent.location !== targetEvent.location ||
      sourceEvent.description !== targetEvent.description ||
      sourceEvent.start?.dateTime !== targetEvent.start?.dateTime ||
      sourceEvent.end?.dateTime !== targetEvent.end?.dateTime;

    if (needsPatch) {
      console.log(`[SYNC] Updating external import: ${record.summary}`);
      const result = await patchEvent(record.targetCalendarId, record.targetEventId, {
        summary: sourceEvent.summary,
        location: sourceEvent.location,
        description: sourceEvent.description,
        start: sourceEvent.start,
        end: sourceEvent.end,
      });
      if (result) {
        record.summary = sourceEvent.summary ?? record.summary;
        record.lastSynced = Date.now();
        updated = true;
        await logSync('ext-patch', record.summary);
      } else {
        await logSync('ext-patch', record.summary, false);
      }
    }
  }

  if (updated) await saveImportedRecords(records);
  await chrome.storage.local.set({ lastExternalSyncTime: Date.now() });
  console.log('[SYNC] External import sync complete');
}