/**
 * Team Outlook — how many points each roster is projected to start, per week,
 * for the rest of the season.
 *
 * In a redraft league the only thing a roster is worth is the lineups it can
 * field between now and the final. So the outlook is measured in exactly that:
 * for every week left, the best legal lineup each team could set from its
 * current roster using ESPN's projection for that week, solved exactly by the
 * same matcher the Optimal page uses. Averaged over the weeks, that is
 * projected starter points per week — a number that is directly comparable
 * across teams and across positions, and that already prices byes (a player on
 * bye projects to nothing) and injuries (ESPN projects an injured player for
 * nothing until he is expected back).
 *
 * What it does not model: waiver pickups, trades and lineup mistakes. It is
 * the ceiling of the roster as it stands today.
 */

import { computeOptimalLineup } from './optimal';
import { POSITION_GROUPS, type PositionGroup } from './types';

export interface TeamOutlook {
  rosterId: number;
  /** Mean optimal starter points per remaining week. */
  perWeek: number;
  /** Mean over just the fantasy playoff weeks, when any remain. */
  playoffPerWeek: number | null;
  /** Weeks averaged over. */
  weeks: number;
  /** Mean points per week from starters at each position, flex included. */
  byGroup: Record<PositionGroup, number>;
}

export interface BuildOutlookInput {
  teams: Array<{ rosterId: number; playerIds: string[] }>;
  /** The league's starting slots. */
  slots: string[];
  groupOf: (pid: string) => PositionGroup | null;
  /** What a player is worth in a given week: his result if played, else his projection. */
  pointsFor: (week: number, pid: string) => number;
  fromWeek: number;
  finalWeek: number;
  playoffWeekStart: number;
}

export function buildRosOutlook(input: BuildOutlookInput): Map<number, TeamOutlook> {
  const { teams, slots, groupOf, pointsFor, fromWeek, finalWeek, playoffWeekStart } = input;
  const out = new Map<number, TeamOutlook>();

  for (const team of teams) {
    const players = [...new Set(team.playerIds)];
    const groupTotals = Object.fromEntries(POSITION_GROUPS.map((g) => [g, 0])) as Record<
      PositionGroup,
      number
    >;
    let total = 0;
    let playoffTotal = 0;
    let weeks = 0;
    let playoffWeeks = 0;

    for (let week = fromWeek; week <= finalWeek; week++) {
      const lineup = computeOptimalLineup(
        slots,
        players.map((pid) => ({ pid, group: groupOf(pid), points: Math.max(0, pointsFor(week, pid)) })),
      );
      weeks++;
      total += lineup.total;
      if (week >= playoffWeekStart) {
        playoffWeeks++;
        playoffTotal += lineup.total;
      }
      for (const assignment of lineup.assignments) {
        if (!assignment.pid) continue;
        const group = groupOf(assignment.pid);
        if (group) groupTotals[group] += assignment.points;
      }
    }

    const byGroup = Object.fromEntries(
      POSITION_GROUPS.map((g) => [g, weeks ? groupTotals[g] / weeks : 0]),
    ) as Record<PositionGroup, number>;

    out.set(team.rosterId, {
      rosterId: team.rosterId,
      perWeek: weeks ? total / weeks : 0,
      playoffPerWeek: playoffWeeks ? playoffTotal / playoffWeeks : null,
      weeks,
      byGroup,
    });
  }

  return out;
}

/** Scales scores so the strongest roster reads 100. */
export function powerIndexOf(score: number, best: number): number {
  if (!Number.isFinite(score) || best <= 0) return score > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (score / best) * 100));
}
