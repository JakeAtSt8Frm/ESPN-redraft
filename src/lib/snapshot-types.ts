/**
 * The shape of the static snapshot under `public/data/<league>/`.
 *
 * Written by `scripts/snapshot.ts` (Node, the only thing that talks to ESPN and
 * the only thing that sees the cookies) and read by `src/data/snapshot.ts` in
 * the browser. Keeping both sides on these types is what stops a field renamed
 * on one side from quietly reading as `undefined` on the other.
 *
 * Every stat line is already translated from ESPN's numeric ids into the keys
 * in `espn-stats.ts`, and compacted to the keys the league scores plus a few
 * usage keys, so the browser never needs the id table.
 */

import type { PositionGroup, ScoringSettings, StatLine } from './types';

/** Bumped whenever a file's shape changes, so a stale cache is never read. */
export const SNAPSHOT_VERSION = 1;

export interface SnapshotIndex {
  version: number;
  /** One stamp per run; every file written in that run carries it. */
  generatedAt: number;
  leagueKey: string;
  leagueId: string;
  leagueName: string;
  season: string;
  /** The finished season whose weekly logs seed the forecast model. */
  priorSeason: string | null;
  /** ESPN's current scoring period — the week being played or next to play. */
  currentWeek: number;
  /** Highest week whose fantasy matchups are all final. 0 before week 1 ends. */
  latestCompletedWeek: number;
  /** Last scoring period of the fantasy season, playoffs included. */
  finalWeek: number;
  /** Week files written under `weeks/`. */
  weeks: number[];
}

export interface SnapshotLeagueSettings {
  leagueId: string;
  name: string;
  season: string;
  size: number;
  /**
   * Every roster slot in lineup-card order, one entry per slot, bench and IR
   * last: `['QB','RB','RB','WR','WR','TE','FLEX','D/ST','K','BN',...,'IR']`.
   */
  rosterPositions: string[];
  /**
   * The table every stat line is scored against: the league's base scoring
   * with its D/ST-only overrides folded in. See `effectiveScoring` in
   * `espn.ts` for why one table is exact for these leagues, and `npm run
   * verify` for the check that keeps it so.
   */
  scoringSettings: ScoringSettings;
  /** ESPN's base table and slot overrides, kept for display and auditing. */
  scoringBase: ScoringSettings;
  scoringOverrides: Partial<Record<PositionGroup, ScoringSettings>>;
  /** Points per reception, for labelling the format (0, 0.5 or 1). */
  receptionPoints: number;
  regularSeasonWeeks: number;
  playoffTeams: number;
  /** First playoff scoring period. */
  playoffWeekStart: number;
  /** Scoring periods each playoff round spans. */
  playoffRoundLength: number;
  playoffSeedingRule: string;
  finalWeek: number;
  draftType: string;
  drafted: boolean;
  /** 'pre_draft' | 'in_season' | 'complete' */
  status: string;
}

export interface SnapshotTeam {
  teamId: number;
  name: string;
  abbrev: string;
  /** First name and last initial, for every owner on the team. */
  ownerName: string;
  logo: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  playoffSeed: number;
  /** Final placement once the season is over, else null. */
  finalRank: number | null;
  /** Every player on the roster now, starters and bench and IR. */
  players: string[];
  /** Player id -> the slot he is in right now. */
  lineup: Record<string, string>;
}

export interface SnapshotMatchup {
  week: number;
  matchupId: number;
  homeTeamId: number;
  /** Null for a bye in an odd-sized bracket. */
  awayTeamId: number | null;
  homeScore: number;
  awayScore: number;
  /** 'HOME' | 'AWAY' | 'TIE' | 'UNDECIDED' */
  winner: string;
  /** Null in the regular season; ESPN's bracket tier in the playoffs. */
  playoffTier: string | null;
}

/** One NFL game, for the Schedule page and for resolving opponents. */
export interface SnapshotProGame {
  week: number;
  gameId: number;
  home: string;
  away: string;
  /** Kickoff, epoch milliseconds. */
  kickoff: number;
}

export interface SnapshotPick {
  pickNumber: number;
  round: number;
  roundPick: number;
  teamId: number;
  playerId: string;
  /** Auction price; 0 in a snake draft. */
  bidAmount: number;
  keeper: boolean;
}

export interface SnapshotLeague {
  version: number;
  generatedAt: number;
  league: SnapshotLeagueSettings;
  teams: SnapshotTeam[];
  schedule: SnapshotMatchup[];
  proGames: SnapshotProGame[];
  /** NFL team -> bye week. */
  byeWeeks: Record<string, number>;
  draft: SnapshotPick[];
}

export interface SnapshotPlayer {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  position: PositionGroup | null;
  /** NFL team abbreviation; null for a player without one. */
  team: string | null;
  /**
   * ESPN's designation: ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, INJURY_RESERVE,
   * SUSPENSION, ... — null when ESPN sends none.
   */
  injuryStatus: string | null;
  active: boolean;
  /** Share of all ESPN leagues rostering / starting him, 0-100. */
  percentOwned: number | null;
  percentStarted: number | null;
  /** Change in percent owned over the last week. */
  percentChange: number | null;
  averageDraftPosition: number | null;
  auctionValue: number | null;
  /** ESPN's positional rank for this league's scoring type. */
  positionalRank: number | null;
  /** ESPN's written outlook, kept only for players likely to be opened. */
  outlook: string | null;
}

export interface SnapshotPlayers {
  version: number;
  generatedAt: number;
  players: SnapshotPlayer[];
  /** ESPN's full-season projection per player. */
  seasonProjection: Record<string, StatLine>;
}

export interface SnapshotWeek {
  version: number;
  generatedAt: number;
  week: number;
  /** ESPN's projection for the week. */
  projections: Record<string, StatLine>;
  /** What happened. An empty line is a game with no recorded stat. */
  actuals: Record<string, StatLine>;
  /** NFL team a player's actual line was recorded for, where known. */
  teams: Record<string, string>;
  /**
   * Fantasy team id -> player id -> slot, as each team actually set it for
   * this week. Only weeks that have started carry lineups.
   */
  lineups: Record<string, Record<string, string>>;
}

/** One finished season, week by week, with the projections that preceded it. */
export interface SnapshotPrior {
  version: number;
  generatedAt: number;
  season: string;
  /** Player id -> position group in that season. */
  positions: Record<string, PositionGroup>;
  weeks: Record<
    string,
    {
      projections: Record<string, StatLine>;
      actuals: Record<string, StatLine>;
      teams: Record<string, string>;
    }
  >;
}

/** Node-only: ESPN's own applied totals, for `npm run verify`. */
export interface SnapshotApplied {
  generatedAt: number;
  /** week -> pid -> ESPN's applied total for the actual line. */
  actual: Record<string, Record<string, number>>;
  /** week -> pid -> ESPN's applied total for the projection. */
  projected: Record<string, Record<string, number>>;
  /** week -> teamId -> ESPN's reported team score. */
  teamScores: Record<string, Record<string, number>>;
}
