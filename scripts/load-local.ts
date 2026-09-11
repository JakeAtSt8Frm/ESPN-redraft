/**
 * Runs the browser's league loader in Node, against the snapshot on disk.
 *
 * The loader fetches `./data/<league>/...` relative to the page. Here there is
 * no page, so `fetch` is wrapped: those relative URLs are answered from
 * `public/data`, and everything else (the FantasyCalc market) goes to the
 * network unless `MARKET=off`, which makes a run fully offline and repeatable.
 * IndexedDB doesn't exist in Node, and the cache already treats that as "no
 * cache", so nothing else needs faking.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadLeague, type LeagueData } from '../src/data/league';
import { ROOT } from './league-paths';

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('./data/')) {
    const path = join(ROOT, 'public', decodeURIComponent(url.slice(2).split('?')[0]));
    try {
      return new Response(await readFile(path, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }
  if (process.env.MARKET === 'off') return new Response('offline', { status: 503 });
  return realFetch(input, init);
}) as typeof fetch;

export async function loadLocal(leagueKey: string): Promise<LeagueData> {
  return loadLeague(leagueKey);
}
