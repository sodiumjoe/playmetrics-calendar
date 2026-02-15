import { PLAYER_CALENDAR_MAP_ENTRIES, EXTERNAL_CALENDAR_SUBSCRIPTIONS } from './secrets';

export interface PlayerCalendarMapping {
  playmetricsPlayerId: number;
  googleCalendarId: string;
  label: string;
  enabled: boolean;
}

export const PLAYER_CALENDAR_MAP: PlayerCalendarMapping[] = PLAYER_CALENDAR_MAP_ENTRIES.map(
  (entry) => ({ ...entry, enabled: true })
);

export interface ExternalCalendarSubscription {
  sourceCalendarId: string;
  label: string;
  defaultTargetCalendarId: string;
}

export const EXTERNAL_CALENDARS: ExternalCalendarSubscription[] = [...EXTERNAL_CALENDAR_SUBSCRIPTIONS];

export const SYNC_INTERVAL_MINUTES = 30;