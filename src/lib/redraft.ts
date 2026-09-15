/**
 * Rest-of-Season Value (0–1000) — the "what will he do from here" half.
 *
 * In a redraft league a player is worth exactly what he scores between now and
 * the end of this fantasy season, and nothing after it. So where the dynasty
 * model this replaces weighed age, career runway and multi-year production,
 * this one looks at one thing first: the points he is projected to score in
 * the weeks that are left.
 *
 * Those points are ESPN's own weekly projections for every remaining week,
 * scored under the league's table and summed. That sum is the right quantity
 * for three reasons that each matter in redraft:
 *
 *  - **Byes are in it.** A week with no game carries no projection.
 *  - **Injuries are in it.** ESPN projects a player it expects back in week 7
 *    for nothing until week 7, and a player lost for the year for nothing at
 *    all — so an absence costs exactly the games it takes, with no separate
 *    discount layered on top.
 *  - **The playoffs are in it.** The horizon runs through the fantasy final,
 *    not the end of the regular season.
 *
 * Around that sit three smaller legs: the redraft trade market (FantasyCalc,
 * plus ESPN's ownership), role, and efficiency. Every leg is a percentile
 * *within the player's own position group*, so this score averages cleanly
 * with the in-season Value Score in `value.ts` and reads the same way — "top of
 * his own pool", never comparable across positions. Anything that compares a
 * kicker to a receiver reads `breakdown.rosPoints` or `breakdown.vorp` instead.
 */

import type { MarketEntry } from './market';
import { createScorer, hasPlayed, hasValidProjection, opportunities, type ScoringModel } from './scoring';
import { clamp01, percentileRanks, round } from './stats';
import type { Player, PositionGroup, StatLine } from './types';
import { POSITION_TO_GROUP } from './types';
import type { ValueIndex } from './value';

/**
 * Leg weights (sum 1.0).
 *
 * Production dominates because in redraft it is the asset: the points are the
 * whole value and they are already net of byes and injuries. The market is a
 * real but minority voice, so the score stays an opinion the market can be
 * measured against (see `verdict`). Role and efficiency explain *why* the
 * projection is what it is and break ties inside a tier.
 */
export const ROS_WEIGHTS = {
  production: 0.6,
  market: 0.2,
  role: 0.15,
  efficiency: 0.05,
} as const;

type Leg = keyof typeof ROS_WEIGHTS;

const LEG_LABELS: Record<Leg, string> = {
  production: 'Rest-of-season projected points',
  market: 'Redraft market',
  role: 'Role & usage',
  efficiency: 'Efficiency',
};

export type MarketVerdict = 'Buy' | 'Sell' | 'Fair' | 'Thin market' | 'No read' | 'No market';
export type Trend = 'Rising' | 'Falling' | 'Stable' | 'Unknown';

/**
 * How far this model's rank must sit from the market's to call it.
 *
 * Both sides are percentiles over the same pool, so this reads directly: 0.15
 * is "the market has him fifteen percentiles lower than this model does".
 */
const VERDICT_GAP = 0.15;

/**
 * Below this market percentile a price is not worth comparing against: the
 * bottom of FantasyCalc's list is rounding noise, and a gap there measures
 * where a fringe player happened to land rather than any disagreement.
 */
const VERDICT_MIN_LIQUIDITY = 0.2;

export interface RosBreakdown {
  group: PositionGroup;
  /** First week the horizon counts (the first week not yet final). */
  fromWeek: number;
  /** Weeks left in the fantasy season, playoffs included. */
  weeksLeft: number;
  /** Horizon weeks ESPN projects him to play. */
  projectedGames: number;
  /** ESPN's weekly projections over the horizon, custom-scored and summed. */
  rosPoints: number;
  rosPpg: number | null;
  /** The same sum over just the fantasy playoff weeks. */
  playoffPoints: number;
  /** Rest-of-season points of the player at the startable cliff. */
  replacementPoints: number;
  /** Points over that replacement — the cross-position currency. */
  vorp: number;
  /** ESPN's full-season projection, custom-scored. */
  seasonProjection: number | null;
  currentPpg: number | null;
  games: number;
  priorPpg: number | null;
  priorGames: number;
  byeWeek: number | null;
  /** True while his bye is still ahead. */
  byeAhead: boolean;
  marketValue: number | null;
  marketOverallRank: number | null;
  marketPositionRank: number | null;
  marketTrend: Trend;
  percentOwned: number | null;
  percentStarted: number | null;
  percentChange: number | null;
  averageDraftPosition: number | null;
  auctionValue: number | null;
  espnRank: number | null;
  verdict: MarketVerdict;
  tier: string;
  contributions: Array<{ label: string; weight: number; normalized: number; points: number }>;
}

export interface RosValue {
  pid: string;
  score: number;
  group: PositionGroup;
  breakdown: RosBreakdown;
}

export interface RosIndex {
  byPlayer: Map<string, RosValue>;
  replacementByGroup: Map<PositionGroup, number>;
  fromWeek: number;
  weeksLeft: number;
}

export interface BuildRosIndexInput {
  valueIndex: ValueIndex;
  playersById: Map<string, Player>;
  scoringModel: ScoringModel;
  /** week -> pid -> ESPN projection, every week of the season. */
  weekProjections: Map<number, Record<string, StatLine>>;
  /** week -> pid -> result, to drop a week a player has already played. */
  weekStats: Map<number, Record<string, StatLine>>;
  /** pid -> ESPN full-season projection. */
  seasonProjections: Record<string, StatLine>;
  /** pid -> last season's custom-scored rate. */
  priorPpg: Map<string, { ppg: number; games: number }>;
  market: Map<string, MarketEntry>;
  rosterPositions: string[];
  numTeams: number;
  /** First week not yet final. */
  fromWeek: number;
  finalWeek: number;
  playoffWeekStart: number;
}

/* -------------------------------------------------------------------------- */
/* Replacement level                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How each flex slot distributes onto position groups — by how the slot is
 * realistically filled, not by what it technically accepts.
 */
const FLEX_SPLIT: Record<string, Partial<Record<PositionGroup, number>>> = {
  FLEX: { RB: 0.35, WR: 0.5, TE: 0.15 },
  WRRB_FLEX: { RB: 0.45, WR: 0.55 },
  REC_FLEX: { WR: 0.7, TE: 0.3 },
  SUPER_FLEX: { QB: 1 },
};

/**
 * Fractional starting depth per position, from the league's real lineup.
 *
 * Eight teams starting QB, 2 RB, 2 WR, TE, FLEX, D/ST and K put replacement at
 * roughly the 8th quarterback, the 19th running back and the 20th receiver.
 */
export function startingDepthByGroup(
  rosterPositions: string[],
  numTeams: number,
): Map<PositionGroup, number> {
  const perTeam = new Map<PositionGroup, number>();
  const add = (group: PositionGroup, n: number) =>
    perTeam.set(group, (perTeam.get(group) ?? 0) + n);

  for (const raw of rosterPositions) {
    const slot = String(raw).toUpperCase();
    if (slot === 'BN' || slot === 'IR') continue;
    const direct = POSITION_TO_GROUP[slot];
    if (direct) {
      add(direct, 1);
      continue;
    }
    for (const [group, share] of Object.entries(FLEX_SPLIT[slot] ?? {})) {
      add(group as PositionGroup, share ?? 0);
    }
  }

  const depth = new Map<PositionGroup, number>();
  for (const [group, n] of perTeam) depth.set(group, n * numTeams);
  return depth;
}

/**
 * The value of the player right at the startable cliff, averaged over a small
 * band so a single outlier doesn't set the baseline.
 */
function replacementLevel(sortedDesc: number[], depth: number): number {
  if (!sortedDesc.length) return 0;
  const idx = Math.max(0, Math.round(depth) - 1);
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(sortedDesc.length - 1, idx + 1);
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    sum += sortedDesc[i];
    n++;
  }
  return n ? sum / n : sortedDesc[sortedDesc.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

const TIERS: Array<[number, string]> = [
  [950, 'League winner'],
  [900, 'Elite weekly starter'],
  [850, 'Every-week starter'],
  [800, 'Strong starter'],
  [750, 'Starter'],
  [700, 'Flex or matchup starter'],
  [600, 'Bench depth with upside'],
  [500, 'Streamer or handcuff'],
  [0, 'Waiver-level'],
];

function tierFor(score: number): string {
  for (const [floor, label] of TIERS) if (score >= floor) return label;
  return TIERS[TIERS.length - 1][1];
}

interface Row {
  pid: string;
  group: PositionGroup;
  rosPoints: number;
  projectedGames: number;
  playoffPoints: number;
  projectedUsage: number | null;
  projectedEfficiency: number | null;
  observedRole: number | null;
  observedEfficiency: number | null;
  games: number;
  market: MarketEntry | null;
  percentOwned: number | null;
}

export function buildRosIndex(input: BuildRosIndexInput): RosIndex {
  const {
    valueIndex,
    playersById,
    scoringModel,
    weekProjections,
    weekStats,
    seasonProjections,
    priorPpg,
    market,
    rosterPositions,
    numTeams,
    fromWeek,
    finalWeek,
    playoffWeekStart,
  } = input;

  const score = createScorer(scoringModel);
  const weeksLeft = Math.max(0, finalWeek - fromWeek + 1);
  const depth = startingDepthByGroup(rosterPositions, numTeams);
  const groupOf = (pid: string): PositionGroup | null => {
    const position = playersById.get(pid)?.position;
    return position ? (POSITION_TO_GROUP[position.toUpperCase()] ?? null) : null;
  };

  // --- Sum the projections over the horizon -------------------------------
  const sums = new Map<string, { points: number; games: number; playoff: number; usage: number }>();
  for (let week = fromWeek; week <= finalWeek; week++) {
    const projections = weekProjections.get(week) ?? {};
    const stats = weekStats.get(week) ?? {};
    for (const [pid, line] of Object.entries(projections)) {
      // A week he has already played is behind him, not ahead.
      if (hasPlayed(stats[pid]) || !hasValidProjection(line)) continue;
      const group = groupOf(pid);
      if (!group) continue;
      const points = score(line);
      if (points <= 0) continue;
      const entry = sums.get(pid) ?? { points: 0, games: 0, playoff: 0, usage: 0 };
      entry.points += points;
      entry.games += 1;
      if (week >= playoffWeekStart) entry.playoff += points;
      entry.usage += opportunities(group, line) ?? 0;
      sums.set(pid, entry);
    }
  }

  // --- The universe: projected, producing, or priced ----------------------
  const pids = new Set<string>([...sums.keys(), ...valueIndex.byPlayer.keys()]);
  for (const pid of market.keys()) if (playersById.has(pid)) pids.add(pid);

  const rows: Row[] = [];
  const byGroup = new Map<PositionGroup, Row[]>();
  for (const pid of pids) {
    const group = groupOf(pid);
    if (!group) continue;
    const sum = sums.get(pid);
    const breakdown = valueIndex.byPlayer.get(pid)?.breakdown;
    const row: Row = {
      pid,
      group,
      rosPoints: sum?.points ?? 0,
      projectedGames: sum?.games ?? 0,
      playoffPoints: sum?.playoff ?? 0,
      projectedUsage: sum && sum.games > 0 && sum.usage > 0 ? sum.usage / sum.games : null,
      projectedEfficiency: sum && sum.usage >= 2 ? sum.points / sum.usage : null,
      observedRole: breakdown?.recentOpportunityShare ?? breakdown?.opportunityShare ?? null,
      observedEfficiency: breakdown?.efficiency ?? null,
      games: breakdown?.games ?? 0,
      market: market.get(pid) ?? null,
      percentOwned: playersById.get(pid)?.percent_owned ?? null,
    };
    rows.push(row);
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(row);
    else byGroup.set(group, [row]);
  }

  // --- Replacement level and within-group percentiles ----------------------
  const replacementByGroup = new Map<PositionGroup, number>();
  const pct = new Map<string, Record<string, number | undefined>>();
  const inGroup = (groupRows: Row[], pick: (r: Row) => number | null) =>
    percentileRanks(
      groupRows
        .filter((r) => pick(r) !== null)
        .map((r) => ({ id: r.pid, value: pick(r) as number })),
    );

  for (const [group, groupRows] of byGroup) {
    const sorted = groupRows.map((r) => r.rosPoints).sort((a, b) => b - a);
    replacementByGroup.set(group, replacementLevel(sorted, depth.get(group) ?? sorted.length));

    const production = inGroup(groupRows, (r) => r.rosPoints);
    const fantasyCalc = inGroup(groupRows, (r) => r.market?.value ?? null);
    const owned = inGroup(groupRows, (r) => r.percentOwned);
    // Observed and projected measures are different units, so each is ranked
    // in its own pool and a player is read from both — see `observedOverGames`.
    const roleObserved = inGroup(groupRows, (r) => r.observedRole);
    const roleProjected = inGroup(groupRows, (r) => r.projectedUsage);
    const effObserved = inGroup(groupRows, (r) => r.observedEfficiency);
    const effProjected = inGroup(groupRows, (r) => r.projectedEfficiency);

    for (const r of groupRows) {
      pct.set(r.pid, {
        production: production.get(r.pid),
        fantasyCalc: fantasyCalc.get(r.pid),
        owned: owned.get(r.pid),
        role: observedOverGames(roleObserved.get(r.pid), roleProjected.get(r.pid), r.games),
        efficiency: observedOverGames(effObserved.get(r.pid), effProjected.get(r.pid), r.games),
      });
    }
  }

  // --- Legs, and the market-free opinion the verdict compares --------------
  const legsByPid = new Map<string, { legs: Record<Leg, number>; intrinsic: number }>();
  for (const r of rows) {
    const p = pct.get(r.pid)!;
    const marketParts = [p.fantasyCalc, p.owned].filter((v): v is number => v !== undefined);
    const legs: Record<Leg, number> = {
      production: p.production ?? 0,
      market: marketParts.length
        ? marketParts.reduce((sum, v) => sum + v, 0) / marketParts.length
        : 0.5,
      role: p.role ?? 0.5,
      efficiency: p.efficiency ?? 0.5,
    };
    let sum = 0;
    let weight = 0;
    for (const key of ['production', 'role', 'efficiency'] as const) {
      sum += ROS_WEIGHTS[key] * legs[key];
      weight += ROS_WEIGHTS[key];
    }
    legsByPid.set(r.pid, { legs, intrinsic: sum / weight });
  }

  /*
   * Both halves of the buy/sell comparison are ranked over the *same* pool —
   * the players FantasyCalc prices at this position. Ranking them over
   * different pools turns the verdict into a restatement of "is he priced":
   * the unpriced tail sits below every priced player on the intrinsic side
   * and nowhere on the market side, so merely having a price reads as cheap.
   */
  const intrinsicRank = new Map<string, number>();
  const marketRank = new Map<string, number>();
  for (const groupRows of byGroup.values()) {
    const priced = groupRows.filter((r) => r.market !== null);
    for (const [pid, v] of percentileRanks(
      priced.map((r) => ({ id: r.pid, value: legsByPid.get(r.pid)!.intrinsic })),
    )) {
      intrinsicRank.set(pid, v);
    }
    for (const [pid, v] of percentileRanks(
      priced.map((r) => ({ id: r.pid, value: r.market!.value })),
    )) {
      marketRank.set(pid, v);
    }
  }

  // --- Score ----------------------------------------------------------------
  const byPlayer = new Map<string, RosValue>();
  for (const r of rows) {
    const { legs } = legsByPid.get(r.pid)!;
    let raw = 0;
    const contributions = (Object.keys(ROS_WEIGHTS) as Leg[]).map((key) => {
      const points = ROS_WEIGHTS[key] * legs[key];
      raw += points;
      return { label: LEG_LABELS[key], weight: ROS_WEIGHTS[key], normalized: legs[key], points };
    });

    // A projection covering only a game or two is thin evidence; blend it
    // toward neutral rather than let it swing the score end to end.
    const confidence = 0.85 + 0.15 * clamp01(r.projectedGames / 6);
    raw = 0.5 + (raw - 0.5) * confidence;
    const finalScore = Math.round(clamp01(raw) * 1000);

    const player = playersById.get(r.pid);
    const breakdown = valueIndex.byPlayer.get(r.pid)?.breakdown;
    const seasonLine = seasonProjections[r.pid];
    const replacement = replacementByGroup.get(r.group) ?? 0;
    const prior = priorPpg.get(r.pid) ?? null;
    const bye = player?.bye_week ?? null;

    byPlayer.set(r.pid, {
      pid: r.pid,
      score: finalScore,
      group: r.group,
      breakdown: {
        group: r.group,
        fromWeek,
        weeksLeft,
        projectedGames: r.projectedGames,
        rosPoints: round(r.rosPoints, 1),
        rosPpg: r.projectedGames > 0 ? round(r.rosPoints / r.projectedGames, 1) : null,
        playoffPoints: round(r.playoffPoints, 1),
        replacementPoints: round(replacement, 1),
        vorp: round(r.rosPoints - replacement, 1),
        seasonProjection: hasValidProjection(seasonLine) ? round(score(seasonLine), 1) : null,
        currentPpg: breakdown ? breakdown.ppg : null,
        games: r.games,
        priorPpg: prior ? round(prior.ppg, 1) : null,
        priorGames: prior?.games ?? 0,
        byeWeek: bye,
        byeAhead: bye !== null && bye >= fromWeek,
        marketValue: r.market?.value ?? null,
        marketOverallRank: r.market?.overallRank ?? null,
        marketPositionRank: r.market?.positionRank ?? null,
        marketTrend: trendFor(r.market),
        percentOwned: player?.percent_owned ?? null,
        percentStarted: player?.percent_started ?? null,
        percentChange: player?.percent_change ?? null,
        averageDraftPosition: player?.adp ?? null,
        auctionValue: player?.auction_value ?? null,
        espnRank: player?.positional_rank ?? null,
        verdict: verdictFor(
          r.market,
          intrinsicRank.get(r.pid) ?? null,
          marketRank.get(r.pid) ?? null,
          r.projectedGames > 0 || r.games > 0,
        ),
        tier: tierFor(finalScore),
        contributions,
      },
    });
  }

  return { byPlayer, replacementByGroup, fromWeek, weeksLeft };
}

/**
 * A player's rank on what he has shown, handed over from his rank on what ESPN
 * projects across his first four games — the horizon over which the headline
 * blend in `league.ts` hands weight to in-season form.
 *
 * Read outright, one game replaced a season of projection: the kicker ESPN
 * projects best for the rest of the year ranked last in his position on
 * efficiency after one poor week-1 game. Either rank alone is used when it is
 * the only one he has.
 */
export function observedOverGames(
  observed: number | undefined,
  projected: number | undefined,
  games: number,
): number | undefined {
  if (observed === undefined) return projected;
  if (projected === undefined) return observed;
  const weight = clamp01(games / 4);
  return weight * observed + (1 - weight) * projected;
}

/**
 * Buy / Sell / Fair, from two ranks over the same population.
 *
 * `intrinsicRank` is where this model puts the player among the priced players
 * at his position with every trace of the market removed; `marketRank` is where
 * FantasyCalc puts him among the same players. A gap between two percentiles
 * built the same way over the same pool is a real disagreement — which is the
 * whole claim the verdict makes.
 */
export function verdictFor(
  market: MarketEntry | null,
  intrinsicRank: number | null,
  marketRank: number | null,
  hasProduction: boolean,
): MarketVerdict {
  if (!market || intrinsicRank === null || marketRank === null) return 'No market';
  if (marketRank < VERDICT_MIN_LIQUIDITY) return 'Thin market';
  // With no projection and no games the intrinsic side is not an opinion, and
  // any gap it opens against the market would be manufactured.
  if (!hasProduction) return 'No read';

  const gap = intrinsicRank - marketRank;
  if (gap > VERDICT_GAP) return 'Buy';
  if (gap < -VERDICT_GAP) return 'Sell';
  return 'Fair';
}

function trendFor(market: MarketEntry | null): Trend {
  if (!market) return 'Unknown';
  const deadband = Math.max(20, market.value * 0.02);
  if (market.trend30Day > deadband) return 'Rising';
  if (market.trend30Day < -deadband) return 'Falling';
  return 'Stable';
}
