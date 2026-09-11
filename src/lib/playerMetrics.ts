import { groupForPlayer, hasPlayed } from './scoring';
import type { Player, StatLine } from './types';

interface MetricWeek {
  stats: Record<string, StatLine>;
  teams: Record<string, string>;
}

export interface PlayerMetric {
  label: string;
  value: number | null;
  unit: 'number' | 'percent';
  detail: string;
}

/**
 * Opportunity and efficiency rates from ESPN game logs.
 *
 * Rates use summed numerators and denominators, not averages of weekly ratios,
 * so one two-target week can't dominate a catch rate. ESPN's logs carry volume
 * and yardage but no snap counts, air yards or red-zone splits, so the metrics
 * are the ones those columns can support honestly.
 */
export function playerMetrics(
  pid: string,
  player: Player,
  weeks: Map<number, MetricWeek>,
  throughWeek: number,
): { games: number; metrics: PlayerMetric[] } {
  const lines: StatLine[] = [];
  const teammates: StatLine[] = [];
  let hasAllTeamAssignments = true;
  for (const [week, payload] of weeks) {
    const line = payload.stats[pid];
    if (week > throughWeek || !hasPlayed(line)) continue;
    lines.push(line);
    const team = payload.teams[pid];
    if (!team) hasAllTeamAssignments = false;
    // A traded player's denominator follows his team in each observed week.
    // Positive ids only: a D/ST's line is team totals, not a teammate's share.
    if (team) {
      for (const [otherPid, other] of Object.entries(payload.stats)) {
        if (/^\d+$/.test(otherPid) && payload.teams[otherPid] === team) teammates.push(other);
      }
    }
  }
  const sum = (rows: StatLine[], key: string): number | null => {
    const values = rows.flatMap((row) =>
      typeof row[key] === 'number' && Number.isFinite(row[key]) ? [row[key] as number] : [],
    );
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  // A line that recorded nothing under a key simply lacks it, so a missing key
  // inside a played game is a zero, not an unknown.
  const sumOrZero = (rows: StatLine[], key: string): number | null =>
    rows.length ? (sum(rows, key) ?? 0) : null;
  const ratio = (numerator: number | null, denominator: number | null, scale = 1): number | null =>
    numerator !== null && denominator !== null && denominator > 0 ? (numerator / denominator) * scale : null;
  const own = (key: string) => sumOrZero(lines, key);
  const team = (key: string) => (hasAllTeamAssignments ? sumOrZero(teammates, key) : null);
  const metrics: PlayerMetric[] = [];
  const add = (label: string, value: number | null, detail: string, unit: PlayerMetric['unit'] = 'number') =>
    metrics.push({ label, value, detail, unit });
  const perGame = (label: string, key: string) =>
    add(label, ratio(own(key), lines.length), `Per game with recorded participation; ${key}`);
  const group = groupForPlayer(player);

  if (group === 'QB') {
    perGame('Pass attempts / game', 'pass_att');
    perGame('Rush attempts / game', 'rush_att');
    add('Completion rate', ratio(own('pass_cmp'), own('pass_att'), 100), 'Completions / pass attempts', 'percent');
    add('Passing yards / attempt', ratio(own('pass_yd'), own('pass_att')), 'Passing yards / attempts');
    const attempts = own('pass_att');
    const sacks = own('pass_sack');
    add(
      'Sack rate',
      ratio(sacks, attempts !== null && sacks !== null ? attempts + sacks : null, 100),
      'Sacks / (attempts + sacks); excludes scrambles',
      'percent',
    );
    add('TD rate', ratio(own('pass_td'), own('pass_att'), 100), 'Passing touchdowns / attempts', 'percent');
    add('INT rate', ratio(own('pass_int'), own('pass_att'), 100), 'Interceptions / attempts', 'percent');
  } else if (group === 'RB' || group === 'WR' || group === 'TE') {
    perGame('Targets / game', 'rec_tgt');
    if (group === 'RB') {
      perGame('Carries / game', 'rush_att');
      add(
        'Team carry share',
        ratio(own('rush_att'), team('rush_att'), 100),
        'Share of all team carries in the player’s observed games',
        'percent',
      );
      add('Yards / carry', ratio(own('rush_yd'), own('rush_att')), 'Rushing yards / carries');
    }
    add(
      'Team target share',
      ratio(own('rec_tgt'), team('rec_tgt'), 100),
      'Share of all team targets, across every position, in observed games',
      'percent',
    );
    add('Catch rate', ratio(own('rec'), own('rec_tgt'), 100), 'Receptions / targets', 'percent');
    add('Yards / target', ratio(own('rec_yd'), own('rec_tgt')), 'Receiving yards / targets');
  } else if (group === 'K') {
    perGame('FG attempts / game', 'fga');
    perGame('XP attempts / game', 'xpa');
    add('FG accuracy', ratio(own('fgm'), own('fga'), 100), 'Field goals made / attempted', 'percent');
  } else if (group === 'D/ST') {
    perGame('Sacks / game', 'def_sack');
    const takeaways = (() => {
      const ints = own('def_int');
      const fumbles = own('def_fum_rec');
      return ints === null && fumbles === null ? null : (ints ?? 0) + (fumbles ?? 0);
    })();
    add('Takeaways / game', ratio(takeaways, lines.length), 'Interceptions + fumble recoveries per game');
    perGame('Points allowed / game', 'def_pts_allowed');
    perGame('Yards allowed / game', 'def_yds_allowed');
  }
  return { games: lines.length, metrics };
}
