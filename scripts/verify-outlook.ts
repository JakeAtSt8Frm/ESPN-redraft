/**
 * Team Outlook checks: projected starter points per week, rest of season.
 *
 * The outlook claims three things, and each is pinned here on a fixture small
 * enough to work out by hand: a bye costs exactly the week it takes, an injured
 * starter is covered by the best bench player rather than scored as a hole,
 * and the positional split adds back up to the total.
 */

import assert from 'node:assert/strict';

import { buildRosOutlook, powerIndexOf } from '../src/lib/outlook';
import type { PositionGroup } from '../src/lib/types';

const slots = ['QB', 'RB', 'WR', 'FLEX'];
const groups: Record<string, PositionGroup> = {
  qb: 'QB',
  rb: 'RB',
  wr: 'WR',
  wr2: 'WR',
  hurt: 'RB',
};

// week -> pid -> points. The QB is on bye in week 2; the injured back is
// projected for nothing until week 3.
const points: Record<number, Record<string, number>> = {
  1: { qb: 20, rb: 15, wr: 12, wr2: 8, hurt: 0 },
  2: { qb: 0, rb: 15, wr: 12, wr2: 8, hurt: 0 },
  3: { qb: 20, rb: 15, wr: 12, wr2: 8, hurt: 18 },
};

const outlook = buildRosOutlook({
  teams: [{ rosterId: 1, playerIds: Object.keys(groups) }],
  slots,
  groupOf: (pid) => groups[pid] ?? null,
  pointsFor: (week, pid) => points[week]?.[pid] ?? 0,
  fromWeek: 1,
  finalWeek: 3,
  playoffWeekStart: 3,
}).get(1)!;

// Week 1: 20 + 15 + 12 + 8 (wr2 in the flex) = 55. Week 2: the bye costs the
// QB's 20 and nothing else = 35. Week 3: the returning back takes RB, the
// other back the flex: 20 + 18 + 12 + 15 = 65.
assert.equal(outlook.weeks, 3);
assert.equal(outlook.perWeek, (55 + 35 + 65) / 3, 'a bye must cost exactly its own week');
assert.equal(outlook.playoffPerWeek, 65, 'the playoff figure covers only the playoff weeks');
assert.ok(
  Math.abs(Object.values(outlook.byGroup).reduce((a, b) => a + b, 0) - outlook.perWeek) < 1e-9,
  'the positional split must add back up to the total',
);
assert.equal(outlook.byGroup.QB, 40 / 3);
assert.equal(outlook.byGroup.WR, (20 + 20 + 12) / 3, 'the flex counts toward the position of whoever fills it');

assert.equal(powerIndexOf(50, 100), 50);
assert.equal(powerIndexOf(0, 0), 0);

console.log('Team Outlook: byes, injury cover, playoff weeks and the positional split passed.');
