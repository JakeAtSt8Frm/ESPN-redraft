/**
 * Reads the static snapshot `scripts/snapshot.ts` writes under `public/data`.
 *
 * The browser never talks to ESPN — it can't: these leagues are private and a
 * page on github.io cannot send espn.com cookies. It reads the JSON the snapshot
 * job published alongside the app, from the same origin, relative to the page so
 * it works from a project page, a user page or straight off disk.
 *
 * `index.json` is the one file fetched fresh every load. Everything else is
 * keyed by the index's `generatedAt` stamp, so a file is immutable under its
 * key and can be cached forever, and a new snapshot is picked up the moment the
 * index names it.
 */

import { cached, cacheGet, cachePrune, cacheSet, TTL } from './cache';
import {
  SNAPSHOT_VERSION,
  type SnapshotIndex,
  type SnapshotLeague,
  type SnapshotPlayers,
  type SnapshotPrior,
  type SnapshotWeek,
} from '../lib/snapshot-types';

export class SnapshotError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SnapshotError';
    this.status = status;
  }
}

const base = (leagueKey: string) => `./data/${encodeURIComponent(leagueKey)}`;

async function getJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new SnapshotError(`Could not load ${url} (${res.status})`, res.status);
  return (await res.json()) as T;
}

/**
 * The league's current index — fetched fresh on every load, so a snapshot
 * published a minute ago is seen now. Falls back to the last index this
 * browser saw when the network is down, so an installed app still opens.
 *
 * Fresh means past GitHub's CDN too, which may keep serving an index for ten
 * minutes (`max-age=600`) after a deploy replaces it. Revalidating only asks
 * that CDN copy whether it changed; a query it has never seen can't be
 * answered from its cache.
 */
export async function getIndex(leagueKey: string, signal?: AbortSignal): Promise<SnapshotIndex> {
  const cacheKey = `index:${leagueKey}`;
  try {
    const index = await getJson<SnapshotIndex>(`${base(leagueKey)}/index.json?t=${Date.now()}`, {
      signal,
      cache: 'no-store',
    });
    if (index.version !== SNAPSHOT_VERSION) {
      throw new SnapshotError(
        `This page is older than the published data (snapshot v${index.version}, page ` +
          `v${SNAPSHOT_VERSION}). Reload to pick up the new version.`,
      );
    }
    void cacheSet(cacheKey, index, TTL.INDEX);
    // One snapshot per league in the store: the previous stamp's files go.
    void cachePrune(`${leagueKey}:`, `:${index.generatedAt}:`);
    return index;
  } catch (err) {
    if (signal?.aborted || err instanceof SnapshotError) throw err;
    const saved = await cacheGet<SnapshotIndex>(cacheKey);
    if (saved) return saved;
    throw err;
  }
}

/** One file of the snapshot the index names, through the cache. */
function file<T>(leagueKey: string, index: SnapshotIndex, path: string, signal?: AbortSignal): Promise<T> {
  return cached(`${leagueKey}:${index.generatedAt}:${path}`, TTL.SNAPSHOT, () =>
    getJson<T>(`${base(leagueKey)}/${path}?v=${index.generatedAt}`, { signal }),
  );
}

export const getLeagueFile = (key: string, index: SnapshotIndex, signal?: AbortSignal) =>
  file<SnapshotLeague>(key, index, 'league.json', signal);

export const getPlayersFile = (key: string, index: SnapshotIndex, signal?: AbortSignal) =>
  file<SnapshotPlayers>(key, index, 'players.json', signal);

export const getWeekFile = (key: string, index: SnapshotIndex, week: number, signal?: AbortSignal) =>
  file<SnapshotWeek>(key, index, `weeks/${week}.json`, signal);

/** Last season's logs. Optional: a snapshot without them still loads. */
export const getPriorFile = (key: string, index: SnapshotIndex, signal?: AbortSignal) =>
  index.priorSeason
    ? file<SnapshotPrior>(key, index, 'prior.json', signal).catch((err) => {
        if (signal?.aborted) throw err;
        return null;
      })
    : Promise.resolve(null);
