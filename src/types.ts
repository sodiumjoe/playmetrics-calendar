export interface Field {
  id: number;
  facility_id: number;
  facility_name: string;
  facility_address: string;
  timezone: string;
  identifier: string;
  display_name: string;
  surface: string;
  latitude: number;
  longitude: number;
}

export interface PlayerAvailability {
  player_id: number;
  status: string;
  notes: string;
  updated_at: string | null;
  health_screen_passed_at: string | null;
}

export interface UnifiedEvent {
  type: 'Practice' | 'Game' | 'GenericCalendarEvent';
  id: number;
  team_id: number;
  team_name: string;
  team_itinerary_id: number;
  team_ids?: number[];
  summary: string;
  start_datetime: string;
  end_datetime: string;
  timezone: string;
  guest_team_players: unknown[];
  details: {
    field?: Field;
    location?: string;
    description?: string;
    player_availability: PlayerAvailability[];
    opponent_team_name?: string;
    game_type?: string;
    uniform?: string;
    arrival_minutes?: number;
  };
  created_at: string;
  updated_at: string;
}

export interface Player {
  id: number;
  first_name: string;
  last_name: string;
  birth_year: number;
  gender: string;
  image_url: string;
  default_number: string;
}

export interface TeamPlayer {
  team_id: number;
  player_id: number;
  number: string;
  position_id: number;
  player: Player;
}

export interface Team {
  id: number;
  club_id: number;
  season_id: number;
  sport: string;
  name: string;
  gender: string;
  level: string;
  team_players: TeamPlayer[];
  calendar_url: string;
}

export interface CalendarEntry {
  name: string;
  team: Team;
  events: UnifiedEvent[];
  color: string;
  is_guest: boolean;
}

export type CalendarResponse = CalendarEntry[];

export interface AttendanceUpdateResponse {
  team_id: number;
  player_id: number;
  context_type: string;
  context_id: number;
  notes: string;
  updated_at: string;
  health_screen_passed_at: string | null;
  status: string;
}

export type EventType = 'practice' | 'game' | 'calendar_event';

export interface AuthTokenMessage {
  type: 'AUTH_TOKEN';
  payload: { firebaseToken: string; accessKey: string };
}

export interface CalendarDataMessage {
  type: 'CALENDAR_DATA';
  payload: { data: CalendarResponse };
}

export interface AttendanceUpdateMessage {
  type: 'ATTENDANCE_UPDATE';
  payload: {
    eventType: EventType;
    eventId: number;
    playerId: number;
    status: string;
    response: AttendanceUpdateResponse;
  };
}

export type BackgroundMessage =
  | AuthTokenMessage
  | CalendarDataMessage
  | AttendanceUpdateMessage;