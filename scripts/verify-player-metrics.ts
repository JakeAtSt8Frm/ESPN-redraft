import assert from 'node:assert/strict';
import { playerMetrics } from '../src/lib/playerMetrics';
import { buildTeamStats } from '../src/lib/teamStats';
import type { Player, StatLine } from '../src/lib/types';

const player: Player = { player_id: '1', position: 'WR', team: 'DAL' };
const weeks = new Map<number, { stats: Record<string, StatLine>; teams: Record<string, string> }>([
  [1, { stats: {
    '1': { gp: 1, rec_tgt: 10, rec: 6, rec_yd: 80 },
    '2': { gp: 1, rec_tgt: 10, rush_att: 10, rush_yd: 50 },
    '3': { gp: 1, pass_att: 25, pass_cmp: 15, pass_yd: 200, pass_sack: 2 },
    // A D/ST line is team totals with a negative id; it is never a teammate.
    '-16012': { gp: 1, pass_att: 25, pass_yd: 200, rec_tgt: 20 },
  }, teams: { '1': 'KC', '2': 'KC', '3': 'KC', '-16012': 'KC' } }],
  [2, { stats: {
    '1': { gp: 1, rec_tgt: 5, rec: 3, rec_yd: 40 },
    '4': { gp: 1, rec_tgt: 25 },
    '5': { gp: 1, rec_tgt: 100 },
  }, teams: { '1': 'BUF', '4': 'BUF', '5': 'KC' } }],
  [3, { stats: { '1': { gp: 1, rec_tgt: 99 } }, teams: { '1': 'DAL' } }],
]);
const profile = playerMetrics('1', player, weeks, 2);
const metric = (name: string) => profile.metrics.find((m) => m.label === name)?.value;
assert.equal(profile.games, 2);
assert.equal(metric('Targets / game'), 7.5);
assert.equal(metric('Team target share'), 30, 'target share must include every receiving position and follow trades');
assert.equal(metric('Catch rate'), 60);
assert.ok(Math.abs(metric('Yards / target')! - 8) < 1e-10);
assert.equal(playerMetrics('1', player, new Map(), 1).metrics.find((m) => m.label === 'Catch rate')?.value, null, 'no games means no rate, not zero');
const noTeam = new Map([[1, { stats: { '1': { gp: 1, rec_tgt: 10 } }, teams: {} }]]);
assert.equal(playerMetrics('1', player, noTeam, 1).metrics.find((m) => m.label === 'Team target share')?.value, null);

// A shutout drops `def_pts_allowed` in compaction (zero values are not kept);
// inside a played game that absence is a zero, not an unknown.
const dst: Player = { player_id: '-16007', position: 'D/ST', team: 'DEN' };
const dstWeeks = new Map([
  [1, { stats: { '-16007': { gp: 1, def_sack: 4, def_int: 1, def_pts_allowed: 20 } }, teams: { '-16007': 'DEN' } }],
  [2, { stats: { '-16007': { gp: 1, def_sack: 2, def_fum_rec: 1 } }, teams: { '-16007': 'DEN' } }],
]);
const defence = playerMetrics('-16007', dst, dstWeeks, 2);
const dMetric = (name: string) => defence.metrics.find((m) => m.label === name)?.value;
assert.equal(dMetric('Sacks / game'), 3);
assert.equal(dMetric('Takeaways / game'), 1);
assert.equal(dMetric('Points allowed / game'), 10, 'a shutout counts as zero points allowed');

const stats = buildTeamStats(weeks, 2);
assert.equal(stats.get('KC')?.passYards, 200, 'exclude duplicate team aggregates');
assert.equal(stats.get('KC')?.rushYards, 50);
assert.equal(stats.get('KC')?.games, 1);
assert.equal(stats.has('BUF'), false, 'pregame statistics must exclude the selected game and later weeks');
assert.equal(buildTeamStats(weeks, 1).size, 0, 'week one has no pregame season sample');
console.log('Player rates, traded-team denominators, D/ST shutouts, missing data and pregame team stats checks passed.');
