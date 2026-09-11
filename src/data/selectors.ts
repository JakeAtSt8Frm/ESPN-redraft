/**
 * Selectors that turn raw league data into the view models the pages render.
 *
 * Keeping this separate from the components means the same enriched shape backs
 * the roster page, the matchup view, history and the player browser — so a
 * player's Value Score and boom/bust classification can never disagree between
 * two screens.
 */

import { groupForPlayer, hasPlayed } from '../lib/scoring';
import { classifyStatus } from '../lib/status';
import { usesCurrentAvailability } from '../lib/availability';
import { computeOptimalLineup, lineupEfficiency, slotAccepts } from '../lib/optimal';
import type { EnrichedPlayer, PositionGroup, StatLine } from '../lib/types';
import { isOut, playerName, type LeagueData, type TeamInfo } from './league';

/** Bench-type slots, in priority order when a player appears in several lists. */
const BENCH_PRIORITY: Record<string, number> = { IR: 2, BN: 1 };

export interface RosterWeek {
  team: TeamInfo;
  week: number;
  starters: EnrichedPlayer[];
  bench: EnrichedPlayer[];
  injured: EnrichedPlayer[];
  all: EnrichedPlayer[];
  projectedTotal: number;
  actualTotal: number;
  optimalTotal: number;
  efficiency: number;
  optimalLineup: ReturnType<typeof computeOptimalLineup>;
}

/**
 * LeagueData is immutable after loading, so a team/week result can be safely
 * reused across Teams, Optimal, History, heatmaps and Analytics. In particular
 * this avoids rerunning the optimal-lineup matching algorithm on every visit.
 */
const rosterWeekCache = new WeakMap<LeagueData, Map<string, RosterWeek | null>>();

/**
 * Enriches one player for one week with everything the UI needs.
 */
export function enrichPlayer(
  data: LeagueData,
  pid: string,
  week: number,
  slot: string,
  isStarter: boolean,
): EnrichedPlayer {
  const weekData = data.weeks.get(week);
  const statLine: StatLine | undefined = weekData?.stats[pid];
  const projLine: StatLine | undefined = weekData?.projections[pid];
  const opponent = weekData?.opponents[pid] ?? null;

  const player = data.playersById.get(pid);
  const group = groupForPlayer(player);
  const playerTeam = (weekData?.teams[pid] ?? player?.team ?? '').toUpperCase();

  const act = data.score(statLine);
  const played = hasPlayed(statLine);
  const currentStatusApplies = usesCurrentAvailability(data.nflState, data.season, week);
  const unavailable = currentStatusApplies && isOut(player) && !played;
  const proj = unavailable ? 0 : data.score(projLine);

  const matchupIndex = data.pregameMatchupIndexes.get(week) ?? data.matchupIndex;
  const matchup = matchupIndex.get(group, opponent);
  const matchupScore = matchup?.score ?? null;
  // No opponent on a week his team has a game scheduled means a bye.
  const onBye = !played && !opponent && Boolean(playerTeam) && player?.bye_week === week;

  return {
    pid,
    player: player ?? { player_id: pid },
    name: playerName(player, pid),
    team: playerTeam,
    group,
    slot,
    isStarter,
    proj,
    act,
    hasPlayed: played,
    status: classifyStatus(proj, act, played, matchupScore),
    opponent,
    /*
     * ESPN reports a player's injury status as of *now*, not as of the week
     * being viewed. Applying it verbatim to a past week produced nonsense — a
     * player who scored 25 points in week 3 showing up under "Injured / Out"
     * because he happens to be on IR today. If he recorded stats that week, he
     * plainly was not out.
     */
    isOut: unavailable,
    onBye,
    seasonTotal: data.valueIndex.seasonTotals.get(pid) ?? 0,
    // The headline Value Score: in-season form blended with rest of season.
    valueScore: data.combinedScores.get(pid) ?? null,
    matchupScore,
    ppgRank: data.valueIndex.ppgRanks.get(pid) ?? null,
    totalRank: data.valueIndex.totalRanks.get(pid) ?? null,
  };
}

/**
 * Builds the full view of one team's week.
 *
 * Starters come from the week's matchup record rather than the roster, because
 * the roster reflects *today's* lineup while the matchup records who actually
 * started that week — the distinction is the entire point of the history page.
 */
export function buildRosterWeek(
  data: LeagueData,
  rosterId: number,
  week: number,
): RosterWeek | null {
  let dataCache = rosterWeekCache.get(data);
  if (!dataCache) {
    dataCache = new Map();
    rosterWeekCache.set(data, dataCache);
  }

  const cacheKey = `${rosterId}:${week}`;
  if (dataCache.has(cacheKey)) return dataCache.get(cacheKey) ?? null;

  const team = data.teamsById.get(rosterId);
  if (!team) {
    dataCache.set(cacheKey, null);
    return null;
  }

  const weekData = data.weeks.get(week);
  const matchup = weekData?.matchups.find((m) => m.roster_id === rosterId);

  const clean = (ids: (string | null | undefined)[] | null | undefined) =>
    (ids ?? []).map((x) => String(x ?? '')).filter((x) => x && x !== '0');

  /*
   * The week's own lineup wins: it records who actually started that week,
   * whereas the roster reflects today's lineup — the distinction is the whole
   * point of the history page. Weeks not yet started have no lineup of their
   * own, so they show today's, which is the lineup that will play them unless
   * the manager changes it.
   */
  const starterLineup = matchup?.starters ?? team.roster.starters;
  const reserveIds = matchup?.players ? [] : clean(team.roster.reserve);
  const slots = data.starterSlots;
  const starterEntries = (starterLineup ?? []).flatMap((raw, i) => {
    const pid = String(raw ?? '');
    return pid && pid !== '0' ? [{ pid, slot: slots[i] ?? 'ST' }] : [];
  });
  const starterIds = starterEntries.map(({ pid }) => pid);
  const allIds = clean(matchup?.players ?? team.roster.players);

  const starterSet = new Set(starterIds);

  const starters = starterEntries.map(({ pid, slot }) =>
    enrichPlayer(data, pid, week, slot, true),
  );

  // Bench and IR can overlap between the lineup and the roster; de-dupe
  // keeping the most specific designation.
  const benchSlots = new Map<string, string>();
  const addBench = (pid: string, slot: string) => {
    if (!pid || starterSet.has(pid)) return;
    const existing = benchSlots.get(pid);
    if (!existing || (BENCH_PRIORITY[slot] ?? 0) > (BENCH_PRIORITY[existing] ?? 0)) {
      benchSlots.set(pid, slot);
    }
  };

  // A week's own lineup names each player's slot, IR included.
  const weekSlots = matchup?.players ? (weekData?.lineups[String(rosterId)] ?? null) : null;
  for (const pid of allIds) addBench(pid, weekSlots?.[pid] === 'IR' ? 'IR' : 'BN');
  for (const pid of reserveIds) addBench(pid, 'IR');

  const benchAll = [...benchSlots].map(([pid, slot]) =>
    enrichPlayer(data, pid, week, slot, false),
  );
  // The IR slot, not today's injury designation, determines the section. An
  // OUT player can still occupy BN, while a healthy player can sit in IR until
  // the manager activates him.
  const injured = benchAll.filter((p) => p.slot.toUpperCase() === 'IR');
  const bench = benchAll.filter((p) => p.slot.toUpperCase() !== 'IR');

  const projectedTotal = round2(starters.reduce((s, p) => s + p.proj, 0));
  const actualTotal = round2(starters.reduce((s, p) => s + p.act, 0));

  // The optimal lineup considers everyone who was on the roster that week.
  const pool = [...starters, ...benchAll].map((p) => ({
    pid: p.pid,
    group: p.group,
    points: p.act,
  }));
  const optimalLineup = computeOptimalLineup(slots, pool);

  const result: RosterWeek = {
    team,
    week,
    starters,
    bench: bench.sort(sortByImpact),
    injured: injured.sort(sortByImpact),
    all: [...starters, ...benchAll],
    projectedTotal,
    actualTotal,
    optimalTotal: optimalLineup.total,
    efficiency: lineupEfficiency(actualTotal, optimalLineup.total),
    optimalLineup,
  };

  dataCache.set(cacheKey, result);
  return result;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Bench ordering: whoever most deserved a start appears first. */
function sortByImpact(a: EnrichedPlayer, b: EnrichedPlayer): number {
  return b.act - a.act || b.proj - a.proj || (b.valueScore ?? 0) - (a.valueScore ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Heatmap data                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Heatmap columns. `FLEX` is the flex slot pulled out of the RB/WR/TE groups so
 * a team's dedicated starters and whoever it flexes read separately — the flex
 * is the one lineup choice every week in these leagues. It's a slot, not a
 * position group, so it only carries points in the starters view; in the
 * full-roster view it stays empty and the column hides itself.
 */
export type HeatmapColumn = PositionGroup | 'FLEX';
export const HEATMAP_COLUMNS: HeatmapColumn[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];

/** Slots whose points land in the FLEX column. */
const FLEX_SLOTS = new Set(['FLEX', 'WRRB_FLEX', 'REC_FLEX', 'SUPER_FLEX']);

export interface HeatmapRow {
  rosterId: number;
  name: string;
  byGroup: Record<HeatmapColumn, number>;
  total: number;
}

export type HeatmapScope = 'starters' | 'all';
export type HeatmapMetric = 'projected' | 'actual';

function emptyColumns(): Record<HeatmapColumn, number> {
  return Object.fromEntries(HEATMAP_COLUMNS.map((c) => [c, 0])) as Record<
    HeatmapColumn,
    number
  >;
}

/**
 * Builds one heatmap: a team x position grid of custom-scored points.
 *
 * The view that makes positional strength legible at a glance — "whose
 * receivers are carrying them" is a question a flat roster list hides.
 *
 * In the starters view, points are bucketed by the slot each player filled, so
 * the dedicated RB/WR/TE slots and the flex are separated. In the full-roster
 * view there are no slots, so everyone is bucketed by position group and the
 * FLEX column stays empty.
 */
export function buildHeatmap(
  data: LeagueData,
  week: number,
  scope: HeatmapScope,
  metric: HeatmapMetric,
): HeatmapRow[] {
  const weekData = data.weeks.get(week);
  const slots = data.starterSlots;

  const scoreOf = (pid: string) => {
    const line = metric === 'actual' ? weekData?.stats[pid] : weekData?.projections[pid];
    return data.score(line);
  };

  return data.teams.map((team) => {
    const matchup = weekData?.matchups.find((m) => m.roster_id === team.rosterId);

    const byGroup = emptyColumns();

    if (scope === 'starters') {
      const starters = matchup?.starters ?? team.roster.starters ?? [];
      // Preserve index so each starter maps to its slot.
      starters.forEach((raw, i) => {
        const pid = String(raw ?? '');
        if (!pid || pid === '0') return;
        const slot = String(slots[i] ?? '').toUpperCase();
        const points = scoreOf(pid);
        if (FLEX_SLOTS.has(slot)) {
          byGroup.FLEX += points;
        } else {
          const group = groupForPlayer(data.playersById.get(pid));
          if (group) byGroup[group] += points;
        }
      });
    } else {
      const ids = (matchup?.players ?? team.roster.players ?? [])
        .map((x) => String(x ?? ''))
        .filter((x) => x && x !== '0');
      for (const pid of ids) {
        const group = groupForPlayer(data.playersById.get(pid));
        if (!group) continue;
        byGroup[group] += scoreOf(pid);
      }
    }

    let total = 0;
    for (const c of HEATMAP_COLUMNS) {
      byGroup[c] = round2(byGroup[c]);
      total += byGroup[c];
    }

    return { rosterId: team.rosterId, name: team.name, byGroup, total: round2(total) };
  });
}

/**
 * Turns a points heatmap into a rank heatmap: each cell becomes the team's rank
 * in that column for the week (1 = highest points). Ties share a rank. Columns
 * where nobody scored are left at 0 so they hide, exactly as in the points grid,
 * keeping the two heatmaps the same shape and size.
 */
export function buildRankHeatmap(rows: HeatmapRow[]): HeatmapRow[] {
  const rankOf = (value: number, values: number[]) =>
    1 + values.filter((v) => v > value).length;

  const columnActive = HEATMAP_COLUMNS.map(
    (c) => [c, rows.some((r) => r.byGroup[c] !== 0)] as const,
  );
  const totalActive = rows.some((r) => r.total !== 0);

  return rows.map((row) => {
    const byGroup = emptyColumns();
    for (const [c, active] of columnActive) {
      if (!active) continue;
      byGroup[c] = rankOf(
        row.byGroup[c],
        rows.map((r) => r.byGroup[c]),
      );
    }
    const total = totalActive
      ? rankOf(
          row.total,
          rows.map((r) => r.total),
        )
      : 0;
    return { rosterId: row.rosterId, name: row.name, byGroup, total };
  });
}

/* -------------------------------------------------------------------------- */
/* Free agents                                                                 */
/* -------------------------------------------------------------------------- */

export interface RosterOwner {
  rosterId: number;
  name: string;
}

/** Current fantasy-roster owner for every rostered player, IR included. */
export function rosterOwnerByPlayer(teams: readonly TeamInfo[]): Map<string, RosterOwner> {
  const owners = new Map<string, RosterOwner>();

  for (const team of teams) {
    const owner = { rosterId: team.rosterId, name: team.name };
    for (const ids of [team.roster.players, team.roster.reserve]) {
      for (const raw of ids ?? []) {
        const pid = String(raw ?? '');
        if (pid && pid !== '0') owners.set(pid, owner);
      }
    }
  }

  return owners;
}

/** Every player id currently rostered by anybody in the league. */
export function rosteredIds(data: LeagueData): Set<string> {
  return new Set(rosterOwnerByPlayer(data.teams).keys());
}

/** Players on a roster that are eligible for a given slot. */
export function eligibleFor(players: EnrichedPlayer[], slot: string): EnrichedPlayer[] {
  return players.filter((p) => slotAccepts(slot, p.group));
}
