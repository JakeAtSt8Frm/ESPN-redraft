/**
 * Image URLs for players and NFL teams.
 *
 * ESPN's CDN is public and unauthenticated, so images are the one class of
 * request the browser still makes to espn.com — with no cookies and no league
 * data attached. Every caller has a fallback chain ending in "hide it", because
 * a broken image is worse than none.
 */

const CDN = 'https://a.espncdn.com/i';

/** A player's headshot. A D/ST has a negative id and no headshot: use the logo. */
export function playerHeadshot(playerId: string, team?: string | null): string {
  if (Number(playerId) < 0) return teamLogo(team);
  return `${CDN}/headshots/nfl/players/full/${playerId}.png`;
}

/** An NFL team's logo, by abbreviation. Empty string when there is none. */
export function teamLogo(team: string | null | undefined): string {
  if (!team || team === 'FA') return '';
  return `${CDN}/teamlogos/nfl/500/${team.toLowerCase()}.png`;
}
