/**
 * Current availability, from ESPN's own player designations.
 *
 * ESPN reports one status per player — ACTIVE, QUESTIONABLE, DOUBTFUL, OUT,
 * INJURY_RESERVE, SUSPENSION — plus his NFL team, which is null for a player no
 * team holds. That is the whole of what the app knows about availability, and
 * it is as current as the snapshot.
 */

import type { NflState, Player } from './types';

export type NflRosterStatus = 'active' | 'free-agent' | 'reserve' | 'suspended' | 'inactive' | 'unknown';
export type HealthStatus = 'out' | 'doubtful' | 'questionable' | 'unreported';

export const ROSTER_LABELS: Record<NflRosterStatus, string> = {
  active: 'Active roster',
  'free-agent': 'NFL free agent',
  reserve: 'Injured reserve',
  suspended: 'Suspended',
  inactive: 'Inactive',
  unknown: 'Roster status unknown',
};

const normalize = (value: string | null | undefined) =>
  (value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');

export function rosterStatus(player: Player | undefined): NflRosterStatus {
  if (!player) return 'unknown';
  const status = normalize(player.injury_status);
  if (status === 'SUSPENSION' || status === 'SUSPENDED') return 'suspended';
  if (status === 'INJURY_RESERVE' || status === 'IR' || status === 'PUP') return 'reserve';
  // D/ST units always have a team; any other player without one is unsigned.
  if (!player.team) return 'free-agent';
  if (player.active === false) return 'inactive';
  return 'active';
}

export function healthStatus(player: Player | undefined): HealthStatus {
  const status = normalize(player?.injury_status);
  if (status === 'OUT' || status === 'INJURY_RESERVE') return 'out';
  if (status === 'DOUBTFUL') return 'doubtful';
  if (status === 'QUESTIONABLE' || status === 'DAY_TO_DAY') return 'questionable';
  return 'unreported';
}

export function unavailableNow(player: Player | undefined): boolean {
  const roster = rosterStatus(player);
  return !['active', 'unknown'].includes(roster) || healthStatus(player) === 'out';
}

/** Today's status must never erase an earlier week's results or projections. */
export function usesCurrentAvailability(state: NflState | undefined, season: string, week: number): boolean {
  return state?.season === season && state.season_type === 'regular' && week === Math.max(1, state.week);
}

/**
 * How much of a player's *demonstrated* form is usable right now.
 *
 * Policy discounts, not probabilities. They apply to the in-season half of the
 * Value Score only: that half is built from what a player has done, which says
 * nothing about whether he is available to do it again. The rest-of-season
 * half needs no discount, because it is built from ESPN's weekly projections
 * for the remaining weeks — and those already carry the absence. A player ESPN
 * expects back in week 7 is projected for nothing until week 7, and a player
 * lost for the year for nothing at all. Discounting that again would bill the
 * same missed games twice.
 */
export function availabilityFactor(player: Player | undefined): number {
  const roster: Record<NflRosterStatus, number> = {
    active: 1,
    unknown: 1,
    'free-agent': 0.1,
    reserve: 0.45,
    suspended: 0.4,
    inactive: 0.2,
  };
  const health: Record<HealthStatus, number> = {
    unreported: 1,
    questionable: 0.95,
    doubtful: 0.8,
    out: 0.65,
  };
  // IR and Out describe the same absence: don't compound the discounts.
  return Math.min(roster[rosterStatus(player)], health[healthStatus(player)]);
}
