import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UnifiedEvent, CalendarResponse } from '../types';
import {
  eventTypeKey,
  buildICalUID,
  buildSummary,
  buildGoogleEvent,
  eventsEqual,
  getAttendingEvents,
  findEventInCache,
  importExternalEvent,
  removeImportedEvent,
  syncExternalImports,
} from '../sync';
import type { ExternalEventInfo } from '../types';

vi.mock('../config', () => ({
  PLAYER_CALENDAR_MAP: [
    { playmetricsPlayerId: 100, googleCalendarId: 'cal-100@group', label: 'Player A', enabled: true },
    { playmetricsPlayerId: 200, googleCalendarId: 'cal-200@group', label: 'Player B', enabled: true },
  ],
}));

vi.mock('../google-calendar', () => ({
  listEventsByICalUID: vi.fn(async () => []),
  listEventsByExtendedProperty: vi.fn(async () => []),
  getEvent: vi.fn(async () => null),
  importEvent: vi.fn(async () => ({ id: 'gcal-1' })),
  insertEvent: vi.fn(async () => ({ id: 'inserted-1' })),
  patchEvent: vi.fn(async () => ({ id: 'gcal-1' })),
  deleteEvent: vi.fn(async () => true),
}));

const mockInsertEvent = vi.mocked((await import('../google-calendar')).insertEvent);
const mockDeleteEvent = vi.mocked((await import('../google-calendar')).deleteEvent);
const mockGetEvent = vi.mocked((await import('../google-calendar')).getEvent);
const mockPatchEvent = vi.mocked((await import('../google-calendar')).patchEvent);

function makeEvent(overrides: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    type: 'Practice',
    id: 1,
    team_id: 10,
    team_name: 'Team Alpha',
    team_itinerary_id: 0,
    summary: '',
    start_datetime: '2099-06-01T18:00:00Z',
    end_datetime: '2099-06-01T19:30:00Z',
    timezone: 'America/Los_Angeles',
    guest_team_players: [],
    details: {
      player_availability: [],
      field: {
        id: 1,
        facility_id: 1,
        facility_name: 'Park',
        facility_address: '123 Main St',
        timezone: 'America/Los_Angeles',
        identifier: 'F1',
        display_name: 'Park F1',
        surface: 'grass',
        latitude: 0,
        longitude: 0,
      },
    },
    created_at: '2099-01-01T00:00:00Z',
    updated_at: '2099-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCalendarData(events: UnifiedEvent[]): CalendarResponse {
  return [
    {
      name: 'Team Alpha',
      team: {
        id: 10,
        club_id: 1,
        season_id: 1,
        sport: 'soccer',
        name: 'Team Alpha',
        gender: 'M',
        level: 'Competitive',
        team_players: [],
        calendar_url: '',
      },
      events,
      color: '#000',
      is_guest: false,
    },
  ];
}

describe('eventTypeKey', () => {
  it('maps Practice', () => {
    expect(eventTypeKey('Practice')).toBe('practice');
  });

  it('maps Game', () => {
    expect(eventTypeKey('Game')).toBe('game');
  });

  it('maps GenericCalendarEvent', () => {
    expect(eventTypeKey('GenericCalendarEvent')).toBe('calendar_event');
  });

  it('maps unknown types to calendar_event', () => {
    expect(eventTypeKey('Something')).toBe('calendar_event');
  });
});

describe('buildICalUID', () => {
  it('produces deterministic UID', () => {
    expect(buildICalUID('practice', 123, 456)).toBe(
      'playmetrics-practice-123-456@playmetrics-sync',
    );
  });

  it('differs by event type', () => {
    const a = buildICalUID('practice', 1, 1);
    const b = buildICalUID('game', 1, 1);
    expect(a).not.toBe(b);
  });

  it('differs by player id', () => {
    const a = buildICalUID('practice', 1, 100);
    const b = buildICalUID('practice', 1, 200);
    expect(a).not.toBe(b);
  });
});

describe('buildSummary', () => {
  it('builds practice summary with field', () => {
    const event = makeEvent({ type: 'Practice', team_name: '2012 Boys' });
    expect(buildSummary(event)).toBe('2012 Boys Practice @ Park F1');
  });

  it('builds practice summary without field', () => {
    const event = makeEvent({
      type: 'Practice',
      team_name: '2012 Boys',
      details: { player_availability: [] },
    });
    expect(buildSummary(event)).toBe('2012 Boys Practice');
  });

  it('builds game summary with opponent and field', () => {
    const event = makeEvent({
      type: 'Game',
      team_name: '2012 Boys',
      details: {
        player_availability: [],
        opponent_team_name: 'Rivals FC',
        field: {
          id: 1, facility_id: 1, facility_name: 'Park', facility_address: '123 Main St',
          timezone: 'America/Los_Angeles', identifier: 'F1', display_name: 'Park F1',
          surface: 'grass', latitude: 0, longitude: 0,
        },
      },
    });
    expect(buildSummary(event)).toBe('2012 Boys vs Rivals FC @ Park F1');
  });

  it('builds game summary with TBD opponent when missing', () => {
    const event = makeEvent({
      type: 'Game',
      details: { player_availability: [], opponent_team_name: '' },
    });
    expect(buildSummary(event)).toBe('Team Alpha vs TBD');
  });

  it('uses event summary for GenericCalendarEvent', () => {
    const event = makeEvent({
      type: 'GenericCalendarEvent',
      summary: 'Team Meeting',
    });
    expect(buildSummary(event)).toBe('Team Meeting');
  });

  it('falls back to Event for GenericCalendarEvent with no summary', () => {
    const event = makeEvent({
      type: 'GenericCalendarEvent',
      summary: '',
    });
    expect(buildSummary(event)).toBe('Event');
  });
});

describe('buildGoogleEvent', () => {
  it('builds correct structure for a practice', () => {
    const event = makeEvent({ id: 42, type: 'Practice' });
    const result = buildGoogleEvent(event, 100);

    expect(result.iCalUID).toBe('playmetrics-practice-42-100@playmetrics-sync');
    expect(result.summary).toBe('Team Alpha Practice @ Park F1');
    expect(result.location).toBe('123 Main St');
    expect(result.start).toEqual({
      dateTime: '2099-06-01T18:00:00Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(result.end).toEqual({
      dateTime: '2099-06-01T19:30:00Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(result.extendedProperties?.private).toEqual({
      playmetricsSyncSource: 'playmetrics-calendar-extension',
      playmetricsEventType: 'practice',
      playmetricsEventId: '42',
      playmetricsPlayerId: '100',
    });
  });

  it('includes game-specific details in description', () => {
    const event = makeEvent({
      type: 'Game',
      details: {
        player_availability: [],
        game_type: 'League Match',
        uniform: 'White kit',
        arrival_minutes: 15,
        field: {
          id: 1, facility_id: 1, facility_name: 'Park', facility_address: '123 Main St',
          timezone: 'America/Los_Angeles', identifier: 'F1', display_name: 'Park F1',
          surface: 'grass', latitude: 0, longitude: 0,
        },
      },
    });
    const result = buildGoogleEvent(event, 100);
    expect(result.description).toContain('League Match');
    expect(result.description).toContain('Uniform: White kit');
    expect(result.description).toContain('Arrive 15 min early');
  });

  it('uses event timezone over field timezone', () => {
    const event = makeEvent({ timezone: 'America/New_York' });
    const result = buildGoogleEvent(event, 100);
    expect(result.start?.timeZone).toBe('America/New_York');
  });

  it('falls back to field timezone when event timezone is empty', () => {
    const event = makeEvent({ timezone: '' });
    const result = buildGoogleEvent(event, 100);
    expect(result.start?.timeZone).toBe('America/Los_Angeles');
  });
});

describe('eventsEqual', () => {
  it('returns true for identical events', () => {
    const a = { summary: 'X', location: 'Y', description: 'Z', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } };
    const b = { ...a };
    expect(eventsEqual(a, b)).toBe(true);
  });

  it('returns false when summary differs', () => {
    const a = { summary: 'X', location: 'Y', description: 'Z', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } };
    const b = { ...a, summary: 'Changed' };
    expect(eventsEqual(a, b)).toBe(false);
  });

  it('returns false when start time differs', () => {
    const a = { summary: 'X', location: 'Y', description: 'Z', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } };
    const b = { ...a, start: { dateTime: 'T3' } };
    expect(eventsEqual(a, b)).toBe(false);
  });

  it('returns false when location differs', () => {
    const a = { summary: 'X', location: 'Y', description: 'Z', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } };
    const b = { ...a, location: 'Elsewhere' };
    expect(eventsEqual(a, b)).toBe(false);
  });
});

describe('getAttendingEvents', () => {
  const playerId = 100;

  it('returns events where player is present', () => {
    const event = makeEvent({
      details: {
        player_availability: [{ player_id: playerId, status: 'present', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data = makeCalendarData([event]);
    const result = getAttendingEvents(data, playerId);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(event.id);
  });

  it('returns events where player is late', () => {
    const event = makeEvent({
      details: {
        player_availability: [{ player_id: playerId, status: 'late', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data = makeCalendarData([event]);
    expect(getAttendingEvents(data, playerId)).toHaveLength(1);
  });

  it('excludes events where player is absent', () => {
    const event = makeEvent({
      details: {
        player_availability: [{ player_id: playerId, status: 'absent', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data = makeCalendarData([event]);
    expect(getAttendingEvents(data, playerId)).toHaveLength(0);
  });

  it('excludes events where player status is empty', () => {
    const event = makeEvent({
      details: {
        player_availability: [{ player_id: playerId, status: '', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data = makeCalendarData([event]);
    expect(getAttendingEvents(data, playerId)).toHaveLength(0);
  });

  it('excludes past events', () => {
    const event = makeEvent({
      end_datetime: '2020-01-01T00:00:00Z',
      details: {
        player_availability: [{ player_id: playerId, status: 'present', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data = makeCalendarData([event]);
    expect(getAttendingEvents(data, playerId)).toHaveLength(0);
  });

  it('deduplicates events with same type and id across teams', () => {
    const event = makeEvent({
      id: 99,
      type: 'GenericCalendarEvent',
      details: {
        player_availability: [{ player_id: playerId, status: 'present', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data: CalendarResponse = [
      ...makeCalendarData([event]),
      ...makeCalendarData([{ ...event }]),
    ];
    const result = getAttendingEvents(data, playerId);
    expect(result).toHaveLength(1);
  });

  it('excludes events where player has no availability entry', () => {
    const event = makeEvent({
      details: {
        player_availability: [{ player_id: 999, status: 'present', notes: '', updated_at: null, health_screen_passed_at: null }],
      },
    });
    const data = makeCalendarData([event]);
    expect(getAttendingEvents(data, playerId)).toHaveLength(0);
  });
});

describe('findEventInCache', () => {
  it('finds a practice by type and id', () => {
    const event = makeEvent({ id: 42, type: 'Practice' });
    const data = makeCalendarData([event]);
    const result = findEventInCache(data, 'practice', 42);
    expect(result).toBe(event);
  });

  it('finds a game by type and id', () => {
    const event = makeEvent({ id: 7, type: 'Game' });
    const data = makeCalendarData([event]);
    expect(findEventInCache(data, 'game', 7)).toBe(event);
  });

  it('finds a GenericCalendarEvent', () => {
    const event = makeEvent({ id: 3, type: 'GenericCalendarEvent' });
    const data = makeCalendarData([event]);
    expect(findEventInCache(data, 'calendar_event', 3)).toBe(event);
  });

  it('returns null when not found', () => {
    const data = makeCalendarData([makeEvent({ id: 1 })]);
    expect(findEventInCache(data, 'practice', 999)).toBeNull();
  });

  it('returns null for wrong type', () => {
    const event = makeEvent({ id: 1, type: 'Practice' });
    const data = makeCalendarData([event]);
    expect(findEventInCache(data, 'game', 1)).toBeNull();
  });
});

function makeExternalEvent(overrides: Partial<ExternalEventInfo> = {}): ExternalEventInfo {
  return {
    sourceCalendarId: 'src-cal-1@group',
    sourceEventId: 'ext-event-1',
    summary: 'External Game',
    start: '2026-03-15T18:00:00Z',
    end: '2026-03-15T20:00:00Z',
    location: 'Stadium',
    description: 'League match',
    timeZone: 'America/Los_Angeles',
    ...overrides,
  };
}

describe('importExternalEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertEvent.mockResolvedValue({ id: 'inserted-1' });
    const store = chrome.storage.local as unknown as { _store: Record<string, unknown> };
    store._store = {};
  });

  it('inserts event and stores tracking record', async () => {
    const ev = makeExternalEvent();
    const result = await importExternalEvent(ev, 'target-cal@group');
    expect(result).toBe(true);
    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [calId, body] = mockInsertEvent.mock.calls[0];
    expect(calId).toBe('target-cal@group');
    expect(body.summary).toBe('External Game');
    expect(body.extendedProperties?.private?.externalImportSource).toBe('external-calendar-import');
    expect(body.extendedProperties?.private?.externalSourceEventId).toBe('ext-event-1');

    const data = await chrome.storage.local.get('importedExternalEvents');
    const records = data.importedExternalEvents as Record<string, unknown>;
    const key = 'src-cal-1@group:ext-event-1:target-cal@group';
    expect(records[key]).toBeDefined();
  });

  it('returns false when insertEvent fails', async () => {
    mockInsertEvent.mockResolvedValue(null);
    const ev = makeExternalEvent();
    const result = await importExternalEvent(ev, 'target-cal@group');
    expect(result).toBe(false);
  });
});

describe('removeImportedEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteEvent.mockResolvedValue(true);
    const store = chrome.storage.local as unknown as { _store: Record<string, unknown> };
    store._store = {};
  });

  it('deletes event and removes tracking record', async () => {
    const key = 'src-cal@group:ev-1:target-cal@group';
    await chrome.storage.local.set({
      importedExternalEvents: {
        [key]: {
          sourceCalendarId: 'src-cal@group',
          sourceEventId: 'ev-1',
          targetCalendarId: 'target-cal@group',
          targetEventId: 'gcal-target-1',
          summary: 'Test Event',
          lastSynced: Date.now(),
        },
      },
    });

    const result = await removeImportedEvent(key);
    expect(result).toBe(true);
    expect(mockDeleteEvent).toHaveBeenCalledWith('target-cal@group', 'gcal-target-1');

    const data = await chrome.storage.local.get('importedExternalEvents');
    const records = data.importedExternalEvents as Record<string, unknown>;
    expect(records[key]).toBeUndefined();
  });

  it('returns false for unknown tracking key', async () => {
    const result = await removeImportedEvent('nonexistent-key');
    expect(result).toBe(false);
  });
});

describe('syncExternalImports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store = chrome.storage.local as unknown as { _store: Record<string, unknown> };
    store._store = {};
  });

  it('does nothing when no imported records exist', async () => {
    await syncExternalImports();
    expect(mockGetEvent).not.toHaveBeenCalled();
  });

  it('deletes target when source event is gone', async () => {
    const key = 'src-cal@group:ev-1:target-cal@group';
    await chrome.storage.local.set({
      importedExternalEvents: {
        [key]: {
          sourceCalendarId: 'src-cal@group',
          sourceEventId: 'ev-1',
          targetCalendarId: 'target-cal@group',
          targetEventId: 'gcal-target-1',
          summary: 'Gone Event',
          lastSynced: Date.now(),
        },
      },
    });
    mockGetEvent.mockResolvedValue(null);
    mockDeleteEvent.mockResolvedValue(true);

    await syncExternalImports();
    expect(mockDeleteEvent).toHaveBeenCalledWith('target-cal@group', 'gcal-target-1');

    const data = await chrome.storage.local.get('importedExternalEvents');
    const records = data.importedExternalEvents as Record<string, unknown>;
    expect(records[key]).toBeUndefined();
  });

  it('patches target when source event changed', async () => {
    const key = 'src-cal@group:ev-1:target-cal@group';
    await chrome.storage.local.set({
      importedExternalEvents: {
        [key]: {
          sourceCalendarId: 'src-cal@group',
          sourceEventId: 'ev-1',
          targetCalendarId: 'target-cal@group',
          targetEventId: 'gcal-target-1',
          summary: 'Old Summary',
          lastSynced: Date.now(),
        },
      },
    });

    mockGetEvent
      .mockResolvedValueOnce({ id: 'ev-1', summary: 'New Summary', location: 'New Place', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } })
      .mockResolvedValueOnce({ id: 'gcal-target-1', summary: 'Old Summary', location: 'Old Place', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } });
    mockPatchEvent.mockResolvedValue({ id: 'gcal-target-1' });

    await syncExternalImports();
    expect(mockPatchEvent).toHaveBeenCalledWith('target-cal@group', 'gcal-target-1', expect.objectContaining({ summary: 'New Summary' }));
  });

  it('skips patch when source and target are identical', async () => {
    const key = 'src-cal@group:ev-1:target-cal@group';
    await chrome.storage.local.set({
      importedExternalEvents: {
        [key]: {
          sourceCalendarId: 'src-cal@group',
          sourceEventId: 'ev-1',
          targetCalendarId: 'target-cal@group',
          targetEventId: 'gcal-target-1',
          summary: 'Same',
          lastSynced: Date.now(),
        },
      },
    });

    const event = { id: 'ev-1', summary: 'Same', location: 'Place', description: 'Desc', start: { dateTime: 'T1' }, end: { dateTime: 'T2' } };
    mockGetEvent
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({ ...event, id: 'gcal-target-1' });

    await syncExternalImports();
    expect(mockPatchEvent).not.toHaveBeenCalled();
  });

  it('removes tracking when target event is gone', async () => {
    const key = 'src-cal@group:ev-1:target-cal@group';
    await chrome.storage.local.set({
      importedExternalEvents: {
        [key]: {
          sourceCalendarId: 'src-cal@group',
          sourceEventId: 'ev-1',
          targetCalendarId: 'target-cal@group',
          targetEventId: 'gcal-target-1',
          summary: 'Test',
          lastSynced: Date.now(),
        },
      },
    });

    mockGetEvent
      .mockResolvedValueOnce({ id: 'ev-1', summary: 'Test' })
      .mockResolvedValueOnce(null);

    await syncExternalImports();
    const data = await chrome.storage.local.get('importedExternalEvents');
    const records = data.importedExternalEvents as Record<string, unknown>;
    expect(records[key]).toBeUndefined();
  });
});