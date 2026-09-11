/**
 * Pulls every league from ESPN and writes the static snapshot the app reads.
 *
 * This script is the *only* thing that talks to ESPN, and the only thing that
 * sees the credentials. It runs in Node — locally before a build, or on a
 * schedule in CI — and writes plain JSON into `public/data/<league>`. The
 * shipped bundle has no cookie in it and makes no ESPN request.
 *
 * Each league is read with its own cookie pair (see `credentialNames` in
 * `src/lib/leagues.ts`), from the environment or a gitignored `.env`:
 *
 *   npm run snapshot                    # every league
 *   npm run snapshot -- --league uk-bg  # just that one
 *
 * One league failing does not abandon the others — they are independent
 * snapshots in independent directories — but the exit code still reports it,
 * so CI does not call a half-finished run a success.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ESPN_HOST,
  ESPN_POSITION_IDS,
  espnFetch,
  effectiveScoring,
  LINEUP_SLOTS,
  leagueUrl,
  parsePlayer,
  parseSchedule,
  parseScoringSettings,
  parseTeams,
  PRO_TEAMS,
  rankTypeFor,
  rosterPositions,
  selectStats,
  separateIndividualKeys,
  statLineOf,
  type EspnCredentials,
  type RawPlayer,
  type RawStatBlock,
} from '../src/lib/espn';
import { credentialNames, type LeagueConfig } from '../src/lib/leagues';
import { compileScoring, scoreStatLine } from '../src/lib/scoring';
import {
  SNAPSHOT_VERSION,
  type SnapshotApplied,
  type SnapshotIndex,
  type SnapshotLeague,
  type SnapshotPlayers,
  type SnapshotPrior,
  type SnapshotProGame,
  type SnapshotWeek,
} from '../src/lib/snapshot-types';
import type { PositionGroup, StatLine } from '../src/lib/types';
import { dataDir, metaDir, requestedLeagues, ROOT } from './league-paths';

const SEASON = Number(process.env.ESPN_SEASON || new Date().getFullYear());
const PRIOR_SEASON = SEASON - 1;

/** Loads `.env` without a dependency. Real environment variables win. */
async function loadDotEnv(): Promise<void> {
  try {
    const text = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  } catch {
    /* no .env — expected in CI, where the variables come from secrets */
  }
}

/** The league's own cookie pair, falling back to a shared one. */
function credentials(league: LeagueConfig): EspnCredentials {
  const names = credentialNames(league);
  const swid = process.env[names.swid] || process.env.ESPN_SWID;
  const espnS2 = process.env[names.s2] || process.env.ESPN_S2;

  if (!swid || !espnS2) {
    throw new Error(
      `Missing ESPN credentials for ${league.key}. Set ${names.swid} and ${names.s2} ` +
        '(or a shared ESPN_SWID / ESPN_S2) in the environment or in .env. Both are ' +
        'cookies on espn.com from a logged-in browser session.',
    );
  }

  // SWID is braced in the cookie jar and people paste it both ways.
  return { swid: swid.startsWith('{') ? swid : `{${swid}}`, espnS2 };
}

/**
 * Keys kept in the snapshot beyond the ones that score.
 *
 * ESPN attaches dozens of derived rates and undocumented ids to every line.
 * None can move a score, and carrying them triples the payloads. These are the
 * ones the app reads for participation, role, volume and team context.
 */
const USAGE_KEYS = new Set([
  'gp',
  'pass_att',
  'pass_cmp',
  'pass_sack',
  'rush_att',
  'rec_tgt',
  'rec',
  'rec_yd',
  'rush_yd',
  'pass_yd',
  'fga',
  'xpa',
  'fgm',
  'fum',
  'def_yds_allowed',
  'def_pts_allowed',
]);

/**
 * Rounds away float noise: projections arrive with nine decimal places.
 *
 * Four, not three. A D/ST projection is a ladder of small probabilities — a
 * 1.2% chance of a shutout at ten points — and at three places the rounding
 * summed to a couple of hundredths, enough to fail the cent-exact check against
 * ESPN's own totals.
 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Drops zero, missing and non-kept entries — after moving an individual's
 * copies of D/ST-scored stats onto their own keys (see `effectiveScoring`).
 */
function compactWith(keep: Set<string>, splitKeys: ReadonlySet<string>) {
  return (line: StatLine, group: PositionGroup | undefined): StatLine => {
    const source = group === 'D/ST' ? line : separateIndividualKeys(line, splitKeys);
    const out: StatLine = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
      if (!keep.has(key)) continue;
      out[key] = round4(value);
    }
    return out;
  };
}

interface PlayerEnvelope {
  player: RawPlayer & { stats?: RawStatBlock[] };
  onTeamId?: number;
}

const PLAYER_FILTER = {
  players: {
    limit: 2000,
    sortPercOwned: { sortAsc: false, sortPriority: 1 },
    filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] },
  },
};

/**
 * Outlook text is kept only for players likely to be opened.
 *
 * ESPN writes a paragraph for most of the universe, and at ~220 bytes each it
 * was a fifth of the players file for rows nobody reads.
 */
const OUTLOOK_MIN_OWNED = 2;

async function pullLeague(config: LeagueConfig, creds: EspnCredentials): Promise<void> {
  const LEAGUE_ID = config.leagueId;
  const OUT = dataDir(config);
  const META = metaDir(config);
  const log = (msg: string) => process.stdout.write(`${msg}\n`);

  log(`league ${LEAGUE_ID} (${config.key}), season ${SEASON}`);
  const generatedAt = Date.now();

  // --- League, teams, schedule, draft -------------------------------------
  const raw = await espnFetch<any>(
    leagueUrl({
      season: SEASON,
      leagueId: LEAGUE_ID,
      views: ['mSettings', 'mTeam', 'mRoster', 'mMatchup', 'mStandings', 'mDraftDetail', 'mStatus'],
    }),
    creds,
  );

  const settings = raw.settings ?? {};
  const scheduleSettings = settings.scheduleSettings ?? {};

  /*
   * The app treats a matchup period as one scoring period — a week. Both
   * leagues here play one-week matchups and one-week playoff rounds, and a
   * league that did not would need the week/period mapping threaded through
   * every page. Refusing it here is cheaper than finding out from the numbers.
   */
  for (const [period, scoringPeriods] of Object.entries(scheduleSettings.matchupPeriods ?? {})) {
    const ids = scoringPeriods as number[];
    if (ids.length !== 1 || ids[0] !== Number(period)) {
      throw new Error(
        `Matchup period ${period} spans scoring periods ${ids.join(',')}; multi-week ` +
          'matchups are not supported.',
      );
    }
  }

  const { base, overrides } = parseScoringSettings(settings.scoringSettings?.scoringItems ?? []);
  const { table: scoring, splitKeys } = effectiveScoring(base, overrides);
  const receptionPoints = scoring.rec ?? 0;

  const schedule = parseSchedule(raw.schedule ?? []);
  const weeksInSchedule = new Map<number, boolean>();
  for (const m of schedule) {
    const done = m.winner !== 'UNDECIDED';
    weeksInSchedule.set(m.week, (weeksInSchedule.get(m.week) ?? true) && done);
  }
  let latestCompletedWeek = 0;
  for (const [week, done] of [...weeksInSchedule].sort((a, b) => a[0] - b[0])) {
    if (!done) break;
    latestCompletedWeek = week;
  }

  const finalWeek = Number(raw.status?.finalScoringPeriod ?? 17);
  const currentWeek = Math.max(1, Math.min(finalWeek, Number(raw.scoringPeriodId ?? 1)));
  const regularSeasonWeeks = Number(scheduleSettings.matchupPeriodCount ?? 14);
  const drafted = Boolean(raw.draftDetail?.drafted);
  const seasonOver = latestCompletedWeek >= finalWeek;

  const teams = parseTeams(raw.teams ?? [], raw.members ?? [], seasonOver);
  const positions = rosterPositions(settings.rosterSettings?.lineupSlotCounts ?? {});

  log(
    `  ${settings.name}: ${teams.length} teams, week ${currentWeek} of ${finalWeek}, ` +
      `${latestCompletedWeek} complete${drafted ? '' : ', not yet drafted'}; ` +
      `${receptionPoints} per reception`,
  );

  // Everything the league scores plus the usage keys — the snapshot keeps nothing else.
  const keep = new Set<string>(USAGE_KEYS);
  for (const [key, mult] of Object.entries(scoring)) if (mult !== 0) keep.add(key);
  const compact = compactWith(keep, new Set(splitKeys));
  const model = compileScoring(scoring);
  const groupOf = (player: RawPlayer) => ESPN_POSITION_IDS[player.defaultPositionId ?? -1];

  // --- Pro schedule: byes, opponents and kickoffs ---------------------------
  const pro = await espnFetch<any>(
    `${ESPN_HOST}/apis/v3/games/ffl/seasons/${SEASON}?view=proTeamSchedules_wl`,
    creds,
  );
  const byeWeeks: Record<string, number> = {};
  const gamesById = new Map<number, SnapshotProGame>();
  for (const team of pro.settings?.proTeams ?? []) {
    const abbrev = PRO_TEAMS[team.id];
    if (!abbrev) continue;
    if (typeof team.byeWeek === 'number' && team.byeWeek > 0) byeWeeks[abbrev] = team.byeWeek;
    for (const [week, games] of Object.entries(team.proGamesByScoringPeriod ?? {})) {
      for (const game of games as any[]) {
        if (!game?.id || gamesById.has(game.id)) continue;
        const home = PRO_TEAMS[game.homeProTeamId];
        const away = PRO_TEAMS[game.awayProTeamId];
        if (!home || !away) continue;
        gamesById.set(game.id, { week: Number(week), gameId: game.id, home, away, kickoff: game.date ?? 0 });
      }
    }
  }
  const proGames = [...gamesById.values()].sort((a, b) => a.week - b.week || a.kickoff - b.kickoff);
  log(`  pro schedule: ${proGames.length} games`);

  // --- The player universe ---------------------------------------------------
  const universe = await espnFetch<{ players: PlayerEnvelope[] }>(
    leagueUrl({ season: SEASON, leagueId: LEAGUE_ID, views: ['kona_player_info'] }),
    creds,
    { filter: PLAYER_FILTER },
  );
  const rankType = rankTypeFor(receptionPoints);
  const envelopes = (universe.players ?? []).filter(
    (e) => ESPN_POSITION_IDS[e.player.defaultPositionId ?? -1] !== undefined,
  );
  const players = envelopes.map((e) =>
    parsePlayer(e.player, rankType, (e.player.ownership?.percentOwned ?? 0) >= OUTLOOK_MIN_OWNED),
  );
  const seasonProjection: Record<string, StatLine> = {};
  for (const { player } of envelopes) {
    const block = selectStats(player.stats, { season: SEASON, source: 1, split: 0 });
    if (!block) continue;
    const line = compact(statLineOf(block), groupOf(player));
    if (Object.keys(line).length > 0) seasonProjection[String(player.id)] = line;
  }
  log(`  players: ${players.length} (${Object.keys(seasonProjection).length} with a season projection)`);

  // --- Every week: projections, actuals, lineups -----------------------------
  const applied: SnapshotApplied = { generatedAt, actual: {}, projected: {}, teamScores: {} };
  const weekFiles: SnapshotWeek[] = [];

  for (let week = 1; week <= finalWeek; week++) {
    const payload = await espnFetch<{ players: PlayerEnvelope[] }>(
      leagueUrl({ season: SEASON, leagueId: LEAGUE_ID, views: ['kona_player_info'], scoringPeriodId: week }),
      creds,
      { filter: PLAYER_FILTER },
    );

    const projections: Record<string, StatLine> = {};
    const actuals: Record<string, StatLine> = {};
    const teamsThisWeek: Record<string, string> = {};
    const appliedActual: Record<string, number> = {};
    const appliedProjected: Record<string, number> = {};

    for (const { player } of payload.players ?? []) {
      if (ESPN_POSITION_IDS[player.defaultPositionId ?? -1] === undefined) continue;
      const pid = String(player.id);

      const proj = selectStats(player.stats, { season: SEASON, source: 1, split: 1, week });
      if (proj) {
        const line = compact(statLineOf(proj), groupOf(player));
        if (Object.keys(line).length > 0) {
          projections[pid] = line;
          if (typeof proj.appliedTotal === 'number') appliedProjected[pid] = proj.appliedTotal;
        }
      }

      /*
       * An empty actual line is kept, not dropped. ESPN writes a game-log entry
       * for every game a player's team played, so an empty one says the game
       * happened and he recorded nothing — a real zero, which is most of what a
       * floor is. A missing line means the game has not been played.
       */
      const act = selectStats(player.stats, { season: SEASON, source: 0, split: 1, week });
      if (act) {
        actuals[pid] = compact(statLineOf(act), groupOf(player));
        if (typeof act.appliedTotal === 'number') appliedActual[pid] = act.appliedTotal;
        const team = act.proTeamId ? PRO_TEAMS[act.proTeamId] : undefined;
        if (team) teamsThisWeek[pid] = team;
      }
    }

    /*
     * The lineup each team actually fielded that week.
     *
     * The roster on the team record is *today's* lineup, and using it to answer
     * "who did you start in week 3" would rewrite history every time someone
     * moved a player. `mBoxscore` records the real thing per week. It is only
     * asked for weeks that have started — and never before the draft, when it
     * returns the roster ESPN *would* auto-draft, indistinguishable in shape
     * from a real one.
     */
    const lineups: Record<string, Record<string, string>> = {};
    const teamScores: Record<string, number> = {};
    if (drafted && week <= currentWeek) {
      const box = await espnFetch<any>(
        leagueUrl({ season: SEASON, leagueId: LEAGUE_ID, views: ['mBoxscore', 'mMatchupScore'], scoringPeriodId: week }),
        creds,
      );
      for (const matchup of box.schedule ?? []) {
        if (matchup.matchupPeriodId !== week) continue;
        for (const side of [matchup.home, matchup.away]) {
          if (!side?.teamId) continue;
          const roster = side.rosterForCurrentScoringPeriod ?? side.rosterForMatchupPeriod;
          const slots: Record<string, string> = {};
          for (const entry of roster?.entries ?? []) {
            slots[String(entry.playerId)] = LINEUP_SLOTS[entry.lineupSlotId] ?? String(entry.lineupSlotId);
          }
          if (Object.keys(slots).length > 0) lineups[String(side.teamId)] = slots;
          const total = side.totalPointsLive ?? side.totalPoints;
          if (typeof total === 'number') teamScores[String(side.teamId)] = total;
        }
      }
    }

    applied.actual[String(week)] = appliedActual;
    applied.projected[String(week)] = appliedProjected;
    applied.teamScores[String(week)] = teamScores;
    weekFiles.push({
      version: SNAPSHOT_VERSION,
      generatedAt,
      week,
      projections,
      actuals,
      teams: teamsThisWeek,
      lineups,
    });
    process.stdout.write(
      `\r  week ${week}: ${Object.keys(projections).length} projected, ` +
        `${Object.keys(actuals).length} logged, ${Object.keys(lineups).length} lineups   `,
    );
  }
  process.stdout.write('\n');

  // --- The finished season, week by week, with its projections --------------
  /*
   * Why the prior season ships at all: the forecast model fits the spread of
   * real results around a projection, and on a Tuesday in week one there are no
   * pairs from this season to fit. ESPN's standard-scoring template league,
   * `leaguedefaults/3`, returns every player's weekly game logs *and the weekly
   * projections that preceded them* for any finished season. The raw stat lines
   * are league-independent, so they are scored locally under this league's own
   * table — nothing reads `appliedTotal` from that endpoint, which is computed
   * under ESPN's defaults, not this league's.
   *
   * Only player-weeks the fit can use are kept: a projection worth a point or
   * more (below that ESPN is listing a player not expected to play), paired
   * with whatever happened, plus every week a player actually played so a
   * prior-season rate can be measured.
   */
  let prior: SnapshotPrior | null = null;
  try {
    const payload = await espnFetch<{ players: PlayerEnvelope[] }>(
      `${ESPN_HOST}/apis/v3/games/ffl/seasons/${PRIOR_SEASON}/segments/0/leaguedefaults/3?view=kona_player_info`,
      creds,
      { filter: { players: { limit: 2000, sortPercOwned: { sortAsc: false, sortPriority: 1 } } } },
    );
    const positionsPrior: Record<string, PositionGroup> = {};
    const weeks: SnapshotPrior['weeks'] = {};
    let pairs = 0;

    for (const { player } of payload.players ?? []) {
      const group = ESPN_POSITION_IDS[player.defaultPositionId ?? -1];
      if (!group) continue;
      const pid = String(player.id);
      let kept = false;

      const projByWeek = new Map<number, StatLine>();
      const actByWeek = new Map<number, { line: StatLine; team?: string }>();
      for (const block of player.stats ?? []) {
        if (block.seasonId !== PRIOR_SEASON || block.statSplitTypeId !== 1) continue;
        const line = compact(statLineOf(block), group);
        if (block.statSourceId === 1) projByWeek.set(block.scoringPeriodId, line);
        else if (block.statSourceId === 0) {
          actByWeek.set(block.scoringPeriodId, {
            line,
            team: block.proTeamId ? PRO_TEAMS[block.proTeamId] : undefined,
          });
        }
      }

      for (let week = 1; week <= 18; week++) {
        const proj = projByWeek.get(week);
        const act = actByWeek.get(week);
        const projected = proj ? scoreStatLine(model, proj) >= 1 : false;
        const played = act ? (act.line.gp ?? 0) > 0 : false;
        if (!projected && !played) continue;

        const bucket = (weeks[String(week)] ??= { projections: {}, actuals: {}, teams: {} });
        if (projected && proj) bucket.projections[pid] = proj;
        if (act) {
          bucket.actuals[pid] = act.line;
          if (act.team) bucket.teams[pid] = act.team;
        }
        if (projected && played) pairs++;
        kept = true;
      }
      if (kept) positionsPrior[pid] = group;
    }

    prior = {
      version: SNAPSHOT_VERSION,
      generatedAt,
      season: String(PRIOR_SEASON),
      positions: positionsPrior,
      weeks,
    };
    log(`  ${PRIOR_SEASON}: ${Object.keys(positionsPrior).length} players, ${pairs} projection pairs`);
  } catch (err) {
    log(`  ${PRIOR_SEASON}: unavailable (${err instanceof Error ? err.message : String(err)})`);
  }

  // --- Draft -------------------------------------------------------------------
  // Placeholder picks — an undrafted board's future slots — carry ids of -1.
  const draft = (raw.draftDetail?.picks ?? [])
    .filter((p: any) => Number(p.playerId) > 0 && Number(p.teamId) > 0)
    .map((p: any) => ({
      pickNumber: p.overallPickNumber,
      round: p.roundId,
      roundPick: p.roundPickNumber,
      teamId: p.teamId,
      playerId: String(p.playerId),
      bidAmount: p.bidAmount ?? 0,
      keeper: Boolean(p.keeper),
    }));

  // --- Write -----------------------------------------------------------------
  await mkdir(OUT, { recursive: true });
  await mkdir(META, { recursive: true });
  // Stale week files from a longer season must not survive a rewrite.
  await rm(join(OUT, 'weeks'), { recursive: true, force: true });
  await mkdir(join(OUT, 'weeks'), { recursive: true });

  let bytes = 0;
  const write = async (path: string, value: unknown, label?: string) => {
    const text = JSON.stringify(value);
    bytes += text.length;
    await writeFile(path, text);
    if (label) log(`  wrote ${label} (${(text.length / 1024).toFixed(0)}KB)`);
  };

  const leagueFile: SnapshotLeague = {
    version: SNAPSHOT_VERSION,
    generatedAt,
    league: {
      leagueId: LEAGUE_ID,
      name: settings.name ?? config.name,
      season: String(SEASON),
      size: Number(settings.size ?? teams.length),
      rosterPositions: positions,
      scoringSettings: scoring,
      scoringBase: base,
      scoringOverrides: overrides,
      receptionPoints,
      regularSeasonWeeks,
      playoffTeams: Number(scheduleSettings.playoffTeamCount ?? 4),
      playoffWeekStart: regularSeasonWeeks + 1,
      playoffRoundLength: Number(scheduleSettings.playoffMatchupPeriodLength ?? 1),
      playoffSeedingRule: scheduleSettings.playoffSeedingRule ?? 'TOTAL_POINTS_SCORED',
      finalWeek,
      draftType: settings.draftSettings?.type ?? 'SNAKE',
      drafted,
      status: !drafted ? 'pre_draft' : seasonOver ? 'complete' : 'in_season',
    },
    teams,
    schedule,
    proGames,
    byeWeeks,
    draft,
  };
  await write(join(OUT, 'league.json'), leagueFile, 'league.json');

  const playersFile: SnapshotPlayers = {
    version: SNAPSHOT_VERSION,
    generatedAt,
    players,
    seasonProjection,
  };
  await write(join(OUT, 'players.json'), playersFile, 'players.json');

  let weekBytes = 0;
  for (const file of weekFiles) {
    const text = JSON.stringify(file);
    weekBytes += text.length;
    bytes += text.length;
    await writeFile(join(OUT, 'weeks', `${file.week}.json`), text);
  }
  log(`  wrote weeks/1-${finalWeek}.json (${(weekBytes / 1024).toFixed(0)}KB total)`);

  if (prior) await write(join(OUT, 'prior.json'), prior, 'prior.json');

  const index: SnapshotIndex = {
    version: SNAPSHOT_VERSION,
    generatedAt,
    leagueKey: config.key,
    leagueId: LEAGUE_ID,
    leagueName: settings.name ?? config.name,
    season: String(SEASON),
    priorSeason: prior ? String(PRIOR_SEASON) : null,
    currentWeek,
    latestCompletedWeek,
    finalWeek,
    weeks: weekFiles.map((f) => f.week),
  };
  // Written last, so a reader that sees the new stamp can trust every file under it.
  await write(join(OUT, 'index.json'), index, 'index.json');
  await write(join(META, 'applied.json'), applied);

  log(`  done: ${(bytes / 1024 / 1024).toFixed(2)}MB`);
}

/**
 * Pulls every requested league in turn.
 *
 * Sequential rather than parallel, deliberately: ESPN rate-limits hard on a
 * Sunday, and two leagues pulling a few dozen requests at once is the reliable
 * way to turn a slow refresh into a failed one.
 */
async function main(): Promise<void> {
  await loadDotEnv();
  const leagues = requestedLeagues();
  const failed: string[] = [];

  for (const league of leagues) {
    try {
      await pullLeague(league, credentials(league));
    } catch (err: unknown) {
      failed.push(league.key);
      process.stderr.write(`${league.key}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (failed.length > 0) {
    throw new Error(`${failed.join(', ')} failed; ${leagues.length - failed.length} succeeded`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

