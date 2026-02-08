import { PLAYER_CALENDAR_MAP_ENTRIES } from './secrets';

export interface PlayerCalendarMapping {
  playmetricsPlayerId: number;
  googleCalendarId: string;
  label: string;
  enabled: boolean;
}

export const PLAYER_CALENDAR_MAP: PlayerCalendarMapping[] = PLAYER_CALENDAR_MAP_ENTRIES.map(
  (entry) => ({ ...entry, enabled: true })
);

export const SYNC_INTERVAL_MINUTES = 30;