/**
 * Lineup alignment and history checks.
 *
 * ESPN reports a lineup as player -> slot; the lineup code reads the aligned
 * array where `starters[i]` fills `slots[i]`. These pin the three ways that
 * translation can go wrong: an empty slot shifting later players into earlier
 * slots, a week's real lineup being replaced by today's, and the IR slot being
 * read from today's injury tag instead of where the manager put the player.
 */

import assert from 'node:assert/strict';
import { alignStarters, type LeagueData, type TeamInfo } from '../src/data/league';
import { buildRosterWeek } from '../src/data/selectors';
import type { Player, Roster } from '../src/lib/types';

const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];

/* ---- alignment ------------------------------------------------------------ */

assert.deepEqual(
  alignStarters(
    { k: 'K', rb1: 'RB', qb: 'QB', wr1: 'WR', dst: 'D/ST', flex: 'FLEX', te: 'TE', rb2: 'RB', bench: 'BN' },
    slots,
  ),
  ['qb', 'rb1', 'rb2', 'wr1', '0', 'te', 'flex', 'dst', 'k'],
  'every starter must land in its own slot, an empty WR slot must stay empty, and the bench must not start',
);

/* ---- a week's own lineup wins over today's --------------------------------- */

const players: Player[] = [
  { player_id: 'qb', full_name: 'Quarterback', position: 'QB' },
  { player_id: 'rb1', full_name: 'Back One', position: 'RB' },
  { player_id: 'rb2', full_name: 'Back Two', position: 'RB' },
  { player_id: 'wr1', full_name: 'Receiver', position: 'WR' },
  { player_id: 'te', full_name: 'Tight End', position: 'TE' },
  { player_id: 'dst', full_name: 'Defense', position: 'D/ST' },
  { player_id: 'k', full_name: 'Kicker', position: 'K' },
  { player_id: 'hurt', full_name: 'On IR', position: 'WR', injury_status: 'INJURY_RESERVE' },
  { player_id: 'new', full_name: 'Waiver Add', position: 'RB' },
];

// Today: the waiver add starts at RB2 and the week-1 RB2 is gone.
const today: Record<string, string> = {
  qb: 'QB', rb1: 'RB', new: 'RB', wr1: 'WR', te: 'TE', dst: 'D/ST', k: 'K', hurt: 'IR',
};
const roster: Roster = {
  roster_id: 1,
  owner_id: null,
  league_id: 'league',
  players: Object.keys(today),
  starters: alignStarters(today, slots),
  reserve: ['hurt'],
  taxi: [],
  settings: { wins: 0, losses: 0, ties: 0, fpts: 0 },
};
const team: TeamInfo = {
  rosterId: 1, name: 'Slot Test', abbrev: 'SLOT', ownerName: 'Owner', avatar: null,
  wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, roster, placement: null,
};

// Week 1 as it was actually played: rb2 started, the IR player was benched.
const week1: Record<string, string> = {
  qb: 'QB', rb1: 'RB', rb2: 'RB', wr1: 'WR', te: 'TE', dst: 'D/ST', k: 'K', hurt: 'BN',
};
const weekData = (week: number, lineup: Record<string, string> | null) => ({
  week,
  stats: {},
  projections: {},
  opponents: {},
  teams: {},
  lineups: lineup ? { '1': lineup } : {},
  matchups: [
    {
      roster_id: 1,
      matchup_id: 1,
      points: 0,
      players: lineup ? Object.keys(lineup) : null,
      starters: lineup ? alignStarters(lineup, slots) : null,
    },
  ],
});

const data = {
  season: '2026',
  nflState: { season: '2026', season_type: 'regular', week: 2, display_week: 2 },
  playersById: new Map(players.map((player) => [player.player_id, player])),
  teams: [team],
  teamsById: new Map([[team.rosterId, team]]),
  weeks: new Map([
    [1, weekData(1, week1)],
    [2, weekData(2, null)],
  ]),
  starterSlots: slots,
  score: () => 0,
  valueIndex: { byPlayer: new Map(), seasonTotals: new Map(), ppgRanks: new Map(), totalRanks: new Map() },
  combinedScores: new Map(),
  matchupIndex: { get: () => null },
  pregameMatchupIndexes: new Map(),
} as unknown as LeagueData;

const played = buildRosterWeek(data, 1, 1)!;
assert.deepEqual(
  played.starters.map(({ pid }) => pid),
  ['qb', 'rb1', 'rb2', 'wr1', 'te', 'dst', 'k'],
  'a played week must show the lineup that played it, not today’s',
);
assert.deepEqual(
  played.bench.map(({ pid }) => pid),
  ['hurt'],
  'a player benched that week is on the bench, whatever today’s injury tag says',
);
assert.equal(played.injured.length, 0);
assert.equal(
  played.optimalLineup.assignments.filter((a) => a.pid === null).length,
  1,
  'eight players for nine slots must solve — leaving one slot empty — rather than loop forever',
);

const upcoming = buildRosterWeek(data, 1, 2)!;
assert.deepEqual(
  upcoming.starters.map(({ pid }) => pid),
  ['qb', 'rb1', 'new', 'wr1', 'te', 'dst', 'k'],
  'a week not yet started shows today’s lineup, which is the one that will play it',
);
assert.deepEqual(upcoming.injured.map(({ pid }) => pid), ['hurt'], 'today’s IR slot is the IR section');

console.log('Lineup alignment, played-week history and IR placement checks passed.');
