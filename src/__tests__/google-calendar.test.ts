import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listEventsByICalUID,
  listEvents,
  getEvent,
  insertEvent,
  importEvent,
  deleteEvent,
} from '../google-calendar';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(chrome.identity.getAuthToken).mockResolvedValue({ token: 'test-token' });
  vi.mocked(chrome.identity.removeCachedAuthToken).mockResolvedValue();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('listEventsByICalUID', () => {
  it('returns items from response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'e1', summary: 'Test' }] }));
    const result = await listEventsByICalUID('cal-id', 'uid@test');
    expect(result).toEqual([{ id: 'e1', summary: 'Test' }]);
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('iCalUID=uid%40test');
  });

  it('returns empty array on error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const result = await listEventsByICalUID('cal-id', 'uid@test');
    expect(result).toEqual([]);
  });

  it('returns empty array when items is missing', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const result = await listEventsByICalUID('cal-id', 'uid@test');
    expect(result).toEqual([]);
  });
});

describe('importEvent', () => {
  it('returns created event on success', async () => {
    const event = { summary: 'New Event', iCalUID: 'uid@test' };
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'created-1', summary: 'New Event' }));
    const result = await importEvent('cal-id', event);
    expect(result).toEqual({ id: 'created-1', summary: 'New Event' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/events/import');
    expect(init.method).toBe('POST');
  });

  it('returns null on 409 conflict', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Conflict', { status: 409 }));
    const result = await importEvent('cal-id', { summary: 'Dup' });
    expect(result).toBeNull();
  });

  it('returns null on other errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }));
    const result = await importEvent('cal-id', { summary: 'Fail' });
    expect(result).toBeNull();
  });
});

describe('deleteEvent', () => {
  it('returns true on success', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await deleteEvent('cal-id', 'event-1');
    expect(result).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/events/event-1');
    expect(init.method).toBe('DELETE');
  });

  it('returns true on 410 gone', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 410 }));
    const result = await deleteEvent('cal-id', 'event-1');
    expect(result).toBe(true);
  });

  it('returns false on other errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }));
    const result = await deleteEvent('cal-id', 'event-1');
    expect(result).toBe(false);
  });
});

describe('listEvents', () => {
  it('returns events with singleEvents and time range', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      items: [{ id: 'e1', summary: 'Event 1' }, { id: 'e2', summary: 'Event 2' }],
    }));
    const result = await listEvents('cal-id', '2026-02-10T00:00:00Z', '2026-02-17T00:00:00Z');
    expect(result).toHaveLength(2);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('singleEvents=true');
    expect(url).toContain('timeMin=');
    expect(url).toContain('timeMax=');
    expect(url).toContain('orderBy=startTime');
  });

  it('paginates through multiple pages', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'e1' }], nextPageToken: 'page2' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'e2' }] }));
    const result = await listEvents('cal-id', '2026-02-10T00:00:00Z', '2026-02-17T00:00:00Z');
    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns partial results on error mid-pagination', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'e1' }], nextPageToken: 'page2' }))
      .mockResolvedValueOnce(new Response('Error', { status: 500 }));
    const result = await listEvents('cal-id', '2026-02-10T00:00:00Z', '2026-02-17T00:00:00Z');
    expect(result).toHaveLength(1);
  });
});

describe('getEvent', () => {
  it('returns event on success', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'e1', summary: 'Test' }));
    const result = await getEvent('cal-id', 'e1');
    expect(result).toEqual({ id: 'e1', summary: 'Test' });
  });

  it('returns null on 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const result = await getEvent('cal-id', 'e1');
    expect(result).toBeNull();
  });

  it('returns null on 410', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Gone', { status: 410 }));
    const result = await getEvent('cal-id', 'e1');
    expect(result).toBeNull();
  });
});

describe('insertEvent', () => {
  it('returns created event on success', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'new-1', summary: 'New' }));
    const result = await insertEvent('cal-id', { summary: 'New' });
    expect(result).toEqual({ id: 'new-1', summary: 'New' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/events');
    expect(url).not.toContain('/events/import');
    expect(init.method).toBe('POST');
  });

  it('returns null on error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }));
    const result = await insertEvent('cal-id', { summary: 'Fail' });
    expect(result).toBeNull();
  });
});

describe('gcalFetch retry behavior', () => {
  it('retries on 401 with token refresh', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'e1' }] }));

    const result = await listEventsByICalUID('cal-id', 'uid@test');
    expect(result).toEqual([{ id: 'e1' }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: 'test-token' });
  });

  it('retries on 429 with backoff', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('Rate Limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    const result = await listEventsByICalUID('cal-id', 'uid@test');
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on network error', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'e2' }] }));

    const result = await listEventsByICalUID('cal-id', 'uid@test');
    expect(result).toEqual([{ id: 'e2' }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});