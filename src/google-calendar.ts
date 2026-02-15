const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30000;

async function getAuthToken(): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive: false });
  if (!result.token) throw new Error('No Google auth token available');
  return result.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gcalFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let lastToken: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getAuthToken();
    lastToken = token;

    let resp: Response;
    try {
      resp = await fetch(`${GCAL_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (err) {
      console.error(`[GCAL] Network error on attempt ${attempt + 1}:`, err);
      if (attempt === MAX_RETRIES) throw err;
      await sleep(Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
      continue;
    }

    if (resp.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token });
      continue;
    }

    if (resp.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = resp.headers.get('Retry-After');
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      console.log(`[GCAL] Rate limited (429), retrying in ${delayMs}ms`);
      await sleep(delayMs);
      continue;
    }

    return resp;
  }

  await chrome.identity.removeCachedAuthToken({ token: lastToken! });
  throw new Error('Max retries exceeded for Google Calendar API');
}

export interface GCalEvent {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  iCalUID?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

interface GCalEventList {
  items?: GCalEvent[];
  nextPageToken?: string;
}

function calPath(calendarId: string): string {
  return `/calendars/${encodeURIComponent(calendarId)}`;
}

export async function listEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<GCalEvent[]> {
  const params = new URLSearchParams({
    singleEvents: 'true',
    timeMin,
    timeMax,
    maxResults: '250',
    orderBy: 'startTime',
  });

  const allItems: GCalEvent[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await gcalFetch(`${calPath(calendarId)}/events?${params}`);
    if (!resp.ok) {
      console.error(`[GCAL] listEvents failed: ${resp.status}`, await resp.text());
      return allItems;
    }
    const data: GCalEventList = await resp.json();
    allItems.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allItems;
}

export async function getEvent(
  calendarId: string,
  eventId: string,
): Promise<GCalEvent | null> {
  const resp = await gcalFetch(`${calPath(calendarId)}/events/${encodeURIComponent(eventId)}`);
  if (resp.status === 404 || resp.status === 410) return null;
  if (!resp.ok) {
    console.error(`[GCAL] getEvent failed: ${resp.status}`, await resp.text());
    return null;
  }
  return await resp.json();
}

export async function insertEvent(
  calendarId: string,
  eventBody: GCalEvent,
): Promise<GCalEvent | null> {
  const resp = await gcalFetch(`${calPath(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(eventBody),
  });
  if (!resp.ok) {
    console.error(`[GCAL] Insert failed: ${resp.status}`, await resp.text());
    return null;
  }
  const created: GCalEvent = await resp.json();
  console.log(`[GCAL] Inserted: ${created.summary} (${created.id})`);
  return created;
}

export async function listEventsByICalUID(
  calendarId: string,
  iCalUID: string,
): Promise<GCalEvent[]> {
  const params = new URLSearchParams({ iCalUID });
  const resp = await gcalFetch(`${calPath(calendarId)}/events?${params}`);
  if (!resp.ok) {
    console.error(`[GCAL] listByUID failed: ${resp.status}`, await resp.text());
    return [];
  }
  const data: GCalEventList = await resp.json();
  return data.items ?? [];
}

export async function listEventsByExtendedProperty(
  calendarId: string,
  properties: Record<string, string>,
  timeMin?: string,
): Promise<GCalEvent[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(properties)) {
    params.append('privateExtendedProperty', `${key}=${value}`);
  }
  if (timeMin) params.set('timeMin', timeMin);
  params.set('singleEvents', 'true');
  params.set('maxResults', '2500');

  const allItems: GCalEvent[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await gcalFetch(`${calPath(calendarId)}/events?${params}`);
    if (!resp.ok) {
      console.error(`[GCAL] listByProp failed: ${resp.status}`, await resp.text());
      return allItems;
    }
    const data: GCalEventList = await resp.json();
    allItems.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allItems;
}

export async function importEvent(
  calendarId: string,
  eventBody: GCalEvent,
): Promise<GCalEvent | null> {
  const resp = await gcalFetch(`${calPath(calendarId)}/events/import`, {
    method: 'POST',
    body: JSON.stringify(eventBody),
  });
  if (resp.status === 409) {
    console.log(`[GCAL] Import conflict (already exists): ${eventBody.iCalUID}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`[GCAL] Import failed: ${resp.status}`, await resp.text());
    return null;
  }
  const created: GCalEvent = await resp.json();
  console.log(`[GCAL] Imported: ${created.summary} (${created.id})`);
  return created;
}

export async function patchEvent(
  calendarId: string,
  eventId: string,
  eventBody: Partial<GCalEvent>,
): Promise<GCalEvent | null> {
  const resp = await gcalFetch(
    `${calPath(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(eventBody),
    },
  );
  if (!resp.ok) {
    console.error(`[GCAL] Patch failed: ${resp.status}`, await resp.text());
    return null;
  }
  const updated: GCalEvent = await resp.json();
  console.log(`[GCAL] Patched: ${updated.summary} (${updated.id})`);
  return updated;
}

export async function deleteEvent(
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  const resp = await gcalFetch(
    `${calPath(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
  );
  if (resp.status === 410) {
    console.log(`[GCAL] Already deleted: ${eventId}`);
    return true;
  }
  if (!resp.ok) {
    console.error(`[GCAL] Delete failed: ${resp.status}`, await resp.text());
    return false;
  }
  console.log(`[GCAL] Deleted: ${eventId}`);
  return true;
}