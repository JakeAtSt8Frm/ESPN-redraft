import assert from 'node:assert/strict';
import { rosterOwnerByPlayer } from '../src/data/selectors';
import type { TeamInfo } from '../src/data/league';
import type { Roster } from '../src/lib/types';

function team(rosterId: number, name: string, players: string[], reserve: string[] = []): TeamInfo {
  const roster: Roster = {
    roster_id: rosterId,
    owner_id: null,
    league_id: 'league',
    players,
    starters: [],
    reserve,
    taxi: [],
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0 },
  };

  return {
    rosterId,
    name,
    abbrev: name.slice(0, 4).toUpperCase(),
    ownerName: name,
    avatar: null,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    roster,
    placement: null,
  };
}

const owners = rosterOwnerByPlayer([
  team(1, 'De’Von Intervention', ['starter', '0', 'on-ir'], ['on-ir']),
  team(2, 'Sam’s Smart Team', ['other', '-16007']),
]);

assert.deepEqual(owners.get('starter'), { rosterId: 1, name: 'De’Von Intervention' });
assert.deepEqual(owners.get('on-ir'), { rosterId: 1, name: 'De’Von Intervention' });
assert.deepEqual(owners.get('other'), { rosterId: 2, name: 'Sam’s Smart Team' });
assert.deepEqual(owners.get('-16007'), { rosterId: 2, name: 'Sam’s Smart Team' }, 'a D/ST has a negative id and is still owned');
assert.equal(owners.has('0'), false, 'an empty slot placeholder is nobody');

console.log('Player ownership checks passed.');
