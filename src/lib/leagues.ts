/**
 * The leagues this app can show, and the only place their ids live.
 *
 * Imported by both halves of the project. The Node scripts read it to know
 * what to pull and where to write it; the browser reads it to know what to
 * offer in the switcher and which directory to fetch from.
 *
 * There is no credential here and there never should be. Each league is read
 * with its own `ESPN_SWID_<KEY>` / `ESPN_S2_<KEY>` cookie pair (see
 * `credentialNames`), because the two leagues are reached through different
 * ESPN logins. ESPN authorises the account, not the league, so a pair only
 * needs to belong to an account that can see that league.
 */

export interface LeagueConfig {
  /**
   * Directory name under `public/data/`, and the value persisted in
   * localStorage. Stable forever once shipped: changing it silently orphans
   * every cached payload and every reader's saved choice.
   */
  key: string;
  /** Short label for the switcher. The full ESPN name is shown once loaded. */
  name: string;
  leagueId: string;
}

/**
 * Order matters: the first entry is what a first-time visitor opens on, and
 * what every Node script defaults to when no league is named.
 */
export const LEAGUES: readonly LeagueConfig[] = [
  { key: 'uk-bg', name: 'UK-BG', leagueId: '390483100' },
  { key: 'oj-invitational', name: 'O.J. Invitational', leagueId: '1159035309' },
] as const;

export const DEFAULT_LEAGUE_KEY = LEAGUES[0].key;

/**
 * Resolves a key to its league, or null.
 *
 * Null rather than a throw or a silent fallback because callers want different
 * things: the client falls back to the default when a saved key no longer
 * exists, and the scripts reject an unknown key outright.
 */
export function findLeague(key: string | null | undefined): LeagueConfig | null {
  if (!key) return null;
  return LEAGUES.find((league) => league.key === key) ?? null;
}

/** The named league, or the default. Never throws — used on the render path. */
export function leagueOrDefault(key: string | null | undefined): LeagueConfig {
  return findLeague(key) ?? LEAGUES[0];
}

/**
 * The environment variable names holding a league's cookie pair.
 *
 * `uk-bg` reads `ESPN_SWID_UK_BG` and `ESPN_S2_UK_BG`. A bare `ESPN_SWID` /
 * `ESPN_S2` pair is the fallback for a league without its own, which is what a
 * single-account setup would use.
 */
export function credentialNames(league: LeagueConfig): { swid: string; s2: string } {
  const suffix = league.key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return { swid: `ESPN_SWID_${suffix}`, s2: `ESPN_S2_${suffix}` };
}
