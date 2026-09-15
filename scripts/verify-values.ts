/**
 * Sanity checks on the headline Value Score and the rest-of-season model,
 * run through the real loader over the committed snapshot of every league.
 *
 * Value is a percentile *within* a position group, and that is deliberate: it
 * answers "how good is he for a tight end", with every position read on the
 * same 0-1000 scale. So every position must have a leader near the top of the
 * scale and a middle near the middle. A model that let one position's scale
 * collapse — the failure the cross-position points scale showed when it was
 * tried as the headline in the ESPN app beside this one — fails here.
 *
 * "Near the top" is 800. Before anyone has played, the headline is the
 * rest-of-season score alone and every leader clears 900, the bar this check
 * began with. In season it blends two scales, and a position's best headline
 * falls short of both halves' best whenever they disagree about who leads —
 * most weeks, among 32 kickers or 32 defences. At 900 that disagreement alone
 * holds back most weeks' deploys; a collapsed scale sits far below 800.
 *
 * What a bar can't tell apart from that disagreement is a scale capped by a
 * signal that reads the same for everyone in a position: share of the unit,
 * for a kicker who has the whole unit to himself, held kickers and defences
 * short of the top from their first game. So that is checked directly — no
 * signal a score weighs may be flat across a position.
 *
 * The rest-of-season half has its own properties to hold: its points are the
 * sum of ESPN's remaining weekly projections, byes and injuries included, so a
 * player projected for nothing from here on can't out-value one who is; and
 * its buy/sell verdict has to disagree with the market sometimes without
 * disagreeing with it about everyone.
 *
 *   npm run verify:values
 *   MARKET=off npm run verify:values    # offline, no FantasyCalc
 */

import assert from 'node:assert/strict';

import { POSITION_GROUPS } from '../src/lib/types';
import { hasPlayed, hasValidProjection } from '../src/lib/scoring';
import { loadLocal } from './load-local';
import { requestedLeagues } from './league-paths';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Spearman rank correlation. */
function spearman(xs: number[], ys: number[]): number {
  const rank = (values: number[]) => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(values.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

for (const league of requestedLeagues()) {
  const data = await loadLocal(league.key);
  console.log(`\n${league.key} — ${data.league.name}, week ${data.currentWeek}, market ${data.marketCount} priced`);

  // ---- Headline Value, per position -------------------------------------------
  for (const group of POSITION_GROUPS) {
    const values = [...data.combinedScores]
      .filter(([pid]) => (data.rosIndex.byPlayer.get(pid)?.group ?? data.valueIndex.byPlayer.get(pid)?.group) === group)
      .map(([, v]) => v);
    const top = Math.max(...values);
    const mid = median(values);
    console.log(`  ${group.padEnd(4)} ${String(values.length).padStart(4)} rated · top ${top} · median ${mid.toFixed(0)}`);
    assert(values.length >= 20, `${group}: too few rated players (${values.length})`);
    assert(top >= 800, `${group}: the position's best player must lead near the top of the scale, got ${top}`);
    assert(mid >= 250 && mid <= 700, `${group}: the median must sit in the middle of the scale, got ${mid}`);
  }

  // ---- ...with no signal that reads the same for a whole position -------------
  const halves = [
    ['in-season', [...data.valueIndex.byPlayer.values()]],
    ['rest-of-season', [...data.rosIndex.byPlayer.values()]],
  ] as const;
  for (const [half, scores] of halves) {
    for (const group of POSITION_GROUPS) {
      const readings = new Map<string, Set<number>>();
      for (const value of scores) {
        if (value.group !== group) continue;
        for (const term of value.breakdown.contributions) {
          const seen = readings.get(term.label) ?? new Set<number>();
          seen.add(term.normalized);
          readings.set(term.label, seen);
        }
      }
      for (const [label, seen] of readings) {
        assert(
          seen.size > 1,
          `${group}: the ${half} score weighs "${label}", which reads ${[...seen][0]} for every player in the position`,
        );
      }
    }
  }
  console.log('  every weighted signal tells each position apart, in both halves');

  // ---- The rest-of-season sum is exactly ESPN's remaining weeks --------------
  const ros = data.rosIndex;
  let checked = 0;
  for (const [pid, value] of ros.byPlayer) {
    if (checked >= 200) break;
    let sum = 0;
    for (let week = ros.fromWeek; week <= data.maxWeek; week++) {
      const payload = data.weeks.get(week);
      const line = payload?.projections[pid];
      if (hasPlayed(payload?.stats[pid]) || !hasValidProjection(line)) continue;
      const points = data.score(line);
      if (points > 0) sum += points;
    }
    assert(
      Math.abs(value.breakdown.rosPoints - Math.round(sum * 10) / 10) < 0.051,
      `${pid}: rest-of-season points ${value.breakdown.rosPoints} must equal the remaining weekly projections, ${sum.toFixed(2)}`,
    );
    checked++;
  }
  console.log(`  rest-of-season points match the remaining weekly projections for ${checked} players`);

  // ---- ...and drive the rest-of-season score --------------------------------
  for (const group of POSITION_GROUPS) {
    const rows = [...ros.byPlayer.values()].filter((v) => v.group === group);
    const rho = spearman(rows.map((v) => v.breakdown.rosPoints), rows.map((v) => v.score));
    assert(rho > 0.75, `${group}: rest-of-season score must follow projected points (rank correlation ${rho.toFixed(2)})`);
  }

  // A player ESPN projects for nothing from here on — lost for the season, or
  // simply unprojected — cannot out-value an active projected peer on the
  // same market standing. Checked across the whole pool: every zero-point
  // player sits below the median projected player of his position.
  for (const group of POSITION_GROUPS) {
    const rows = [...ros.byPlayer.values()].filter((v) => v.group === group);
    const projected = rows.filter((v) => v.breakdown.rosPoints > 0).map((v) => v.score);
    const idle = rows.filter((v) => v.breakdown.rosPoints === 0 && v.breakdown.marketValue === null);
    if (!projected.length || !idle.length) continue;
    const bar = median(projected);
    const above = idle.filter((v) => v.score >= bar);
    assert.equal(above.length, 0, `${group}: ${above.length} unprojected players outrank the median projected one`);
  }

  // ---- Blend: before a player's first game, Value is the rest-of-season score -
  let blended = 0;
  for (const [pid, value] of data.combinedScores) {
    if (data.valueIndex.byPlayer.has(pid)) continue;
    assert.equal(value, ros.byPlayer.get(pid)?.score, `${pid}: with no games played, Value must equal the rest-of-season score`);
    blended++;
  }
  console.log(`  ${blended} players without a game carry their rest-of-season score as Value`);

  // ---- Buy / sell ----------------------------------------------------------------
  if (data.marketCount > 0) {
    const calls = [...ros.byPlayer.values()]
      .map((v) => v.breakdown.verdict)
      .filter((v) => v === 'Buy' || v === 'Sell' || v === 'Fair');
    const share = (label: string) => calls.filter((c) => c === label).length / calls.length;
    console.log(
      `  verdicts over ${calls.length} priced players: buy ${(share('Buy') * 100).toFixed(0)}% · ` +
        `fair ${(share('Fair') * 100).toFixed(0)}% · sell ${(share('Sell') * 100).toFixed(0)}%`,
    );
    assert(calls.length >= 50, 'the redraft market should price a useful pool');
    assert(share('Fair') >= 0.3, 'most of the market should read as fairly priced');
    assert(share('Buy') <= 0.45 && share('Sell') <= 0.45, 'neither call may swallow the pool');
  }
}

console.log('\nValue scale, rest-of-season sums, blend and verdict checks passed.');
