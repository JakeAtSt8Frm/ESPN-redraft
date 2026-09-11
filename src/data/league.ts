/**
 * League data loading and derivation.
 *
 * Reads one league's snapshot, adapts ESPN's shapes into the app's internal
 * model (see `lib/types.ts`), then derives every metric index once. The heavy
 * work — the value index over ~1,000 players x 17 weeks, the rest-of-season
 * index, the forecast fit over a finished season — runs a single time per load
 * and every page reads the result, which is what keeps the app responsive on a
 * phone.
 */

import { cached, TTL } from './cache';
import { availabilityFactor, unavailableNow } from '../lib/availability';
import { getMarketValues, marketQueryFromLeague, type MarketEntry } from '../lib/market';
import {
  compileScoring,
  createScorer,
  groupForPlayer,
  hasPlayed,
  hasValidProjection,
  type ScoringModel,
} from '../lib/scoring';
import { buildValueIndex, type ValueIndex } from '../lib/value';
import { buildRosIndex, type RosIndex } from '../lib/redraft';
import {
  buildMatchupIndex,
  buildPregameMatchupIndexes,
  type MatchupIndex,
} from '../lib/matchup';
import { fitResidualModel, type FitSeason, type ResidualModel } from '../lib/forecast';
import { starterSlots } from '../lib/optimal';
import { clamp01 } from '../lib/stats';
import { findLeague, type LeagueConfig } from '../lib/leagues';
import type {
  SnapshotLeague,
  SnapshotPick,
  SnapshotPlayers,
  SnapshotPrior,
  SnapshotProGame,
  SnapshotWeek,
} from '../lib/snapshot-types';
import type {
  League,
  Matchup,
  NflState,
  Player,
  PositionGroup,
  ResearchEntry,
  Roster,
  StatLine,
} from '../lib/types';
import {
  getIndex,
  getLeagueFile,
  getPlayersFile,
  getPriorFile,
  getWeekFile,
} from './snapshot';

export interface TeamInfo {
  rosterId: number;
  name: string;
  abbrev: string;
  ownerName: string;
  avatar: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  roster: Roster;
  /** Final placement once the season is over: 1 = champion. */
  placement: number | null;
}

export interface WeekData {
  week: number;
  stats: Record<string, StatLine>;
  projections: Record<string, StatLine>;
  opponents: Record<string, string>;
  teams: Record<string, string>;
  matchups: Matchup[];
  /** Fantasy team id -> player id -> slot, for weeks that have started. */
  lineups: Record<string, Record<string, string>>;
}

/** One NFL game, for the Schedule page. */
export interface ProGame extends SnapshotProGame {
  /** True when the game has been played, judged from the snapshot's own logs. */
  final: boolean;
}

export interface DraftPick extends SnapshotPick {
  teamName: string;
}

export interface LeagueData {
  leagueKey: string;
  season: string;
  league: League;
  /** When the snapshot was pulled from ESPN, epoch milliseconds. */
  generatedAt: number;
  /** Roster id of the champion, once the season is over. */
  championRosterId: number | null;
  nflState: NflState;
  scoringModel: ScoringModel;
  score: (stats: StatLine | undefined | null) => number;
  /** Points per reception: 1 PPR, 0.5 half, 0 standard. */
  receptionPoints: number;
  playersById: Map<string, Player>;
  teams: TeamInfo[];
  teamsById: Map<number, TeamInfo>;
  /** Every week of the fantasy season, played or not. */
  weeks: Map<number, WeekData>;
  /** ESPN's current scoring period — the app's default view. */
  currentWeek: number;
  /** Highest week whose fantasy matchups are all final. */
  latestCompletedWeek: number;
  /** Last week of the fantasy season. */
  maxWeek: number;
  starterSlots: string[];
  /** In-season form: what each player has done. */
  valueIndex: ValueIndex;
  /** Rest of season: what each player is projected to do from here. */
  rosIndex: RosIndex;
  /**
   * The headline Value Score shown across the app: in-season form blended with
   * rest-of-season value, both percentiled within position. See `blendValue`.
   */
  combinedScores: Map<string, number>;
  /** Current defence ratings, built through the latest completed week. */
  matchupIndex: MatchupIndex;
  /** Pregame ratings for each week, containing earlier results only. */
  pregameMatchupIndexes: Map<number, MatchupIndex>;
  /** Fitted projection-error distributions, per position group. */
  residualModel: ResidualModel;
  /** Pairings for weeks not yet in `weeks` — empty, since every week is. */
  futureMatchups: Map<number, Matchup[]>;
  playoff: PlayoffFormat;
  proGames: ProGame[];
  byeWeeks: Map<string, number>;
  draftByPlayer: Map<string, DraftPick>;
  draftType: string;
  /** Last season, when its logs seeded the forecast model. */
  priorSeason: string | null;
  /** Players the redraft market priced; 0 when FantasyCalc was unreachable. */
  marketCount: number;
}

export interface PlayoffFormat {
  /** Teams that reach the playoff field. */
  teams: number;
  /** First playoff week; the regular season is everything before it. */
  weekStart: number;
  /** Weeks a playoff round spans. */
  weeksPerRound: number;
  /** Last regular-season week. */
  regularSeasonWeeks: number;
}

export function playoffFormat(league: League): PlayoffFormat {
  const regularSeasonWeeks = Math.max(1, Number(league.settings?.regular_season_weeks ?? 14));
  return {
    teams: Math.max(2, Number(league.settings?.playoff_teams ?? 4)),
    weekStart: Number(league.settings?.playoff_week_start ?? regularSeasonWeeks + 1),
    weeksPerRound: Math.max(1, Number(league.settings?.playoff_round_length ?? 1)),
    regularSeasonWeeks,
  };
}

export interface LoadProgress {
  phase: string;
  loaded: number;
  total: number;
}

/** Small concurrency limiter, so seventeen week files don't all race at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Starter ids aligned index-for-index with the league's starting slots.
 *
 * ESPN reports a lineup as player -> slot; the lineup code reads it as the
 * Sleeper-style array where `starters[i]` fills `slots[i]`. An unfilled slot is
 * '0', which every reader already skips.
 */
export function alignStarters(lineup: Record<string, string>, slots: string[]): string[] {
  const used = new Set<string>();
  const entries = Object.entries(lineup);
  return slots.map((slot) => {
    const hit = entries.find(([pid, s]) => s === slot && !used.has(pid));
    if (!hit) return '0';
    used.add(hit[0]);
    return hit[0];
  });
}

function adaptPlayers(file: SnapshotPlayers, byeWeeks: Record<string, number>): Map<string, Player> {
  const out = new Map<string, Player>();
  for (const p of file.players) {
    out.set(p.id, {
      player_id: p.id,
      full_name: p.name,
      first_name: p.firstName,
      last_name: p.lastName,
      position: p.position,
      team: p.team,
      injury_status: p.injuryStatus,
      active: p.active,
      percent_owned: p.percentOwned,
      percent_started: p.percentStarted,
      percent_change: p.percentChange,
      adp: p.averageDraftPosition,
      auction_value: p.auctionValue,
      positional_rank: p.positionalRank,
      outlook: p.outlook,
      bye_week: p.team ? (byeWeeks[p.team] ?? null) : null,
    });
  }
  return out;
}

function adaptLeague(file: SnapshotLeague, currentWeek: number): League {
  const l = file.league;
  return {
    league_id: l.leagueId,
    name: l.name,
    season: l.season,
    season_type: 'regular',
    status: l.status,
    total_rosters: l.size,
    roster_positions: l.rosterPositions,
    scoring_settings: l.scoringSettings,
    settings: {
      playoff_teams: l.playoffTeams,
      playoff_week_start: l.playoffWeekStart,
      playoff_round_length: l.playoffRoundLength,
      regular_season_weeks: l.regularSeasonWeeks,
      final_week: l.finalWeek,
      reception_points: l.receptionPoints,
      current_week: currentWeek,
    },
  };
}

/**
 * The headline Value Score: in-season form and rest-of-season value, blended.
 *
 * Both halves are within-position percentiles, so they average on the same
 * footing. The blend is weighted by how much of this season a player has
 * actually played: before his first game the in-season half is nothing but a
 * one-week sample, so the forward-looking half carries the score, and from his
 * fourth game on the two count equally. Current availability discounts only
 * the in-season half — the rest-of-season half is built from ESPN's weekly
 * projections, which already leave out the games an injury will cost.
 */
export function blendValue(
  player: Player | undefined,
  inSeason: { score: number; games: number } | null,
  restOfSeason: number | null,
): number | null {
  const form = inSeason === null ? null : inSeason.score * availabilityFactor(player);
  if (form === null) return restOfSeason;
  if (restOfSeason === null) return Math.round(form);
  const weight = 0.5 * clamp01(inSeason!.games / 4);
  return Math.round(weight * form + (1 - weight) * restOfSeason);
}

/** Loads one league's snapshot and derives everything the pages read. */
export async function loadLeague(
  leagueKey: string,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<LeagueData> {
  const config: LeagueConfig | null = findLeague(leagueKey);
  if (!config) throw new Error(`No league configured for "${leagueKey}"`);

  const report = (phase: string, loaded: number, total: number) =>
    onProgress?.({ phase, loaded, total });

  report('Loading the league snapshot', 0, 1);
  const index = await getIndex(config.key, signal);

  const weekNumbers = index.weeks;
  let done = 0;
  const total = weekNumbers.length + 3;
  const tick = <T>(p: Promise<T>) =>
    p.then((v) => {
      done++;
      report('Loading the league snapshot', done, total);
      return v;
    });

  const [leagueFile, playersFile, prior, weekFiles] = await Promise.all([
    tick(getLeagueFile(config.key, index, signal)),
    tick(getPlayersFile(config.key, index, signal)),
    tick(getPriorFile(config.key, index, signal)),
    mapLimit(weekNumbers, 6, (week) => tick(getWeekFile(config.key, index, week, signal))),
  ]);

  const league = adaptLeague(leagueFile, index.currentWeek);
  const scoringModel = compileScoring(league.scoring_settings);
  const score = createScorer(scoringModel);
  const slots = starterSlots(league.roster_positions);
  const receptionPoints = leagueFile.league.receptionPoints;

  // The redraft market is a third party and optional; start it now, await it last.
  const marketPromise: Promise<Map<string, MarketEntry>> = cached(
    `market:${config.key}:${receptionPoints}:${league.total_rosters}`,
    TTL.MARKET,
    async () => {
      const values = await getMarketValues(
        marketQueryFromLeague(league.roster_positions, league.total_rosters, receptionPoints),
        signal,
      );
      // An empty answer is a failed fetch; throwing keeps it out of the cache.
      if (values.size === 0) throw new Error('Redraft market unavailable');
      return [...values];
    },
  ).then(
    (entries) => new Map(entries),
    () => new Map(),
  );

  const byeWeeks = new Map(Object.entries(leagueFile.byeWeeks));
  const playersById = adaptPlayers(playersFile, leagueFile.byeWeeks);

  // --- Teams --------------------------------------------------------------
  const teams: TeamInfo[] = leagueFile.teams
    .map((t) => ({
      rosterId: t.teamId,
      name: t.name,
      abbrev: t.abbrev,
      ownerName: t.ownerName,
      avatar: t.logo,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      pointsFor: t.pointsFor,
      pointsAgainst: t.pointsAgainst,
      placement: t.finalRank,
      roster: {
        roster_id: t.teamId,
        owner_id: null,
        league_id: league.league_id,
        players: t.players,
        starters: alignStarters(t.lineup, slots),
        reserve: t.players.filter((pid) => t.lineup[pid] === 'IR'),
        taxi: [],
        settings: {
          wins: t.wins,
          losses: t.losses,
          ties: t.ties,
          fpts: t.pointsFor,
          fpts_against: t.pointsAgainst,
        },
      } satisfies Roster,
    }))
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
  const teamsById = new Map(teams.map((t) => [t.rosterId, t]));

  // --- NFL schedule: opponents by team and week ----------------------------
  const opponentOf = new Map<string, string>();
  for (const g of leagueFile.proGames) {
    opponentOf.set(`${g.home}:${g.week}`, g.away);
    opponentOf.set(`${g.away}:${g.week}`, g.home);
  }

  // --- Weeks -----------------------------------------------------------------
  const scheduleByWeek = new Map<number, typeof leagueFile.schedule>();
  for (const m of leagueFile.schedule) {
    const bucket = scheduleByWeek.get(m.week);
    if (bucket) bucket.push(m);
    else scheduleByWeek.set(m.week, [m]);
  }

  const weeks = new Map<number, WeekData>();
  for (const file of weekFiles as SnapshotWeek[]) {
    const teamsThisWeek: Record<string, string> = {};
    const opponents: Record<string, string> = {};
    const place = (pid: string) => {
      if (teamsThisWeek[pid]) return;
      // The team a result was logged for wins; otherwise today's team.
      const team = file.teams[pid] ?? playersById.get(pid)?.team ?? null;
      if (!team) return;
      teamsThisWeek[pid] = team;
      const opponent = opponentOf.get(`${team}:${file.week}`);
      if (opponent) opponents[pid] = opponent;
    };
    for (const pid of Object.keys(file.actuals)) place(pid);
    for (const pid of Object.keys(file.projections)) place(pid);

    const matchups: Matchup[] = [];
    for (const m of scheduleByWeek.get(file.week) ?? []) {
      for (const [rosterId, points] of [
        [m.homeTeamId, m.homeScore],
        [m.awayTeamId, m.awayScore],
      ] as const) {
        if (rosterId === null) continue;
        const lineup = file.lineups[String(rosterId)];
        matchups.push({
          roster_id: rosterId,
          matchup_id: m.awayTeamId === null ? null : m.matchupId,
          points,
          players: lineup ? Object.keys(lineup) : null,
          starters: lineup ? alignStarters(lineup, slots) : null,
        });
      }
    }

    weeks.set(file.week, {
      week: file.week,
      stats: file.actuals,
      projections: file.projections,
      opponents,
      teams: teamsThisWeek,
      matchups,
      lineups: file.lineups,
    });
  }

  const maxWeek = index.finalWeek;
  const currentWeek = Math.max(1, Math.min(maxWeek, index.currentWeek));
  const latestCompletedWeek = index.latestCompletedWeek;
  // The first week not yet final — where "the rest of the season" starts.
  const fromWeek = Math.min(maxWeek, latestCompletedWeek + 1);

  report('Computing metrics', 0, 3);

  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();
  for (const [week, data] of weeks) {
    weekStats.set(week, data.stats);
    weekProjections.set(week, data.projections);
    weekOpponents.set(week, data.opponents);
    weekTeams.set(week, data.teams);
  }

  // The "current projection" signal: each player's next game not yet played.
  const nextProjections: Record<string, StatLine> = {};
  for (let week = fromWeek; week <= maxWeek; week++) {
    const data = weeks.get(week);
    if (!data) continue;
    for (const [pid, line] of Object.entries(data.projections)) {
      if (nextProjections[pid] || hasPlayed(data.stats[pid]) || !hasValidProjection(line)) continue;
      nextProjections[pid] = line;
    }
  }

  const research: Record<string, ResearchEntry> = {};
  for (const [pid, player] of playersById) {
    research[pid] = {
      owned: player.percent_owned ?? undefined,
      started: player.percent_started ?? undefined,
    };
  }

  const valueIndex = buildValueIndex({
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    weekOpponents,
    weekTeams,
    forecastProjections: nextProjections,
    research,
    throughWeek: currentWeek,
  });

  report('Computing metrics', 1, 3);

  const matchupIndex = buildMatchupIndex({
    scoringModel,
    playersById,
    weekStats,
    weekOpponents,
    weekTeams,
    throughWeek: latestCompletedWeek,
  });
  const pregameMatchupIndexes = buildPregameMatchupIndexes(
    { scoringModel, playersById, weekStats, weekOpponents, weekTeams },
    maxWeek,
  );

  // --- Last season, for the forecast fit and as a prior rate ----------------
  const priorSeasons: FitSeason[] = [];
  const priorPpg = new Map<string, { ppg: number; games: number }>();
  if (prior) {
    const fit = adaptPrior(prior);
    priorSeasons.push(fit);
    const totals = new Map<string, { total: number; games: number }>();
    for (const stats of fit.weekStats.values()) {
      for (const [pid, line] of Object.entries(stats)) {
        if (!hasPlayed(line)) continue;
        const t = totals.get(pid) ?? { total: 0, games: 0 };
        t.total += score(line);
        t.games += 1;
        totals.set(pid, t);
      }
    }
    for (const [pid, t] of totals) priorPpg.set(pid, { ppg: t.total / t.games, games: t.games });
  }

  /*
   * Projection-error distributions. Fit on last season's weekly ESPN
   * projections and results, pooled with every week of this one already final —
   * this season's share of the evidence grows every week.
   */
  const residualModel = fitResidualModel({
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    weekTeams,
    throughWeek: latestCompletedWeek,
    priorSeasons,
  });

  report('Computing metrics', 2, 3);

  const market = await marketPromise;
  const rosIndex = buildRosIndex({
    valueIndex,
    playersById,
    scoringModel,
    weekProjections,
    weekStats,
    seasonProjections: playersFile.seasonProjection,
    priorPpg,
    market,
    rosterPositions: league.roster_positions,
    numTeams: league.total_rosters,
    fromWeek,
    finalWeek: maxWeek,
    playoffWeekStart: playoffFormat(league).weekStart,
  });

  const combinedScores = new Map<string, number>();
  for (const pid of new Set([...valueIndex.byPlayer.keys(), ...rosIndex.byPlayer.keys()])) {
    const inSeason = valueIndex.byPlayer.get(pid);
    const value = blendValue(
      playersById.get(pid),
      inSeason ? { score: inSeason.score, games: inSeason.breakdown.games } : null,
      rosIndex.byPlayer.get(pid)?.score ?? null,
    );
    if (value !== null) combinedScores.set(pid, value);
  }

  // A game counts as final once the snapshot holds a log from it and it
  // kicked off more than four hours before the snapshot was taken.
  const logged = new Set<string>();
  for (const [week, data] of weeks) {
    for (const pid of Object.keys(data.stats)) {
      const team = data.teams[pid];
      if (team) logged.add(`${team}:${week}`);
    }
  }
  const proGames: ProGame[] = leagueFile.proGames.map((g) => ({
    ...g,
    final:
      (logged.has(`${g.home}:${g.week}`) || logged.has(`${g.away}:${g.week}`)) &&
      g.kickoff + 4 * 60 * 60 * 1000 < index.generatedAt,
  }));

  const draftByPlayer = new Map<string, DraftPick>(
    leagueFile.draft.map((pick) => [
      pick.playerId,
      { ...pick, teamName: teamsById.get(pick.teamId)?.name ?? `Team ${pick.teamId}` },
    ]),
  );

  const status = leagueFile.league.status;
  const nflState: NflState = {
    week: currentWeek,
    season: league.season,
    season_type: status === 'pre_draft' ? 'pre' : status === 'complete' ? 'post' : 'regular',
    display_week: currentWeek,
  };

  report('Ready', 3, 3);

  return {
    leagueKey: config.key,
    season: league.season,
    league,
    generatedAt: index.generatedAt,
    championRosterId: teams.find((t) => t.placement === 1)?.rosterId ?? null,
    nflState,
    scoringModel,
    score,
    receptionPoints,
    playersById,
    teams,
    teamsById,
    weeks,
    currentWeek,
    latestCompletedWeek,
    maxWeek,
    starterSlots: slots,
    valueIndex,
    rosIndex,
    combinedScores,
    matchupIndex,
    pregameMatchupIndexes,
    residualModel,
    futureMatchups: new Map(),
    playoff: playoffFormat(league),
    proGames,
    byeWeeks,
    draftByPlayer,
    draftType: leagueFile.league.draftType,
    priorSeason: prior?.season ?? null,
    marketCount: market.size,
  };
}

/** Last season's file, in the shape the forecast fit reads. */
function adaptPrior(prior: SnapshotPrior): FitSeason {
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekTeams = new Map<number, Record<string, string>>();
  let throughWeek = 0;
  for (const [week, data] of Object.entries(prior.weeks)) {
    const n = Number(week);
    weekStats.set(n, data.actuals);
    weekProjections.set(n, data.projections);
    weekTeams.set(n, data.teams);
    throughWeek = Math.max(throughWeek, n);
  }
  const positions = prior.positions;
  return {
    label: prior.season,
    weekStats,
    weekProjections,
    weekTeams,
    groupOf: (pid) => (positions[pid] as PositionGroup | undefined) ?? null,
    throughWeek,
  };
}

/* -------------------------------------------------------------------------- */
/* Derivation helpers used by the pages                                        */
/* -------------------------------------------------------------------------- */

/** Display name for a player, falling back through the name fields. */
export function playerName(player: Player | undefined, pid: string): string {
  if (!player) return `Player ${pid}`;
  if (player.full_name) return player.full_name;
  const joined = [player.first_name, player.last_name].filter(Boolean).join(' ').trim();
  return joined || `Player ${pid}`;
}

export function isOut(player: Player | undefined): boolean {
  return unavailableNow(player);
}

export { groupForPlayer };
