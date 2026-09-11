/**
 * Which league a script run is about, and where its files live.
 *
 * Each league gets its own subtree and this module is the single place that
 * decides which one a given run is pointed at:
 *
 *   npm run snapshot                    # every league
 *   npm run snapshot -- --league uk-bg  # just that one
 *   ESPN_LEAGUE=uk-bg npm run verify    # the checks, one league
 *
 * The default is the first configured league rather than "all" for the
 * single-league scripts; `requestedLeagues()` is what the looping ones use.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLeague, LEAGUES, type LeagueConfig } from '../src/lib/leagues';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `--league <key>` or `--league=<key>` from argv, else `ESPN_LEAGUE`, else null. */
function requestedKey(): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--league' && argv[i + 1]) return argv[i + 1];
    const inline = /^--league=(.+)$/.exec(argv[i]);
    if (inline) return inline[1];
  }
  return process.env.ESPN_LEAGUE || null;
}

/**
 * Fails loudly on an unknown key instead of quietly doing the default league.
 * A typo that fell back to the default would check the wrong league and report
 * success.
 */
function resolve(key: string | null): LeagueConfig {
  if (!key) return LEAGUES[0];
  const league = findLeague(key);
  if (!league) {
    throw new Error(
      `Unknown league "${key}". Configured: ${LEAGUES.map((l) => l.key).join(', ')}.`,
    );
  }
  return league;
}

/** The league this run is about. */
export function activeLeague(): LeagueConfig {
  return resolve(requestedKey());
}

/** Every league to act on: the named one, or all of them. */
export function requestedLeagues(): LeagueConfig[] {
  const key = requestedKey();
  return key ? [resolve(key)] : [...LEAGUES];
}

/** `public/data/<key>` — what the browser fetches. */
export function dataDir(league: LeagueConfig): string {
  return join(ROOT, 'public', 'data', league.key);
}

/**
 * `snapshot-meta/<key>` — what only the Node checks read.
 *
 * ESPN's own applied totals live here rather than under `public/`, because
 * anything under `public/` is copied into the deployed bundle and nothing in the
 * browser ever reads them. They are committed so `npm run verify` can re-check
 * the scoring engine against the committed snapshot without credentials.
 */
export function metaDir(league: LeagueConfig): string {
  return join(ROOT, 'snapshot-meta', league.key);
}
