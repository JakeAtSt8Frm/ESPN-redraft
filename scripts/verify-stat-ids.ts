/**
 * Validates the stat-id table against evidence outside the scoring identity.
 *
 * This is the check `verify-scoring.ts` cannot be. That one recomputes
 * `Σ settings[key] × stats[key]` and compares it to ESPN's own total — but both
 * of its factors are keyed through `STAT_IDS`, so **any consistent permutation
 * of the table cancels out and it still reports 100%**. The ESPN app this one
 * sits beside carried four mislabelled D/ST ids for weeks behind a passing
 * scoring check.
 *
 * A label is only worth anything if something could refute it. Two things can:
 *
 *  - **Arithmetic against another field on the same line.** The points- and
 *    yards-allowed ladders are mutually exclusive flags sitting beside the raw
 *    total they describe (ids 120 and 127), so every game either agrees or does
 *    not. The kicking distance buckets partition every field goal made, so they
 *    must sum to the made total on the same line.
 *  - **Frequency.** A key called `def_sack` that fires in half a defence's games
 *    at 0.7 a time is not sacks, whatever the arithmetic says. The bounds are
 *    deliberately wide — the point is to catch a renumbering, not to assert that
 *    one season's rates repeat.
 *
 * Runs over last season's logs in `prior.json` plus every week of this season
 * already played.
 *
 *   npm run verify:stat-ids                     # every league
 *   ESPN_LEAGUE=oj-invitational npm run verify:stat-ids
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  SnapshotIndex,
  SnapshotLeague,
  SnapshotPlayers,
  SnapshotPrior,
  SnapshotWeek,
} from '../src/lib/snapshot-types';
import type { StatLine } from '../src/lib/types';
import { dataDir, requestedLeagues } from './league-paths';

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

const n = (line: StatLine, key: string): number => {
  const v = line[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Points-allowed ladder: key -> inclusive range. */
const PA: Array<[string, number, number]> = [
  ['def_pa_0', 0, 0],
  ['def_pa_1_6', 1, 6],
  ['def_pa_7_13', 7, 13],
  ['def_pa_14_17', 14, 17],
  ['def_pa_18_21', 18, 21],
  ['def_pa_22_27', 22, 27],
  ['def_pa_28_34', 28, 34],
  ['def_pa_35_45', 35, 45],
  ['def_pa_46p', 46, Infinity],
];

/** Yards-allowed ladder. */
const YA: Array<[string, number, number]> = [
  ['def_ya_0_99', 0, 99],
  ['def_ya_100_199', 100, 199],
  ['def_ya_200_299', 200, 299],
  ['def_ya_300_349', 300, 349],
  ['def_ya_350_399', 350, 399],
  ['def_ya_400_449', 400, 449],
  ['def_ya_450_499', 450, 499],
  ['def_ya_500_549', 500, 549],
  ['def_ya_550p', 550, Infinity],
];

/** D/ST counting stats: key -> [mean per game low, high, share of games low, high]. */
const DST_RATES: Array<[string, number, number, number, number]> = [
  ['def_sack', 1.6, 3.4, 0.7, 0.97],
  ['def_int', 0.4, 1.1, 0.3, 0.7],
  ['def_fum_rec', 0.2, 0.8, 0.15, 0.55],
  ['def_blk_kick', 0, 0.2, 0, 0.18],
  ['def_safe', 0, 0.08, 0, 0.08],
];

for (const league of requestedLeagues()) {
  const dir = dataDir(league);
  const index = await json<SnapshotIndex>(join(dir, 'index.json'));
  const file = await json<SnapshotLeague>(join(dir, 'league.json'));
  const players = await json<SnapshotPlayers>(join(dir, 'players.json'));
  const prior = await json<SnapshotPrior>(join(dir, 'prior.json')).catch(() => null);
  const scored = (key: string) => (file.league.scoringSettings[key] ?? 0) !== 0;

  console.log(`\n${league.key} — ${file.league.name}`);

  // Every D/ST and kicker line, last season and this one.
  const groupOf = new Map<string, string>();
  for (const p of players.players) if (p.position) groupOf.set(p.id, p.position);
  for (const [pid, group] of Object.entries(prior?.positions ?? {})) groupOf.set(pid, group);

  const dst: StatLine[] = [];
  const kickers: StatLine[] = [];
  const collect = (actuals: Record<string, StatLine>) => {
    for (const [pid, line] of Object.entries(actuals)) {
      if (!n(line, 'gp')) continue;
      if (groupOf.get(pid) === 'D/ST') dst.push(line);
      else if (groupOf.get(pid) === 'K') kickers.push(line);
    }
  };
  for (const week of Object.values(prior?.weeks ?? {})) collect(week.actuals);
  for (const week of index.weeks.filter((w) => w <= index.currentWeek)) {
    collect((await json<SnapshotWeek>(join(dir, 'weeks', `${week}.json`))).actuals);
  }
  console.log(`  ${dst.length} D/ST games, ${kickers.length} kicker games`);

  // ---- Ladders against the total beside them --------------------------------
  const ladder = (label: string, total: string, rungs: Array<[string, number, number]>) => {
    const live = rungs.filter(([key]) => scored(key));
    if (!live.length) {
      console.log(`  --   ${label}: this league scores none of it`);
      return;
    }
    let agree = 0;
    const bad: string[] = [];
    for (const line of dst) {
      const value = n(line, total);
      // Each scored rung must be flagged exactly when the total falls in it.
      const wrong = live.filter(([key, lo, hi]) => (n(line, key) > 0) !== (value >= lo && value <= hi));
      if (wrong.length === 0) agree++;
      else if (bad.length < 3) bad.push(`${total}=${value}, flags ${wrong.map(([k]) => k).join(',')}`);
    }
    check(`${label} (${live.map(([k]) => k).join(', ')})`, agree === dst.length, `${agree}/${dst.length} games agree${bad.length ? `; e.g. ${bad.join(' | ')}` : ''}`);
  };
  ladder('Points-allowed ladder vs points allowed', 'def_pts_allowed', PA);
  ladder('Yards-allowed ladder vs yards allowed', 'def_yds_allowed', YA);

  // ---- Frequency ---------------------------------------------------------------
  if (dst.length >= 100) {
    for (const [key, meanLo, meanHi, shareLo, shareHi] of DST_RATES) {
      if (!scored(key)) continue;
      const values = dst.map((line) => n(line, key));
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const share = values.filter((v) => v > 0).length / values.length;
      check(
        `${key} looks like ${key.replace('def_', '').replace('_', ' ')}`,
        mean >= meanLo && mean <= meanHi && share >= shareLo && share <= shareHi,
        `${mean.toFixed(2)} per game, in ${(share * 100).toFixed(0)}% of games`,
      );
    }
  }

  // ---- Kicking buckets partition the made total --------------------------------
  const buckets = ['fgm_0_39', 'fgm_40_49', 'fgm_50_59', 'fgm_60p'].filter(scored);
  if (buckets.length === 4) {
    const agree = kickers.filter(
      (line) => buckets.reduce((sum, key) => sum + n(line, key), 0) === n(line, 'fgm'),
    ).length;
    check('Field-goal distance buckets sum to field goals made', agree === kickers.length, `${agree}/${kickers.length} games`);
    const long = kickers.reduce((s, l) => s + n(l, 'fgm_50_59') + n(l, 'fgm_60p'), 0);
    const short = kickers.reduce((s, l) => s + n(l, 'fgm_0_39'), 0);
    // Real kickers make far more short field goals than 50+ ones; a reversed
    // bucket table reads the other way round.
    check('Short field goals outnumber 50+ ones', short > long * 1.5, `${short} under 40 vs ${long} from 50+`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} stat-id check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nStat ids hold against every independent check.');
}
