/**
 * The custom scoring engine.
 *
 * This is the heart of the app. Every number shown anywhere — projections,
 * actuals, value scores, matchup ratings, optimal lineups — traces back to
 * `scoreStatLine`. ESPN publishes a precomputed `appliedTotal` beside some stat
 * lines, and it is deliberately not the source of truth: it is absent from most
 * of the payloads the app needs (every projected line of a finished season,
 * for one) and carries no breakdown. Instead the league's own scoring settings
 * are multiplied against the raw stat line, the way ESPN does it internally,
 * and `npm run verify` checks the result against every `appliedTotal` ESPN does
 * publish.
 */

import type { Player, PositionGroup, ScoringSettings, StatLine } from './types';
import { POSITION_TO_GROUP } from './types';

/**
 * Compiled form of a league's scoring settings.
 *
 * Building this once and reusing it matters: a season of stats is ~1,000
 * players x 17 weeks plus a finished season behind it, and walking
 * `Object.entries` per call was the single hottest path in the original app.
 */
export interface ScoringModel {
  /** Only the stat keys with a non-zero multiplier, in a flat pair array. */
  keys: string[];
  multipliers: number[];
  raw: ScoringSettings;
}

/** Compiles league scoring settings into a fast, reusable scoring model. */
export function compileScoring(settings: ScoringSettings | undefined | null): ScoringModel {
  const keys: string[] = [];
  const multipliers: number[] = [];

  if (settings) {
    for (const [key, mult] of Object.entries(settings)) {
      // Zero-weighted keys can never affect the total, so drop them at compile
      // time. ESPN declares every D/ST ladder rung in the base table at zero.
      if (typeof mult === 'number' && mult !== 0 && Number.isFinite(mult)) {
        keys.push(key);
        multipliers.push(mult);
      }
    }
  }

  return { keys, multipliers, raw: settings ?? {} };
}

/**
 * Scores a single raw stat line under the league's custom scoring settings.
 *
 * Rounded to 2dp to match ESPN's own display rounding, which keeps our
 * per-player numbers summing to the same team total ESPN reports.
 */
export function scoreStatLine(model: ScoringModel, stats: StatLine | undefined | null): number {
  if (!stats) return 0;

  let total = 0;
  const { keys, multipliers } = model;
  for (let i = 0; i < keys.length; i++) {
    const v = stats[keys[i]];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v * multipliers[i];
    }
  }

  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/**
 * Memoising wrapper around `scoreStatLine`.
 *
 * Stat line objects are stable across a session (they come straight out of the
 * fetch cache), so a WeakMap keyed on the object identity gives us free
 * deduplication without any invalidation logic.
 */
export function createScorer(model: ScoringModel) {
  const cache = new WeakMap<object, number>();

  return function score(stats: StatLine | undefined | null): number {
    if (!stats) return 0;
    const cached = cache.get(stats);
    if (cached !== undefined) return cached;
    const value = scoreStatLine(model, stats);
    cache.set(stats, value);
    return value;
  };
}

export type Scorer = ReturnType<typeof createScorer>;

/**
 * Stat keys that indicate a player actually took the field.
 *
 * ESPN writes a game-log line for every game a player's team plays, and an
 * *empty* line means he did not appear — so presence in the map is not enough.
 * Every non-empty ESPN line carries `gp` (checked across all 11,849 weekly
 * lines of 2025: no exceptions either way); the volume keys are a fallback for
 * a line that arrives without it.
 */
const PARTICIPATION_KEYS = [
  'gp',
  'pass_att',
  'rush_att',
  'rec_tgt',
  'rec',
  'fga',
  'xpa',
  'def_pts_allowed',
  'def_yds_allowed',
] as const;

/** True when the stat line shows real game participation, not just a stub. */
export function hasPlayed(stats: StatLine | undefined | null): boolean {
  if (!stats) return false;
  for (const key of PARTICIPATION_KEYS) {
    const v = stats[key];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/**
 * True when a projection payload carries a usable forecast.
 *
 * ESPN emits projection blocks for players with no expectation of playing.
 * Treating those as a 0.0 projection would flag every inactive player as a
 * "boom", so at least one non-zero projected stat is required.
 */
export function hasValidProjection(stats: StatLine | undefined | null): boolean {
  if (!stats) return false;
  for (const key in stats) {
    const v = stats[key];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/** Resolves a player's scoring-relevant position group. */
export function groupForPlayer(player: Player | undefined | null): PositionGroup | null {
  if (!player?.position) return null;
  return POSITION_TO_GROUP[String(player.position).trim().toUpperCase()] ?? null;
}

/**
 * Opportunity volume for a player-week — a position-aware usage proxy.
 *
 * Volume is the most stable predictor of future scoring, so this feeds the
 * Value Score. Returns null where the idea doesn't apply, which callers treat
 * as neutral rather than as a zero.
 */
export function opportunities(group: PositionGroup, stats: StatLine): number | null {
  const n = (key: string): number => {
    const v = stats[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  // Game logs report targets; some projections report only receptions. Targets
  // are the better measure of role, so they are preferred when present.
  const receivingVolume = (): number => {
    const targets = stats.rec_tgt;
    return typeof targets === 'number' && Number.isFinite(targets) ? targets : n('rec');
  };

  switch (group) {
    case 'QB':
      return n('pass_att') + n('rush_att');
    case 'RB':
      return n('rush_att') + receivingVolume();
    case 'WR':
    case 'TE':
      return receivingVolume();
    case 'K':
      return n('fga') + n('xpa');
    case 'D/ST': {
      // A defence's "volume" is the plays it makes that the league pays for:
      // sacks and takeaways.
      const events = n('def_sack') + n('def_int') + n('def_fum_rec') + n('def_blk_kick');
      return events > 0 ? events : null;
    }
    default:
      return null;
  }
}

/**
 * Efficiency proxy for a player-week: points produced per opportunity.
 *
 * Kept position-aware so a kicker's per-attempt rate isn't compared against a
 * receiver's per-target rate. Returns null when volume is too small to be
 * meaningful, which the Value Score treats as neutral rather than as a zero.
 */
export function efficiency(
  group: PositionGroup,
  stats: StatLine,
  scored: number,
): number | null {
  const opps = opportunities(group, stats);
  if (opps === null || opps < 2) return null;
  return scored / opps;
}
