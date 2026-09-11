/**
 * Checks the scoring engine against ESPN's own numbers.
 *
 * ESPN computes an `appliedTotal` server-side, under each league's real
 * settings, for every weekly actual and projection it returns — and a team
 * score for every matchup. The snapshot keeps them in `snapshot-meta/`. This
 * recomputes every one of them from the raw stat lines with the one scoring
 * table the app uses (base scoring with the D/ST overrides folded in) and
 * requires agreement to the cent.
 *
 * What it proves and what it doesn't: agreement proves the *arithmetic* — the
 * multipliers, the D/ST fold, the compaction that drops unscored keys. It does
 * not prove the stat-id *names* are right, because both sides of the multiply
 * are keyed through the same table and a consistent relabelling cancels out.
 * `npm run verify:stat-ids` is the check for that.
 *
 *   npm run verify                      # every league
 *   ESPN_LEAGUE=uk-bg npm run verify    # one
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { alignStarters } from '../src/data/league';
import { compileScoring, scoreStatLine } from '../src/lib/scoring';
import { starterSlots } from '../src/lib/optimal';
import type {
  SnapshotApplied,
  SnapshotIndex,
  SnapshotLeague,
  SnapshotWeek,
} from '../src/lib/snapshot-types';
import { dataDir, metaDir, requestedLeagues } from './league-paths';

const TOLERANCE = 0.011;

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

interface Tally {
  compared: number;
  mismatches: Array<{ what: string; ours: number; espn: number }>;
}

function check(tally: Tally, what: string, ours: number, espn: number) {
  tally.compared++;
  if (Math.abs(ours - espn) > TOLERANCE) tally.mismatches.push({ what, ours, espn });
}

let failed = false;

for (const league of requestedLeagues()) {
  const dir = dataDir(league);
  const index = await json<SnapshotIndex>(join(dir, 'index.json'));
  const file = await json<SnapshotLeague>(join(dir, 'league.json'));
  const applied = await json<SnapshotApplied>(join(metaDir(league), 'applied.json')).catch(() => null);

  console.log(`\n${league.key} — ${file.league.name}, ${file.league.receptionPoints} per reception`);
  if (!applied || applied.generatedAt !== index.generatedAt) {
    console.log('  no ESPN totals for this snapshot (run `npm run snapshot` first) — skipped');
    continue;
  }

  const model = compileScoring(file.league.scoringSettings);
  const slots = starterSlots(file.league.rosterPositions);
  const actual: Tally = { compared: 0, mismatches: [] };
  const projected: Tally = { compared: 0, mismatches: [] };
  const teams: Tally = { compared: 0, mismatches: [] };

  for (const week of index.weeks) {
    const data = await json<SnapshotWeek>(join(dir, 'weeks', `${week}.json`));

    for (const [pid, espn] of Object.entries(applied.actual[week] ?? {})) {
      const line = data.actuals[pid];
      if (!line) continue;
      check(actual, `week ${week} player ${pid} actual`, scoreStatLine(model, line), espn);
    }
    for (const [pid, espn] of Object.entries(applied.projected[week] ?? {})) {
      const line = data.projections[pid];
      if (!line) continue;
      check(projected, `week ${week} player ${pid} projection`, scoreStatLine(model, line), espn);
    }

    // A team's score is its starters' points — which only reconciles once
    // every starter's game is final, so only completed weeks are compared.
    if (week > index.latestCompletedWeek) continue;
    for (const [teamId, espn] of Object.entries(applied.teamScores[week] ?? {})) {
      const lineup = data.lineups[teamId];
      if (!lineup) continue;
      const ours = alignStarters(lineup, slots)
        .filter((pid) => pid !== '0')
        .reduce((sum, pid) => sum + scoreStatLine(model, data.actuals[pid]), 0);
      check(teams, `week ${week} team ${teamId}`, Math.round(ours * 100) / 100, espn);
    }
  }

  for (const [label, tally] of [
    ['player-week actuals', actual],
    ['player-week projections', projected],
    ['team-week totals', teams],
  ] as const) {
    const rate = tally.compared ? (1 - tally.mismatches.length / tally.compared) * 100 : 100;
    console.log(
      `  ${label.padEnd(24)} ${String(tally.compared).padStart(6)} compared, ` +
        `${tally.mismatches.length} mismatches (${rate.toFixed(3)}%)`,
    );
    for (const m of tally.mismatches.slice(0, 5)) {
      console.log(`    ${m.what}: ours ${m.ours.toFixed(2)}, ESPN ${m.espn.toFixed(2)}`);
    }
    if (tally.mismatches.length > 0) failed = true;
  }
}

if (failed) {
  console.error('\nScoring does not reconcile with ESPN.');
  process.exitCode = 1;
} else {
  console.log('\nScoring reconciles with ESPN.');
}
