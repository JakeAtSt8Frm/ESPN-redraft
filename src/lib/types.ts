/**
 * Core domain types.
 *
 * The app's internal shapes — a league, a roster, a weekly matchup record, a
 * player — were first modelled on Sleeper's API, and every page and model is
 * written against them. ESPN data is adapted into these shapes once, in
 * `src/data/snapshot.ts`, rather than threading ESPN's own shapes through the
 * whole app. Stat lines stay open records because each league scores a
 * different set of keys.
 */

/** A stat line: stat key -> value. Keys match scoring_settings keys (espn-stats.ts). */
export type StatLine = Record<string, number | undefined>;

/** League scoring settings: stat key -> points multiplier. */
export type ScoringSettings = Record<string, number>;

export interface League {
  league_id: string;
  name: string;
  season: string;
  season_type: string;
  /** 'pre_draft' | 'in_season' | 'complete' */
  status: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: ScoringSettings;
  /**
   * Numeric league settings: `playoff_teams`, `playoff_week_start`,
   * `playoff_round_length`, `regular_season_weeks`, `final_week`,
   * `reception_points`.
   */
  settings: Record<string, number>;
}

export interface RosterSettings {
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
  fpts_against?: number;
}

export interface Roster {
  roster_id: number;
  owner_id: string | null;
  league_id: string;
  players: string[] | null;
  /** Starter ids aligned index-for-index with the league's starting slots. */
  starters: string[] | null;
  /** Players in an IR slot. */
  reserve?: string[] | null;
  /** Always empty in a redraft league; kept so the lineup code has one shape. */
  taxi?: string[] | null;
  settings: RosterSettings;
}

export interface Matchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  players: string[] | null;
  starters: string[] | null;
}

export interface Player {
  player_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  /** QB, RB, WR, TE, K or D/ST. */
  position?: string | null;
  team?: string | null;
  /** ESPN's designation (ACTIVE, QUESTIONABLE, OUT, INJURY_RESERVE, ...). */
  injury_status?: string | null;
  active?: boolean;
  /** Share of all ESPN leagues rostering / starting him, 0-100. */
  percent_owned?: number | null;
  percent_started?: number | null;
  percent_change?: number | null;
  /** ESPN's live draft market. */
  adp?: number | null;
  auction_value?: number | null;
  /** ESPN's positional rank under this league's scoring type. */
  positional_rank?: number | null;
  outlook?: string | null;
  bye_week?: number | null;
}

/** Season calendar, as the app reads it. Built from ESPN's league status. */
export interface NflState {
  week: number;
  season: string;
  /** 'pre' | 'regular' | 'post' */
  season_type: string;
  display_week: number;
}

/** Ownership / start percentages for the live week. */
export interface ResearchEntry {
  owned?: number;
  started?: number;
}

/**
 * Position groups used for ranking and comparison. Every value in the app is a
 * percentile *within* one of these, which is what makes a kicker's score and a
 * receiver's score readable on one scale.
 */
export type PositionGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'D/ST';

export const POSITION_GROUPS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'];

/** Maps every position spelling the app may meet onto its group. */
export const POSITION_TO_GROUP: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  PK: 'K',
  'D/ST': 'D/ST',
  DST: 'D/ST',
  DEF: 'D/ST',
};

/** Boom/bust classification for a single player-week. */
export type StatusLabel =
  | 'Major Boom'
  | 'Boom'
  | 'In Range'
  | 'Bust'
  | 'Major Bust'
  | 'Not Played'
  | 'No Proj';

export interface PlayerStatus {
  label: StatusLabel;
  /** CSS custom property name carrying this status's colour. */
  tone: string;
}

/** Fully derived per-player-week view model used across every page. */
export interface EnrichedPlayer {
  pid: string;
  player: Player;
  name: string;
  team: string;
  group: PositionGroup | null;
  /** The roster slot this player occupies (QB, FLEX, BN, IR...). */
  slot: string;
  isStarter: boolean;
  /** Custom-scored projection for the week. */
  proj: number;
  /** Custom-scored actual for the week. */
  act: number;
  hasPlayed: boolean;
  status: PlayerStatus;
  opponent: string | null;
  isOut: boolean;
  /** True when his NFL team has no game this week. */
  onBye: boolean;
  seasonTotal: number;
  /** Headline Value Score (0–1000): in-season form blended with rest-of-season value. */
  valueScore: number | null;
  matchupScore: number | null;
  ppgRank: RankInfo | null;
  totalRank: RankInfo | null;
}

export interface RankInfo {
  group: PositionGroup;
  rank: number;
  outOf: number;
  value: number;
}
