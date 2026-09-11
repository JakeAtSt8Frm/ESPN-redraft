/**
 * ESPN Fantasy API client and normalisers.
 *
 * Two things about this API shape the whole app.
 *
 * **It is private and cookie-only.** These leagues are not public, and ESPN
 * accepts no other credential. ESPN does reflect `Origin` for CORS, but a
 * browser on `*.github.io` cannot attach espn.com cookies to a cross-site
 * request under any modern cookie policy, and `fetch` refuses to set `Cookie`
 * by hand. So the credentials live in `scripts/snapshot.ts`, which runs in Node
 * and writes plain JSON into `public/data`. The shipped bundle contains no
 * cookie and makes no ESPN request.
 *
 * **Nothing in it is self-describing.** Stats arrive as numeric ids, lineup
 * slots as numeric ids, positions and pro teams as numeric ids, with no
 * dictionary. `espn-stats.ts` and the tables below carry those; this file turns
 * the payloads into the snapshot's shapes.
 */

import { normalizeStatLine, STAT_IDS } from './espn-stats';
import type {
  SnapshotMatchup,
  SnapshotPlayer,
  SnapshotTeam,
} from './snapshot-types';
import type { PositionGroup, ScoringSettings, StatLine } from './types';

export const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';

export interface EspnCredentials {
  swid: string;
  espnS2: string;
}

export interface EspnRequest {
  season: number;
  leagueId: string;
  views: string[];
  scoringPeriodId?: number;
}

export function leagueUrl(req: EspnRequest): string {
  const params = new URLSearchParams();
  for (const view of req.views) params.append('view', view);
  if (req.scoringPeriodId !== undefined) {
    params.set('scoringPeriodId', String(req.scoringPeriodId));
  }
  return (
    `${ESPN_HOST}/apis/v3/games/ffl/seasons/${req.season}` +
    `/segments/0/leagues/${req.leagueId}?${params.toString()}`
  );
}

/**
 * One authenticated GET, with retry.
 *
 * ESPN rate-limits hard on Sunday afternoons, which is exactly when a refresh
 * runs. 429 and 5xx retry with exponential backoff and jitter; a 401 does not,
 * because a stale `espn_s2` will never succeed and retrying it only delays a
 * clear error message.
 */
export async function espnFetch<T>(
  url: string,
  creds: EspnCredentials,
  options: { filter?: unknown; retries?: number } = {},
): Promise<T> {
  const { filter, retries = 3 } = options;

  const headers: Record<string, string> = {
    Cookie: `SWID=${creds.swid}; espn_s2=${creds.espnS2}`,
    Accept: 'application/json',
    // ESPN serves a different, smaller payload to clients it doesn't recognise.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
  if (filter !== undefined) headers['X-Fantasy-Filter'] = JSON.stringify(filter);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let final = false;
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 || res.status === 403) {
        final = true;
        throw new Error(
          `ESPN rejected the credentials (${res.status}). The espn_s2 cookie ` +
            'expires every few months; refresh it from a logged-in browser.',
        );
      }
      // A 404 is a real answer — a week that doesn't exist, a season the
      // league didn't play. Retrying cannot change it.
      if (res.status < 500 && res.status !== 429) {
        final = true;
        throw new Error(`ESPN ${res.status}: ${url}`);
      }
      lastError = new Error(`ESPN ${res.status}`);
    } catch (err) {
      if (final) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < retries) {
      const backoff = 400 * 2 ** attempt + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError ?? new Error(`ESPN request failed: ${url}`);
}

// ---------------------------------------------------------------------------
// Id tables
// ---------------------------------------------------------------------------

/** ESPN `defaultPositionId` -> position group. */
export const ESPN_POSITION_IDS: Record<number, PositionGroup> = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'D/ST',
};

/**
 * ESPN lineup slot id -> the app's slot name.
 *
 * The flex slots are renamed into the vocabulary `optimal.ts` already speaks
 * (`FLEX`, `WRRB_FLEX`, `REC_FLEX`, `SUPER_FLEX`), so the lineup solver needs no
 * ESPN-specific branch. Only 0-6, 16, 17, 20, 21 and 23 are used by the leagues
 * here; the rest exist because ESPN numbers slots globally across formats.
 */
export const LINEUP_SLOTS: Record<number, string> = {
  0: 'QB',
  2: 'RB',
  3: 'WRRB_FLEX',
  4: 'WR',
  5: 'REC_FLEX',
  6: 'TE',
  7: 'SUPER_FLEX',
  16: 'D/ST',
  17: 'K',
  20: 'BN',
  21: 'IR',
  23: 'FLEX',
};

/** Lineup-card order for starting slots. Bench and IR are appended after. */
const STARTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'WRRB_FLEX', 'REC_FLEX', 'FLEX', 'SUPER_FLEX', 'D/ST', 'K'];

/** NFL team id -> abbreviation. ESPN's own numbering, stable across seasons. */
export const PRO_TEAMS: Record<number, string> = {
  1: 'ATL',
  2: 'BUF',
  3: 'CHI',
  4: 'CIN',
  5: 'CLE',
  6: 'DAL',
  7: 'DEN',
  8: 'DET',
  9: 'GB',
  10: 'TEN',
  11: 'IND',
  12: 'KC',
  13: 'LV',
  14: 'LAR',
  15: 'MIA',
  16: 'MIN',
  17: 'NE',
  18: 'NO',
  19: 'NYG',
  20: 'NYJ',
  21: 'PHI',
  22: 'ARI',
  23: 'PIT',
  24: 'LAC',
  25: 'SF',
  26: 'SEA',
  27: 'TB',
  28: 'WSH',
  29: 'CAR',
  30: 'JAX',
  33: 'BAL',
  34: 'HOU',
};

/** Expands ESPN's slot counts into one entry per slot, in lineup-card order. */
export function rosterPositions(lineupSlotCounts: Record<string, number>): string[] {
  const counts = new Map<string, number>();
  for (const [slotId, n] of Object.entries(lineupSlotCounts ?? {})) {
    const label = LINEUP_SLOTS[Number(slotId)];
    if (label && n > 0) counts.set(label, (counts.get(label) ?? 0) + n);
  }

  const out: string[] = [];
  for (const label of [...STARTER_ORDER, 'BN', 'IR']) {
    for (let i = 0; i < (counts.get(label) ?? 0); i++) out.push(label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface RawScoringItem {
  statId: number;
  points: number;
  pointsOverrides?: Record<string, number>;
  isReverseItem?: boolean;
}

/**
 * Splits ESPN's scoring items into a base table plus per-group overrides.
 *
 * `pointsOverrides` is keyed by lineup slot id, and every override these
 * leagues declare is on slot 16 — the D/ST slot. That is how ESPN says "these
 * ids mean something else for a defence": the points-allowed ladder, sacks and
 * takeaways score only in the D/ST slot.
 */
export function parseScoringSettings(items: RawScoringItem[]): {
  base: ScoringSettings;
  overrides: Partial<Record<PositionGroup, ScoringSettings>>;
} {
  const base: ScoringSettings = {};
  const overrides: Partial<Record<PositionGroup, ScoringSettings>> = {};

  for (const item of items ?? []) {
    const key = STAT_IDS[item.statId] ?? String(item.statId);
    // A "reverse" item scores the inverse of the stat. None are declared here,
    // but silently dropping the flag would score such a league backwards.
    const sign = item.isReverseItem ? -1 : 1;
    base[key] = (item.points ?? 0) * sign;

    for (const [slotId, points] of Object.entries(item.pointsOverrides ?? {})) {
      const slot = LINEUP_SLOTS[Number(slotId)];
      const group = slot ? SLOT_GROUP[slot] : undefined;
      if (!group || typeof points !== 'number') continue;
      (overrides[group] ??= {})[key] = points * sign;
    }
  }

  return { base, overrides };
}

const SLOT_GROUP: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  'D/ST': 'D/ST',
};

/**
 * Suffix on an individual player's copy of a stat the D/ST slot scores
 * differently — see `effectiveScoring`.
 */
export const INDIVIDUAL_SUFFIX = '~ind';

/**
 * Folds the per-group overrides into one table every stat line is scored with.
 *
 * The app scores a stat line without knowing whose it is — a line object is
 * all most callers hold — so one table has to be exact for every player. The
 * D/ST override gets there by splitting each key it re-scores in two:
 *
 *   `def_int`      the override value, which a D/ST line carries
 *   `def_int~ind`  the base value, which an individual's copy is moved onto
 *
 * The split is not hypothetical. It was first built on the assumption that
 * `def_*` ids only ever appear on a defence's own line, and ESPN's totals
 * refuted it on the first run: Travis Hunter plays both ways, and his
 * projection carries interceptions, fumble recoveries and sacks under the very
 * ids a D/ST uses. Folded naively, the D/ST table paid him for them and his
 * projection read 0.15 points above ESPN's in both leagues. Individual
 * defensive stats score at the base rate — zero in these leagues — and now
 * they do here too. `separateIndividualKeys` is the other half: the snapshot
 * applies it to every line that isn't a D/ST's.
 *
 * An override for any group other than D/ST would need the same treatment and
 * stops the snapshot rather than being folded in wrongly. `npm run verify`
 * checks the result against ESPN's own totals for every player-week.
 */
export function effectiveScoring(
  base: ScoringSettings,
  overrides: Partial<Record<PositionGroup, ScoringSettings>>,
): { table: ScoringSettings; splitKeys: string[] } {
  const table: ScoringSettings = { ...base };
  const splitKeys: string[] = [];

  for (const [group, entries] of Object.entries(overrides)) {
    for (const [key, points] of Object.entries(entries ?? {})) {
      if ((base[key] ?? 0) === points) continue;
      if (group !== 'D/ST') {
        throw new Error(
          `Scoring override ${group}:${key}=${points} (base ${base[key] ?? 0}) is on a ` +
            'group this app does not split; it needs the same treatment as D/ST.',
        );
      }
      table[key] = points;
      table[`${key}${INDIVIDUAL_SUFFIX}`] = base[key] ?? 0;
      splitKeys.push(key);
    }
  }

  return { table, splitKeys };
}

/** Moves an individual player's copies of D/ST-scored stats onto their own keys. */
export function separateIndividualKeys(line: StatLine, splitKeys: ReadonlySet<string>): StatLine {
  let out: StatLine | null = null;
  for (const key of Object.keys(line)) {
    if (!splitKeys.has(key)) continue;
    out ??= { ...line };
    out[`${key}${INDIVIDUAL_SUFFIX}`] = line[key];
    delete out[key];
  }
  return out ?? line;
}

// ---------------------------------------------------------------------------
// Teams, schedule, players
// ---------------------------------------------------------------------------

export interface RawMember {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

export interface RawTeam {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  abbrev?: string;
  logo?: string;
  owners?: string[];
  playoffSeed?: number;
  rankCalculatedFinal?: number;
  record?: {
    overall?: { wins?: number; losses?: number; ties?: number; pointsFor?: number; pointsAgainst?: number };
  };
  roster?: { entries?: Array<{ playerId: number; lineupSlotId: number }> };
}

/**
 * "First L." for a member.
 *
 * The site is public, and a first name and an initial are all the app needs to
 * tell owners apart — nothing on any page is keyed by the full name.
 */
function shortName(member: RawMember | undefined): string | null {
  if (!member) return null;
  const first = (member.firstName ?? '').trim();
  const last = (member.lastName ?? '').trim();
  if (first) return last ? `${first} ${last[0]}.` : first;
  return member.displayName?.trim() || null;
}

export function parseTeams(raw: RawTeam[], members: RawMember[], seasonOver: boolean): SnapshotTeam[] {
  const byId = new Map(members.map((m) => [m.id, m]));

  return (raw ?? []).map((t) => {
    const overall = t.record?.overall ?? {};
    const players: string[] = [];
    const lineup: Record<string, string> = {};

    for (const entry of t.roster?.entries ?? []) {
      const pid = String(entry.playerId);
      players.push(pid);
      lineup[pid] = LINEUP_SLOTS[entry.lineupSlotId] ?? String(entry.lineupSlotId);
    }

    const owners = (t.owners ?? [])
      .map((id) => shortName(byId.get(id)))
      .filter((name): name is string => Boolean(name));

    return {
      teamId: t.id,
      // ESPN moved team names from location+nickname to a single `name` and
      // still returns both; joining the old pair is the fallback.
      name:
        t.name?.trim() ||
        [t.location, t.nickname].filter(Boolean).join(' ').trim() ||
        `Team ${t.id}`,
      abbrev: t.abbrev ?? String(t.id),
      ownerName: owners.join(', ') || 'Unknown',
      logo: t.logo ?? null,
      wins: overall.wins ?? 0,
      losses: overall.losses ?? 0,
      ties: overall.ties ?? 0,
      pointsFor: Math.round((overall.pointsFor ?? 0) * 100) / 100,
      pointsAgainst: Math.round((overall.pointsAgainst ?? 0) * 100) / 100,
      playoffSeed: t.playoffSeed ?? 0,
      finalRank: seasonOver && t.rankCalculatedFinal ? t.rankCalculatedFinal : null,
      players,
      lineup,
    };
  });
}

export interface RawMatchup {
  id: number;
  matchupPeriodId: number;
  playoffTierType?: string;
  winner?: string;
  home?: { teamId: number; totalPoints?: number };
  away?: { teamId: number; totalPoints?: number };
}

export function parseSchedule(raw: RawMatchup[]): SnapshotMatchup[] {
  return (raw ?? [])
    .filter((m) => m.home)
    .map((m) => ({
      week: m.matchupPeriodId,
      matchupId: m.id,
      homeTeamId: m.home!.teamId,
      awayTeamId: m.away?.teamId ?? null,
      homeScore: Math.round((m.home?.totalPoints ?? 0) * 100) / 100,
      awayScore: Math.round((m.away?.totalPoints ?? 0) * 100) / 100,
      winner: m.winner ?? 'UNDECIDED',
      playoffTier:
        m.playoffTierType && m.playoffTierType !== 'NONE' ? m.playoffTierType : null,
    }));
}

export interface RawStatBlock {
  id: string;
  seasonId: number;
  scoringPeriodId: number;
  statSourceId: number;
  statSplitTypeId: number;
  appliedTotal?: number;
  stats?: Record<string, number>;
  externalId?: string;
  proTeamId?: number;
}

export interface RawPlayer {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId?: number;
  proTeamId?: number;
  injuryStatus?: string;
  active?: boolean;
  seasonOutlook?: string;
  ownership?: {
    percentOwned?: number;
    percentStarted?: number;
    percentChange?: number;
    averageDraftPosition?: number;
    auctionValueAverage?: number;
  };
  rankings?: Record<string, Array<{ rank: number; rankType: string; slotId: number }>>;
  draftRanksByRankType?: Record<string, { rank?: number }>;
  stats?: RawStatBlock[];
}

/**
 * The ranking type that matches a league's reception scoring.
 *
 * ESPN publishes positional ranks per format; showing a standard-scoring rank
 * beside a PPR league's numbers would disagree with every other figure here.
 */
export function rankTypeFor(receptionPoints: number): string {
  if (receptionPoints >= 1) return 'PPR';
  if (receptionPoints > 0) return 'HALF';
  return 'STANDARD';
}

/** Turns one raw player into the snapshot's player, minus stats. */
export function parsePlayer(raw: RawPlayer, rankType: string, keepOutlook: boolean): SnapshotPlayer {
  const position = ESPN_POSITION_IDS[raw.defaultPositionId ?? -1] ?? null;
  const proTeamId = raw.proTeamId ?? 0;

  // ESPN keys `rankings` by scoring period (0 is the preseason list); the
  // latest period's list for this format is ESPN's current view.
  let positionalRank: number | null = null;
  const periods = Object.keys(raw.rankings ?? {}).map(Number).sort((a, b) => b - a);
  for (const period of periods) {
    const hit = raw.rankings?.[String(period)]?.find((r) => r.rankType === rankType);
    if (hit) {
      positionalRank = hit.rank;
      break;
    }
  }

  const num = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

  return {
    id: String(raw.id),
    name: raw.fullName ?? [raw.firstName, raw.lastName].filter(Boolean).join(' '),
    firstName: raw.firstName ?? '',
    lastName: raw.lastName ?? '',
    position,
    team: proTeamId > 0 ? (PRO_TEAMS[proTeamId] ?? null) : null,
    injuryStatus: raw.injuryStatus ?? null,
    active: raw.active ?? true,
    percentOwned: num(raw.ownership?.percentOwned),
    percentStarted: num(raw.ownership?.percentStarted),
    percentChange: num(raw.ownership?.percentChange),
    averageDraftPosition: num(raw.ownership?.averageDraftPosition),
    auctionValue: num(raw.ownership?.auctionValueAverage),
    positionalRank,
    outlook: keepOutlook ? (raw.seasonOutlook?.trim() || null) : null,
  };
}

/**
 * Picks one stat block out of a player payload.
 *
 * ESPN packs actuals, projections, season totals and weekly splits into one
 * flat array distinguished only by `statSourceId` (0 actual, 1 projected) and
 * `statSplitTypeId` (0 season, 1 week). Weekly *actual* blocks are keyed by NFL
 * game id rather than by week, so `scoringPeriodId` is the reliable way to
 * place them.
 */
export function selectStats(
  blocks: RawStatBlock[] | undefined,
  opts: { season: number; source: 0 | 1; split: 0 | 1; week?: number },
): RawStatBlock | null {
  for (const b of blocks ?? []) {
    if (b.seasonId !== opts.season) continue;
    if (b.statSourceId !== opts.source) continue;
    if (b.statSplitTypeId !== opts.split) continue;
    if (opts.week !== undefined && b.scoringPeriodId !== opts.week) continue;
    return b;
  }
  return null;
}

/** Normalises a stat block's raw id-keyed stats into keyed form. */
export function statLineOf(block: RawStatBlock | null | undefined): StatLine {
  return normalizeStatLine(block?.stats);
}
