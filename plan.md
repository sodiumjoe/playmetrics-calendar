# PlayMetrics Google Calendar Sync — Chrome Extension Plan

## Overview

Chrome extension that syncs PlayMetrics events to Google Calendar. When a user loads PlayMetrics, the extension intercepts API responses to capture auth tokens and event data, then syncs "attending" events to per-player Google Calendars. Attendance changes are synced immediately.

---

## Open Questions

- [x] PlayMetrics API: base URL, endpoint paths, auth mechanism (Bearer token? cookie?), response shapes — **RESOLVED: see Investigation Notes**
- [x] PlayMetrics API: attendance update endpoint path and request/response format — **RESOLVED: `PUT /practices/{id}/availability/{playerId}`**
- [x] PlayMetrics API: how event IDs, player IDs, and attendance statuses are represented — **RESOLVED: practice.id, game.id, player_id; statuses: present/absent/late/injured/empty**
- [x] PlayMetrics API: auth mechanism — **RESOLVED: `Firebase-Token` (JWT) + `pm-access-key` headers. No `Authorization` header used.**
- [x] PlayMetrics API: attendance update method — **RESOLVED: `POST` (not `PUT` as originally assumed)**
- [x] PlayMetrics API: does the calendar endpoint accept date range parameters? — **RESOLVED: yes, via `calendar_filter` JSON with `start_date`/`end_date`**
- [x] PlayMetrics API: what does the event object look like? — **RESOLVED: see Investigation Notes for Practice and Game interfaces**
- [ ] Google OAuth client ID value (to be provided by user, added to manifest.json `oauth2` section)
- [ ] `events.import` limitations: does not support `reminders`, `attendees`, or `colorId` — investigate during Phase 4/5 whether any of these fields are needed for the sync use case, and if so, evaluate switching to `events.insert` + manual dedup

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  PlayMetrics Website (page context)                     │
│                                                         │
│  xhr_interceptor.ts (injected script)                   │
│    - monkey-patches fetch/XHR                           │
│    - captures auth token from request headers           │
│    - captures calendar API responses                    │
│    - captures attendance update requests                │
│    - dispatches CustomEvents to content script          │
└──────────────┬──────────────────────────────────────────┘
               │ CustomEvent
┌──────────────▼──────────────────────────────────────────┐
│  content.ts (content script, playmetrics.com only)      │
│    - injects xhr_interceptor.ts into page               │
│    - listens for CustomEvents                           │
│    - forwards data to background via chrome.runtime     │
└──────────────┬──────────────────────────────────────────┘
               │ chrome.runtime.sendMessage
┌──────────────▼──────────────────────────────────────────┐
│  background.ts (service worker)                         │
│    - receives intercepted data from content script      │
│    - stores auth token in chrome.storage.local          │
│    - on calendar data received: full sync               │
│    - on attendance update: targeted single-event sync   │
│    - periodic alarm: proactive fetch + full sync        │
│    - Google Calendar API calls via fetch + OAuth token  │
│                                                         │
│  config.ts (imported by background.ts)                  │
│    - player ID → Google Calendar ID mappings            │
│    - sync interval, API URL constants                   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow: Full Sync (page load or periodic)

1. User navigates to PlayMetrics → page loads → interceptor captures auth token + calendar API response
2. Content script forwards both to background script
3. Background script stores auth token, then for each configured player:
   a. Filters intercepted events to those where player is "attending"
   b. For each attending event, upserts to the player's Google Calendar
   c. For any previously-synced event no longer on the attending list, deletes from Google Calendar
4. Only future events are synced. Past events are left untouched.

### Data Flow: Targeted Sync (attendance change)

1. User clicks attend/decline on PlayMetrics → interceptor captures the POST
2. Content script forwards event ID + new status to background script
3. Background script:
   - If status = attending → upsert event to Google Calendar
   - If status = not attending → delete event from Google Calendar (if it exists)

### Data Flow: Periodic Sync

1. `chrome.alarms` fires every N minutes (configurable in config.ts)
2. Background script uses stored auth token to fetch PlayMetrics calendar API directly
3. Processes response same as full sync

---

## Google Calendar Sync Strategy

### Event Identity

Use `events.import` to create events with a deterministic `iCalUID`:

```
playmetrics-{playmetricsEventId}-{playmetricsPlayerId}@playmetrics-sync
```

Including the player ID in the UID ensures the same PlayMetrics event synced to two different player calendars gets distinct identities.

### Dedup: iCalUID Lookup

To check if an event already exists before creating/updating:

1. Call `events.list` with `iCalUID` parameter on the target calendar
2. If result is empty → use `events.import` to create
3. If result has an event → use `events.patch` with the returned event's `id` to update
4. `events.import` with a duplicate `iCalUID` returns `409 Conflict`, so we must always check first

### Tagging Synced Events

Use `extendedProperties.private` on each synced event:

```json
{
  "extendedProperties": {
    "private": {
      "playmetricsSyncSource": "playmetrics-calendar-extension",
      "playmetricsEventId": "<event_id>",
      "playmetricsPlayerId": "<player_id>"
    }
  }
}
```

This enables querying all extension-managed events via `privateExtendedProperty=playmetricsSyncSource=playmetrics-calendar-extension` when performing cleanup during full sync.

### Cleanup (Full Sync Only)

1. For each configured player/calendar pair, list all events with `privateExtendedProperty=playmetricsSyncSource=playmetrics-calendar-extension` AND `privateExtendedProperty=playmetricsPlayerId=<player_id>`
2. Filter to future events only using `timeMin` combined with `privateExtendedProperty` in the same `events.list` call (these params are compatible; the restriction only applies to `syncToken`).

3. Compare against the current set of attending event IDs
4. Delete any Google Calendar events whose PlayMetrics event ID is not in the attending set

### Event Field Mapping

| Google Calendar Field | Source |
|---|---|
| `summary` | PlayMetrics event title/name |
| `location` | PlayMetrics event location |
| `description` | PlayMetrics event description + link back to PlayMetrics |
| `start.dateTime` | PlayMetrics event start time (with timezone) |
| `end.dateTime` | PlayMetrics event end time (with timezone) |
| `iCalUID` | Deterministic UID (see above) |
| `extendedProperties.private` | Sync metadata (see above) |

---

## Phase 1: Broad API Interception (discovery mode)

**Goal:** Capture ALL PlayMetrics API traffic so we can identify the right endpoints, auth mechanism, and response shapes. No filtering yet — just log everything.

### 1.1 Minimal manifest changes

- `content_scripts.matches`: change from `<all_urls>` to `["https://*.playmetrics.com/*"]`
- Add `web_accessible_resources` for `xhr_interceptor.js` restricted to PlayMetrics origins
- No Google-related permissions yet

### 1.2 Broad interceptor (`src/xhr_interceptor.ts`)

Monkey-patch both `fetch` and `XMLHttpRequest`. For EVERY request/response:
- Log the method, URL, request headers, request body (if any), response status, and response body
- Dispatch a single `CustomEvent` type (`playmetrics-api-traffic`) with all of the above

No filtering by URL pattern — we want to see everything to identify what endpoints exist.

### 1.3 Content script (`src/content.ts`)

- Inject the interceptor
- Listen for `playmetrics-api-traffic` events
- Forward to background script as `{ type: "API_TRAFFIC", payload: ... }`

### 1.4 Background script (`src/background.ts`)

- Receive `API_TRAFFIC` messages
- Log each one with `console.log` including a `[PM-INTERCEPT]` prefix for easy filtering
- No storage, no processing — just logging

### 1.5 Webpack config

- Add `xhr_interceptor` entry point

### Verification

1. Build extension, load in Chrome
2. Navigate to PlayMetrics, log in, browse around the calendar, click attend/decline
3. Open the service worker console (chrome://extensions → Inspect views: service worker)
4. Filter console for `[PM-INTERCEPT]`
5. Document findings in the Investigation Notes section:
   - Base URL pattern for API calls
   - Auth mechanism (header name, token format)
   - Calendar/events endpoint path and response shape
   - Attendance update endpoint path, method, and request/response shape
   - Player ID format and where it appears
   - Event ID format

### Checklist

- [x] Update `manifest.json` (content_scripts match, web_accessible_resources)
- [x] Update `webpack.config.js` (add xhr_interceptor entry)
- [x] Implement `src/xhr_interceptor.ts` (broad intercept, no filtering)
- [x] Update `src/content.ts` (inject interceptor, forward all traffic)
- [x] Update `src/background.ts` (log all traffic with prefix)
- [x] Build succeeds
- [x] Load extension in Chrome, browse PlayMetrics, verify interception
- [x] Document API findings in Investigation Notes

---

## Phase 2: Targeted Interception & Token Capture

**Goal:** Now that we know the endpoints, narrow the interceptor to capture only what we need. Verify we're extracting the right fields.

### 2.1 Narrow the interceptor

Based on Phase 1 findings, update `xhr_interceptor.ts` to only dispatch events for:
- Requests carrying the auth token (capture it)
- Calendar/events endpoint responses (capture event data)
- Attendance update requests (capture event ID, player ID, status)

Dispatch three distinct `CustomEvent` types:
- `playmetrics-auth-token`
- `playmetrics-calendar-data`
- `playmetrics-attendance-update`

### 2.2 Update content script

Listen for the three specific event types instead of the broad one. Forward with typed messages:
- `{ type: "AUTH_TOKEN", payload: ... }`
- `{ type: "CALENDAR_DATA", payload: ... }`
- `{ type: "ATTENDANCE_UPDATE", payload: ... }`

### 2.3 Background script: structured logging

For each message type, log with structured output:
- `AUTH_TOKEN` → log token type and first/last 4 chars (redacted). Store in `chrome.storage.local`.
- `CALENDAR_DATA` → log event count and a summary of the first event (id, title, start, end, players, attendance). Store raw data in `chrome.storage.local` under key `lastCalendarData`.
- `ATTENDANCE_UPDATE` → log event ID, player ID, old/new status

### 2.4 Create type definitions (`src/types.ts`)

Based on actual API response shapes discovered in Phase 1, define TypeScript interfaces:
- `PlayMetricsEvent` — fields for id, title, start, end, location, description, etc.
- `PlayMetricsAttendanceUpdate` — event id, player id, status
- `BackgroundMessage` — discriminated union of message types

### Verification

1. Rebuild, reload extension
2. Browse PlayMetrics calendar → confirm `CALENDAR_DATA` logged with correct event count and fields
3. Click attend on an event → confirm `ATTENDANCE_UPDATE` logged with correct event ID and status
4. Check `chrome.storage.local` → confirm auth token is stored
5. Check that ONLY relevant API calls are captured (no noise)

### Checklist

- [x] Update `src/xhr_interceptor.ts` (targeted endpoints only)
- [x] Update `src/content.ts` (typed event forwarding)
- [x] Update `src/background.ts` (structured logging, storage)
- [x] Create `src/types.ts` (interfaces from real API shapes)
- [x] Build succeeds
- [x] Rebuild, verify targeted capture on PlayMetrics
- [x] Verify auth token stored correctly
- [x] Verify calendar data shape matches expectations
- [x] Verify attendance update capture works

---

## Phase 3: Config & Google Auth

**Goal:** Set up the player→calendar mapping and Google OAuth. Verify we can authenticate and make a basic Google Calendar API call.

### 3.1 Config file (`src/config.ts`)

Define `PlayerCalendarMapping` interface and `PLAYER_CALENDAR_MAP` array with real values. Also define `SYNC_INTERVAL_MINUTES`.

### 3.2 Manifest updates for Google

- `permissions`: add `"identity"`, `"alarms"`
- `host_permissions`: add `"https://www.googleapis.com/*"`
- Add `oauth2` section with client ID and scope `https://www.googleapis.com/auth/calendar.events`

### 3.3 Google auth in popup

- Add "Sign in with Google" button to `popup.html`
- `popup.ts` calls `chrome.identity.getAuthToken({ interactive: true })` on click
- Display auth status (signed in / not signed in)
- Send auth token to background script for use

### 3.4 Verify Google Calendar API access

Background script makes a single test call: `events.list` on one of the configured calendars (just fetch first page, log the result). This confirms OAuth is working end-to-end.

### Verification

1. Click "Sign in with Google" in popup → complete OAuth flow
2. Check service worker console → confirm successful `events.list` response from Google Calendar API
3. Confirm the configured calendar ID is valid (returns 200, not 404)

### Checklist

- [x] Create `src/config.ts` with real player/calendar mappings
- [x] Update `manifest.json` (identity, alarms, host_permissions, oauth2)
- [x] Update `src/popup.html` and `src/popup.ts` (Google sign-in button, status display)
- [x] Add test Google Calendar API call in background script
- [x] Rebuild, verify OAuth flow works
- [x] Verify test API call returns valid response

---

## Phase 4: Google Calendar API Helpers

**Goal:** Build and individually test each Google Calendar operation we need.

### 4.1 Google Calendar helper module (`src/google-calendar.ts`)

Shared helper wrapping `fetch` calls to the Google Calendar REST API:
- `getAuthToken()` — wraps `chrome.identity.getAuthToken`, handles token refresh on 401
- `listEventsByICalUID(calendarId, iCalUID)` — `events.list` with `iCalUID` param
- `listEventsByExtendedProperty(calendarId, properties)` — `events.list` with `privateExtendedProperty` params
- `importEvent(calendarId, eventBody)` — `events.import` (create with iCalUID)
- `patchEvent(calendarId, eventId, eventBody)` — `events.patch`
- `deleteEvent(calendarId, eventId)` — `events.delete`

Each function logs its request and response with `[GCAL]` prefix.

### 4.2 Manual test harness

Add temporary "Test" buttons in the popup to exercise each helper in isolation:
- "Test Import" → creates a dummy event with a known iCalUID
- "Test List by UID" → looks up the dummy event
- "Test Patch" → updates the dummy event's title
- "Test Delete" → removes the dummy event

### Verification

1. Use popup test buttons to run each operation
2. Check Google Calendar UI to confirm events appear/update/disappear
3. Check service worker console for `[GCAL]` logs showing correct request/response
4. Confirm 409 behavior: click "Test Import" twice with same iCalUID → second call returns 409, logged correctly

### Checklist

- [x] Implement `src/google-calendar.ts` (all helper functions)
- [x] ~~Add test buttons to popup~~ (skipped — tested via real sync instead)
- [x] Test import → event appears in Google Calendar
- [x] Test list by iCalUID → returns the created event
- [x] Test patch → event updates in Google Calendar
- [x] Test delete → event removed from Google Calendar
- [x] Test duplicate import → 409 logged correctly
- [x] ~~Remove test buttons~~ (N/A)

---

## Phase 5: Event Mapping & Single-Event Sync

**Goal:** Map a real PlayMetrics event to a Google Calendar event and sync one event end-to-end.

### 5.1 Event mapping function

`buildGoogleEvent(pmEvent, iCalUID, mapping)` → returns a Google Calendar event body:
- `summary` ← PlayMetrics event title
- `location` ← PlayMetrics event location
- `description` ← PlayMetrics event description + link to event on PlayMetrics
- `start.dateTime` / `end.dateTime` ← PlayMetrics times (with timezone)
- `iCalUID` ← deterministic UID
- `extendedProperties.private` ← sync metadata (`playmetricsSyncSource`, `playmetricsEventId`, `playmetricsPlayerId`)

### 5.2 Upsert function

`upsertEvent(calendarId, pmEvent, playerId)`:
1. Build iCalUID
2. List by iCalUID
3. If not found → import
4. If found → compare fields, patch if changed

### 5.3 Wire up a manual trigger

Add "Sync Last Captured Data" button to popup. On click:
1. Read `lastCalendarData` from `chrome.storage.local`
2. Pick the first attending event for the first configured player
3. Run `upsertEvent` for that single event
4. Log the result

### Verification

1. Browse PlayMetrics so calendar data is captured
2. Click "Sync Last Captured Data" in popup
3. Check Google Calendar → one real event should appear with correct title, time, location
4. Click again → no duplicate created (patch or no-op)
5. Modify something on PlayMetrics side → click again → Google Calendar event updates

### Checklist

- [x] Implement `buildGoogleEvent` mapping function
- [x] Implement `upsertEvent` function
- [x] Add manual sync trigger to popup ("Sync Now" button)
- [x] Test: single event syncs to Google Calendar correctly
- [x] Test: re-sync is idempotent (no duplicates)
- [x] Test: changed event data triggers a patch

---

## Phase 6: Full Sync Logic

**Goal:** Sync all attending events for all configured players. Handle cleanup of events no longer attended.

### 6.1 Full sync function (`src/sync.ts`)

```
function fullSync(calendarData, playerCalendarMap):
  for each mapping in playerCalendarMap where enabled:
    attendingEvents = filterEventsForPlayer(calendarData, mapping.playmetricsPlayerId)
    attendingEventIds = set of event IDs from attendingEvents

    for each event in attendingEvents:
      upsertEvent(mapping.googleCalendarId, event, mapping.playmetricsPlayerId)

    allSyncedEvents = listEventsByExtendedProperty(mapping.googleCalendarId, {
      playmetricsSyncSource: "playmetrics-calendar-extension",
      playmetricsPlayerId: mapping.playmetricsPlayerId
    })

    for each gcalEvent in allSyncedEvents:
      pmEventId = gcalEvent.extendedProperties.private.playmetricsEventId
      if pmEventId not in attendingEventIds AND gcalEvent is in the future:
        deleteEvent(mapping.googleCalendarId, gcalEvent.id)
```

### 6.2 Wire up automatic trigger

In `background.ts`, when `CALENDAR_DATA` message is received, run `fullSync` instead of just logging.

### Verification

1. Have multiple events on PlayMetrics, some attending, some not
2. Browse PlayMetrics → full sync fires automatically
3. Check Google Calendar → only attending events appear, one per configured player
4. Un-attend an event on PlayMetrics → browse PlayMetrics again → event removed from Google Calendar
5. Confirm past events are not deleted

### Checklist

- [x] Implement `filterEventsForPlayer` (depends on actual data shape)
- [x] Implement `fullSync` in `src/sync.ts`
- [x] Wire `CALENDAR_DATA` message to `fullSync` in background script
- [x] Test: multiple attending events sync correctly
- [x] Test: non-attending events are not synced
- [x] Test: previously synced event removed when no longer attending
- [x] Test: past events left untouched

---

## Phase 7: Targeted Attendance Sync

**Goal:** When the user changes attendance on PlayMetrics, immediately sync that single event without waiting for a full sync.

### 7.1 Targeted sync function

```
function targetedSync(eventId, status, playerId):
  mapping = findMappingForPlayer(playerId)
  if not mapping or not mapping.enabled: return

  if status == "attending":
    eventData = fetchPlayMetricsEvent(eventId)  // using stored auth token
    upsertEvent(mapping.googleCalendarId, eventData, playerId)
  else:
    iCalUID = buildICalUID(eventId, playerId)
    existing = listEventsByICalUID(mapping.googleCalendarId, iCalUID)
    if existing is not empty:
      deleteEvent(mapping.googleCalendarId, existing[0].id)
```

### 7.2 Wire up

In `background.ts`, when `ATTENDANCE_UPDATE` message is received, run `targetedSync`.

### 7.3 PlayMetrics event fetch

Implement `fetchPlayMetricsEvent(eventId)` — uses stored auth token to fetch a single event's details from the PlayMetrics API. Endpoint TBD (may be discovered in Phase 1, or we may need to use cached data from the last full sync). If cached data is also unavailable (e.g. user attends an event not seen in any prior full sync), fall back to triggering a full sync.

### Verification

1. Browse PlayMetrics (full sync fires, populates calendar)
2. Click "Attend" on a new event → check Google Calendar within seconds → event appears
3. Click "Decline" on an attending event → check Google Calendar → event removed
4. Check service worker console → `ATTENDANCE_UPDATE` logged, followed by targeted sync log

### Checklist

- [x] Implement `targetedSync` in `src/sync.ts` (uses cached data instead of API fetch)
- [x] ~~Implement `fetchPlayMetricsEvent`~~ (not needed — cached data fallback sufficient)
- [x] Wire `ATTENDANCE_UPDATE` message to `targetedSync` in background script
- [x] Test: attend → event appears in Google Calendar immediately
- [x] Test: decline → event removed from Google Calendar immediately
- [x] Support `GenericCalendarEvent` ("Other") events in all sync paths

---

## Phase 8: Periodic Sync & Popup Polish

**Goal:** Add periodic background sync and a useful popup UI.

### 8.1 Periodic alarm

```
chrome.alarms.create("playmetrics-sync", { periodInMinutes: SYNC_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "playmetrics-sync") {
    // fetch PlayMetrics calendar data using stored auth token
    // run fullSync with the response
  }
});
```

### 8.2 Popup UI

- Google auth status + sign in/out button
- PlayMetrics token status (captured / expired / not captured)
- Last sync timestamp
- Manual "Sync Now" button
- Configured players list (name, enabled/disabled)
- Recent sync log (last 20 entries from `chrome.storage.local`)

### 8.3 Sync logging

All sync operations logged to `chrome.storage.local` key `syncLog`:
- Timestamp, operation (import/patch/delete), event summary, calendar, success/error
- Keep last 100 entries, prune oldest on each sync

### Verification

1. Leave extension running for > SYNC_INTERVAL_MINUTES → confirm periodic sync fires
2. Check popup → shows correct statuses, last sync time, log entries
3. Click "Sync Now" → sync runs, popup updates

### Checklist

- [x] Implement periodic alarm in background script
- [x] Implement proactive PlayMetrics API fetch (using stored token)
- [x] Implement sync logging to `chrome.storage.local`
- [x] Update popup with full status display
- [x] Test: periodic sync fires on schedule
- [x] Test: manual sync works from popup
- [x] Test: log entries appear in popup

---

## Phase 9: Error Handling & Hardening

**Goal:** Handle edge cases gracefully.

### 9.1 Error handling

- PlayMetrics token expired → clear stored token, log warning, skip sync until re-captured
- Google 401 → `chrome.identity.removeCachedAuthToken` + retry once
- Google 429 → exponential backoff (100ms, 200ms, 400ms, ..., max 30s)
- Network errors → log, skip, retry on next cycle
- Unexpected API response shape → log full response, skip that event

### 9.2 Guard rails

- Don't sync if no auth token is stored
- Don't sync if Google auth fails after retry
- Don't delete events if the PlayMetrics fetch returned an error (avoid false negatives wiping the calendar)
- Debounce rapid attendance updates (e.g. user clicks attend/decline multiple times quickly)

### Verification

1. Revoke Google token → confirm extension re-authenticates on next sync
2. Disconnect network → confirm graceful failure, no crash
3. Rapidly toggle attendance → confirm only one sync per event fires

### Checklist

- [x] Add token refresh retry logic (401 → removeCachedAuthToken + retry once)
- [x] Add exponential backoff on 429 (200ms base, max 30s, respects Retry-After header)
- [x] Add network error handling (try/catch with retry in gcalFetch, catch wrappers on all sync calls)
- [x] Add guard against deletion on fetch failure (periodicSync returns early if fetch fails)
- [x] Add attendance update debouncing (1.5s debounce per event+player)
- [x] PlayMetrics token expiry handling (clear tokens on 401/403, skip sync until re-captured)

---

## File Structure (Target)

```
src/
  config.ts              — player/calendar mappings, constants
  xhr_interceptor.ts     — injected into page context, captures API traffic
  content.ts             — content script, bridges page ↔ background
  background.ts          — service worker, sync orchestration
  google-calendar.ts     — Google Calendar API helpers
  sync.ts                — full sync and targeted sync logic
  types.ts               — shared TypeScript interfaces
  popup.ts               — popup UI logic
  popup.html             — popup markup
manifest.json
webpack.config.js
```

---

## References

- [Google Calendar API events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) — iCalUID filter, privateExtendedProperty filter
- [Google Calendar API events.import](https://developers.google.com/workspace/calendar/api/v3/reference/events/import) — create with custom iCalUID (409 on duplicate)
- [Google Calendar API extended properties guide](https://developers.google.com/workspace/calendar/api/guides/extended-properties) — tagging and filtering events
- [Google Calendar API error handling](https://developers.google.com/workspace/calendar/api/guides/errors) — 409, 429, retry strategies

---

# Development Log

## 2026-02-07 — Phase 1 implementation (code complete)

- Updated `manifest.json`: narrowed content_scripts to `https://*.playmetrics.com/*`, added `web_accessible_resources` for `xhr_interceptor.js`
- Added `xhr_interceptor` entry point to `webpack.config.js`
- Implemented `src/xhr_interceptor.ts`: IIFE that monkey-patches `fetch` and `XMLHttpRequest`, dispatches `playmetrics-api-traffic` CustomEvents with method, URL, headers, request body, status, and response body
- Implemented `src/content.ts`: injects interceptor script into page, listens for CustomEvents, forwards to background via `chrome.runtime.sendMessage`
- Implemented `src/background.ts`: listens for `API_TRAFFIC` messages, logs with `[PM-INTERCEPT]` prefix (response body truncated to 500 chars in log)
- Build succeeds, outputs all 4 entry points to `dist/`
- **Next:** Load in Chrome, browse PlayMetrics, document API findings

## 2026-02-07 — Phase 2 implementation (code complete)

- Created `src/types.ts`: TypeScript interfaces for `Field`, `PlayerAvailability`, `GuestTeamPlayer`, `Practice`, `Game`, `Player`, `TeamPlayer`, `Team`, `CalendarEntry`, `CalendarResponse`, `AttendanceUpdateResponse`, and discriminated union `BackgroundMessage` (`AuthTokenMessage | CalendarDataMessage | AttendanceUpdateMessage`)
- Rewrote `src/xhr_interceptor.ts`: targeted interception — only dispatches for `api.playmetrics.com` requests. Extracts auth token from `Authorization` header, calendar data from `GET /user/calendars`, and attendance updates from `PUT /(practices|games)/{id}/availability/{playerId}`. Dispatches three distinct CustomEvents: `playmetrics-auth-token`, `playmetrics-calendar-data`, `playmetrics-attendance-update`
- Rewrote `src/content.ts`: listens for three specific event types, forwards as typed messages (`AUTH_TOKEN`, `CALENDAR_DATA`, `ATTENDANCE_UPDATE`)
- Rewrote `src/background.ts`: structured logging with `[PM]` prefix — redacted token logging, calendar data summary (team/practice/game counts), attendance update logging. Stores `authToken` and `lastCalendarData` in `chrome.storage.local`. Removed old debug storage logic.
- Build succeeds (lint + typecheck + webpack)
- Verified in Chrome: all three message types captured correctly
- Auth discovery: PlayMetrics uses `Firebase-Token` and `pm-access-key` headers (not `Authorization`). Updated interceptor and types accordingly.
- Attendance discovery: endpoint uses `POST` not `PUT`. Updated interceptor to match both methods.
- Attendance status values confirmed: empty string `""` = declined/cleared, `"present"` = attending
- Storage quota: added `unlimitedStorage` permission to manifest (calendar response with 400+ events exceeds default 10MB limit)
- **Next:** Phase 3 (Config & Google Auth)

## 2026-02-07 — Phase 3 implementation (complete)

- Created `src/secrets.ts` (gitignored): Google OAuth client ID, player/calendar mapping entries
- Created `src/config.ts`: imports from secrets, exports `PlayerCalendarMapping` interface, `PLAYER_CALENDAR_MAP`, `SYNC_INTERVAL_MINUTES`
- Updated `manifest.json` (gitignored): added `identity`, `alarms` permissions, `host_permissions` for googleapis, `oauth2` section
- Updated `src/popup.html`: status display for Google and PlayMetrics auth, sign-in/sign-out button
- Updated `src/popup.ts`: promise-based `chrome.identity.getAuthToken`, sign-in/sign-out toggle, sends `TEST_GCAL` message on sign-in
- Updated `src/background.ts`: `testGoogleCalendar()` function calls `events.list` with `maxResults=1` on each configured calendar, exposed on `self` for console testing
- Verified: both calendars return `Test OK` with valid event data
- **Next:** Phase 4 (Google Calendar API Helpers)

## 2026-02-07 — Phases 4-6 implementation (complete)

- Created `src/google-calendar.ts`: `gcalFetch` wrapper with auto 401 retry, `listEventsByICalUID`, `listEventsByExtendedProperty` (paginated), `importEvent` (handles 409), `patchEvent`, `deleteEvent` (handles 410)
- Created `src/sync.ts`: `buildGoogleEvent` maps Practice/Game to GCal event body with deterministic iCalUID (`playmetrics-{type}-{id}-{playerId}@playmetrics-sync`), `upsertEvent` (list→import or patch if changed), `getAttendingEvents` filters future events where player status is `present` or `late`, `fullSync` upserts all attending + deletes stale synced events
- Updated `src/background.ts`: `CALENDAR_DATA` message triggers `fullSync` automatically, added `SYNC_NOW` message handler for manual trigger, removed `testGoogleCalendar`
- Updated popup: added "Sync Now" button
- Verified: events sync to both calendars, re-sync is idempotent, absent events removed on next full sync
- **Next:** Phase 7 (Targeted Attendance Sync)

## 2026-02-08 — Phase 7 + GenericCalendarEvent support (complete)

- Discovered "Other" events are `GenericCalendarEvent` type in a unified `events` array on each `CalendarEntry` (not under `team.practices`/`team.games`)
- Each event has: `type` ("Practice"|"Game"|"GenericCalendarEvent"), `id`, `summary`, `start_datetime`, `end_datetime`, `timezone`, `details` (containing `field`, `location`, `description`, `player_availability`)
- `GenericCalendarEvent` can appear under multiple teams (club-wide events) — deduplication by `type-id` in sync
- Attendance URL for these: `POST /teams/{teamId}/calendar_events/{eventId}/availability/{playerId}`
- Refactored `types.ts`: replaced `Practice`/`Game`/`CalendarEvent` with `UnifiedEvent`, updated `CalendarEntry` to include `events` array
- Refactored `sync.ts`: uses unified `events` array for all event types, deduplicates club-wide events
- Updated `xhr_interceptor.ts`: added `calendar_event` availability URL pattern
- Implemented `targetedSync` in `sync.ts`: immediate upsert/delete on attendance change using cached event data
- Wired `ATTENDANCE_UPDATE` to `targetedSync` in `background.ts`
- Verified: all three event types sync, targeted attend/decline works immediately
- Phase 7 checklist items complete
- **Next:** Phase 8 (Periodic Sync & Popup Polish)

## 2026-02-08 — Phase 8 implementation (code complete)

- Added periodic alarm (`chrome.alarms.create`) at `SYNC_INTERVAL_MINUTES` (30min), fires on install and startup
- Implemented `fetchPlayMetricsCalendar()`: uses stored `firebaseToken`/`accessKey` to fetch calendar data directly, clears tokens on 401/403
- `SYNC_NOW` message now triggers a fresh fetch + full sync (not just cached data)
- Added `lastSyncTime` tracking in `chrome.storage.local`
- Added sync logging (`syncLog` in storage): records import/patch/delete/full-sync operations with timestamp, summary, success status. Keeps last 100 entries.
- Updated popup: shows Google/PlayMetrics/Last Sync statuses, player list, recent activity log (last 20 entries, newest first)
- **Next:** Test, then Phase 9 (Error Handling)

## 2026-02-08 — Phase 9 implementation (complete)

- Rewrote `gcalFetch` in `google-calendar.ts`: retry loop with max 5 attempts, 401 token refresh on first attempt, 429 exponential backoff (200ms base, max 30s, respects `Retry-After` header), network error retry with backoff
- Added try/catch wrappers around all sync calls in `background.ts` to prevent unhandled promise rejections
- Added `debouncedTargetedSync` in `background.ts`: 1.5s debounce per event+player key, only processes the last attendance change
- Deletion guard: `periodicSync` returns early if `fetchPlayMetricsCalendar` returns null (no data = no deletions)
- PlayMetrics token expiry: `fetchPlayMetricsCalendar` clears stored tokens on 401/403
- All phases complete

---

# Investigation Notes

## API Endpoint: Calendar Data

**URL:** `GET https://api.playmetrics.com/user/calendars`

**Query params:**
- `populate` — comma-separated list of relations to include (e.g. `team,team:games,team:practices,team:players`, etc.)
- `calendar_filter` — URL-encoded JSON: `{"start_date":"2026-02-07","end_date":"2026-08-08","limit":20,"offset":0,"only_my_events":true}`

**Auth:** TBD (not visible in response data; need to check request headers in interceptor logs)

### Response Shape

Top-level: JSON array of calendar entries, one per team the user is associated with.

```ts
type CalendarResponse = CalendarEntry[]

interface CalendarEntry {
  name: string                    // e.g. "2012 Boys White - 25/26"
  team: Team
  is_guest: boolean               // whether user's player is a guest on this team
}

interface Team {
  id: number                      // e.g. 345601
  club_id: number                 // e.g. 608
  season_id: number
  sport: string                   // "soccer"
  name: string                    // same as CalendarEntry.name
  gender: string                  // "M" | "F"
  level: string                   // "Competitive"
  practices: Practice[]
  games: Game[]
  team_players: TeamPlayer[]      // roster with player details
  calendar_url: string            // ICS URL
  // many other fields (email, archived, extra, etc.)
}
```

### Practice Object

```ts
interface Practice {
  id: number                      // e.g. 7212890 — unique practice ID
  team_id: number
  field_id: number
  group_id: number                // 0 or shared group ID for recurring practices
  location: string                // usually empty; location comes from field
  start_time: string              // ISO 8601 UTC, e.g. "2025-06-03T02:00:00Z"
  end_time: string                // ISO 8601 UTC
  field: Field
  player_availability: PlayerAvailability[]
  guest_team_players: GuestTeamPlayer[]  // guest players invited to this practice
  team_name: string
  // also: assignment, practice_drills, resources, trigger_notification, extra, created_at, updated_at
}
```

### Game Object

```ts
interface Game {
  team_game_id: number            // e.g. 3485590
  id: number                      // e.g. 2837403 — the game ID
  club_id: number
  team_id: number
  start_datetime: string          // ISO 8601 UTC (note: different field name than practice)
  end_datetime: string            // ISO 8601 UTC
  field_id: number
  field: Field
  is_home: boolean
  my_team_score: number           // -1 = not yet played
  opponent_team_id: number
  opponent_team_name: string      // e.g. "TBD"
  opponent_team_score: number
  arrival_minutes: number         // e.g. 15
  team_name: string
  league_id: number
  player_availability: PlayerAvailability[]
  guest_team_players: GuestTeamPlayer[]
  has_official_score: boolean
  extra: {
    game_type: string             // e.g. "In Club Friendly"
    uniform: string               // e.g. "Wear black training kit..."
    exclude_from_record: boolean
  }
  // also: league, resources, starters, created_by_team_id, archived_at
}
```

### Field Object

```ts
interface Field {
  id: number
  facility_id: number
  facility_name: string           // e.g. "PAA"
  facility_address: string        // e.g. "1500 SE 96th Ave, Portland, OR 97216, USA"
  timezone: string                // e.g. "America/Los_Angeles"
  identifier: string              // e.g. "11v11", "7v7-North"
  display_name: string            // e.g. "PAA 11v11" — best field for calendar location
  surface: string                 // "turf"
  latitude: number
  longitude: number
}
```

### Player Availability

```ts
interface PlayerAvailability {
  player_id: number               // e.g. 827681
  status: string                  // "present" | "absent" | "late" | "injured" | ""
  notes: string                   // e.g. "Family Vacation"
  updated_at: string | null       // ISO 8601 UTC
  health_screen_passed_at: string | null
}
```

Statuses observed: `"present"`, `"absent"`, `"late"`, `"injured"`, `""` (empty = no response yet)

### TeamPlayer (Roster)

```ts
interface TeamPlayer {
  team_id: number
  player_id: number               // matches player_availability.player_id
  number: string                  // jersey number, e.g. "5"
  position_id: number
  player: {
    id: number
    first_name: string            // e.g. "Ash"
    last_name: string             // e.g. "Carpenter"
    birth_year: number
    gender: string
    image_url: string
    default_number: string
    // many other fields
  }
}
```

### Teams Observed in Response

| Team Name | Team ID | Type |
|---|---|---|
| 2012 Boys White - 25/26 | 345601 | Soccer (practices + games) |
| 2015 Girls White - 25/26 | 322023 | Soccer (practices + games) |
| Futsal 2012 Boys | 432540 | Futsal |
| Futsal 2015 Co-Ed | 432551 | Futsal |
| Futsal 2016 Boys Purple | 432554 | Futsal |
| Futsal 4:30 | 418748 | Futsal |
| Futsal 5:45 | 418750 | Futsal |

## API Endpoint: Attendance Update

**URL:** `PUT https://api.playmetrics.com/practices/{practiceId}/availability/{playerId}`

Example: `PUT https://api.playmetrics.com/practices/9977288/availability/1255354`

**Response shape:**
```ts
interface AttendanceUpdateResponse {
  team_id: number
  player_id: number
  context_type: string            // "Practice"
  context_id: number              // same as practice ID in URL
  notes: string
  updated_at: string              // ISO 8601 UTC
  health_screen_passed_at: string | null
  status: string                  // "present", "absent", etc.
  team: Team                      // full team object (without practices/games populated)
}
```

Note: Game attendance updates likely use a different endpoint (e.g. `/games/{gameId}/availability/{playerId}`) but this was not captured in the sample data.

## Key Findings for Implementation

1. **No dedicated event title** — Practices have no `name` or `title` field. Calendar event summary must be constructed from team name + event type + field info. E.g. "2012 Boys White Practice @ PAA 11v11"
2. **Games have richer metadata** — opponent name, game type, uniform info, arrival time. Summary could be "2012 Boys White vs TBD @ PAA 11v11"
3. **Time fields differ** — Practices use `start_time`/`end_time`, games use `start_datetime`/`end_datetime`
4. **Timezone from field** — `field.timezone` (e.g. "America/Los_Angeles") is the authoritative timezone. Times are in UTC and must be converted.
5. **Location** — `field.display_name` for short name, `field.facility_address` for full address. Use address for Google Calendar location field.
6. **Player identification** — `player_availability[].player_id` maps to `team_players[].player_id`. The `team_players` array provides first/last name mapping.
7. **Attendance semantics** — For sync purposes, "present" and "late" likely mean "attending" (should sync). "absent", "injured", and "" likely mean "not attending" (should not sync or should remove).
8. **Multiple teams per user** — The response contains all teams. Config must specify which player IDs to sync for which teams.
9. **Event uniqueness** — Practice ID (`practice.id`) and Game ID (`game.id`) are unique identifiers for building iCalUIDs.
10. **Games have `arrival_minutes`** — Could optionally shift the start time earlier in the calendar event or note it in the description.

---

# Phase 10: Unit Tests

## Plan

**Framework:** Vitest (fast, native TypeScript/ESM support, no babel config needed)

**Scope:** Unit tests for the pure/testable functions in `sync.ts` and `google-calendar.ts`. These modules contain the core business logic. The Chrome extension glue code (content.ts, background.ts, xhr_interceptor.ts, popup.ts) is not worth unit testing — it's mostly wiring.

### Setup

1. Install `vitest` as a devDependency
2. Add `vitest.config.ts` with path aliases matching tsconfig
3. Update `package.json` test script
4. Add `src/__mocks__/chrome.ts` to mock `chrome.storage.local` and `chrome.identity`

### What to test in `sync.ts`

Export the currently-private pure functions for testing:
- `eventTypeKey` — maps PM type strings to EventType
- `buildICalUID` — deterministic UID generation
- `buildSummary` — summary construction for Practice/Game/GenericCalendarEvent
- `buildGoogleEvent` — full GCal event object construction
- `eventsEqual` — equality check between GCal events
- `getAttendingEvents` — filters future + attending events, deduplicates
- `findEventInCache` — looks up event by type+id in CalendarResponse

### What to test in `google-calendar.ts`

Mock `fetch` and `chrome.identity`:
- `gcalFetch` — 401 retry with token refresh, 429 backoff, network error retry, max retries exceeded
- `listEventsByICalUID` — passes correct params, handles empty response
- `importEvent` — handles 409 conflict
- `deleteEvent` — handles 410 gone

### Changes needed

1. Export pure functions from `sync.ts` (currently private)
2. Export `gcalFetch` from `google-calendar.ts` for direct testing (or test via the public functions)
3. ESLint: ignore test files or add vitest globals config

### Checklist

- [x] Install vitest
- [x] Create vitest.config.ts
- [x] Create chrome mock
- [x] Export testable functions from sync.ts
- [x] Write sync.ts tests (33 tests)
- [x] Write google-calendar.ts tests (12 tests)
- [x] All 45 tests pass
- [x] Build still succeeds

---

## 2026-02-08 — Phase 10: Unit tests (complete)

- Installed vitest as devDependency
- Created `vitest.config.ts` with globals and chrome mock setup file
- Created `src/__mocks__/chrome.ts` mocking `chrome.storage.local` and `chrome.identity`
- Exported pure functions from `sync.ts`: `eventTypeKey`, `buildICalUID`, `buildSummary`, `buildGoogleEvent`, `eventsEqual`, `getAttendingEvents`, `findEventInCache`, `upsertEvent`
- Created `src/__tests__/sync.test.ts` (33 tests): eventTypeKey mapping, iCalUID generation, summary building for all event types, Google event construction, event equality, attending event filtering with dedup, cache lookup
- Created `src/__tests__/google-calendar.test.ts` (12 tests): listEventsByICalUID, importEvent (success/409/500), deleteEvent (success/410/500), retry on 401 with token refresh, retry on 429 with backoff, retry on network error
- Updated `package.json` test script to `vitest run`
- Excluded test/mock dirs from tsconfig and eslint
- All 45 tests pass, build succeeds