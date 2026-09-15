/**
 * The header's refresh control: fresh data, or the reason there isn't any.
 *
 * With a GitHub token on this device it starts the Deploy workflow — the only
 * thing that can pull ESPN — follows the run, and swaps the new snapshot in
 * once it is published, about two minutes later. Without one it loads the
 * newest published snapshot and, when that is no newer than the one on screen,
 * reads the workflow's last run to say why: a run still going, a run that
 * failed and at which step, or a run that finished without pulling anything.
 *
 * It used to clear the cache and re-read the same files. Those were already in
 * the HTTP cache, so it finished instantly and visibly did nothing — and it did
 * that most of all when the publishing side had stopped, which is exactly when
 * someone presses it.
 *
 * Loads happen behind the page already showing, which stays until the new
 * league data is ready.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadLeague, type LeagueData } from './league';
import { getIndex } from './snapshot';
import {
  dispatchPull,
  getRun,
  latestRun,
  PUBLISHER,
  PublisherError,
  runSteps,
  type PullRun,
} from '../lib/publishing';
import { timeAgo } from '../lib/time';

export type RefreshTone = 'progress' | 'success' | 'info' | 'warning';

export interface RefreshStatus {
  tone: RefreshTone;
  message: string;
  /** The run on GitHub worth opening: the one going, or the one that failed. */
  runUrl?: string;
  /** When the pull started, for the elapsed-time readout. */
  since?: number;
}

/** A snapshot this old is worth calling out even when nothing failed. */
const STALE_AFTER = 3 * 60 * 60 * 1000;
/** A run takes about two minutes; one still going after this has stalled. */
const FOLLOW_LIMIT = 12 * 60 * 1000;
/** How long a finished run gets for its snapshot to appear before it counts as empty. */
const PUBLISH_LIMIT = 90 * 1000;

interface Context {
  signal: AbortSignal;
  token: string | null;
  /** The league on screen, read afresh at every step: the reader can switch mid-pull. */
  current: () => LeagueData | null;
  adopt: (data: LeagueData) => void;
  report: (status: RefreshStatus) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Loads the published snapshot when it's newer than the one on screen. */
async function loadIfNewer(ctx: Context): Promise<{ updated: boolean; stamp: number }> {
  const shown = ctx.current();
  if (!shown) return { updated: false, stamp: 0 };
  const index = await getIndex(shown.leagueKey, ctx.signal);
  if (index.generatedAt <= shown.generatedAt) return { updated: false, stamp: shown.generatedAt };
  const next = await loadLeague(shown.leagueKey, undefined, ctx.signal);
  ctx.adopt(next);
  return { updated: true, stamp: next.generatedAt };
}

const updated = (stamp: number): RefreshStatus => ({
  tone: 'success',
  message: `Updated — ESPN snapshot from ${timeAgo(stamp)}.`,
});

function failedAt(run: PullRun, step: string | null): string {
  if (run.conclusion === 'cancelled') return 'was cancelled';
  return step ? `failed at “${step}”` : 'failed';
}

async function failedStep(ctx: Context, run: PullRun): Promise<string | null> {
  return (await runSteps(run.id, ctx.token, ctx.signal).catch(() => null))?.failed ?? null;
}

const pulledNothing = (run: PullRun, stamp: number): RefreshStatus => ({
  tone: 'warning',
  message:
    `GitHub's run from ${timeAgo(run.startedAt)} finished without new ESPN data — usually an ` +
    `expired ESPN cookie. This snapshot is from ${timeAgo(stamp)}.`,
  runUrl: run.htmlUrl,
});

/** After a green run: wait for its snapshot to be served, or conclude it pulled nothing. */
async function awaitPublished(ctx: Context, run: PullRun, since?: number): Promise<RefreshStatus> {
  const giveUp = Date.now() + PUBLISH_LIMIT;
  ctx.report({ tone: 'progress', message: 'Loading the new snapshot', since, runUrl: run.htmlUrl });
  for (;;) {
    const { stamp } = await loadIfNewer(ctx);
    if (stamp >= run.startedAt) return updated(stamp);
    if (Date.now() > giveUp) return pulledNothing(run, stamp);
    await sleep(5000, ctx.signal);
  }
}

/** Follows a run to the end, then loads what it published. */
async function follow(
  ctx: Context,
  runId: number,
  since: number,
  giveUp = Date.now() + FOLLOW_LIMIT,
): Promise<RefreshStatus> {
  let run = await getRun(runId, ctx.token, ctx.signal);
  while (run.status !== 'completed') {
    if (Date.now() > giveUp) {
      return { tone: 'warning', message: 'Still waiting on GitHub after 12 minutes.', runUrl: run.htmlUrl };
    }
    // Steps cost a second request, which an unauthenticated reader's hourly
    // allowance of 60 can't spare on every poll.
    const step = ctx.token ? (await runSteps(runId, ctx.token, ctx.signal).catch(() => null))?.current : null;
    ctx.report({
      tone: 'progress',
      message:
        run.status === 'in_progress'
          ? `Pulling from ESPN${step ? ` · ${step}` : ''}`
          : 'Waiting for GitHub to start the pull',
      since,
      runUrl: run.htmlUrl,
    });
    await sleep(ctx.token ? 8000 : 20000, ctx.signal);
    run = await getRun(runId, ctx.token, ctx.signal);
  }

  if (run.conclusion === 'cancelled') {
    // Deploys share one concurrency group, and a run queued behind a running
    // one is cancelled when another queues behind it. The newer run is the
    // same pull, later.
    const newest = await latestRun(ctx.token, ctx.signal).catch(() => null);
    if (newest && newest.id !== run.id && newest.status !== 'completed') {
      return follow(ctx, newest.id, since, giveUp);
    }
  }
  if (run.conclusion !== 'success') {
    const shown = ctx.current();
    return {
      tone: 'warning',
      message:
        `The pull ${failedAt(run, await failedStep(ctx, run))}.` +
        (shown ? ` The site still has the snapshot from ${timeAgo(shown.generatedAt)}.` : ''),
      runUrl: run.htmlUrl,
    };
  }
  return awaitPublished(ctx, run, since);
}

/** With a token: start a pull and see it through. */
async function pull(ctx: Context, token: string): Promise<RefreshStatus> {
  const since = Date.now();
  ctx.report({ tone: 'progress', message: 'Starting a pull from ESPN', since });
  const runId = (await dispatchPull(token, ctx.signal)) ?? (await findRun(ctx, since));
  return follow(ctx, runId, since);
}

/** The run a dispatch started, when GitHub didn't say which: the first one created after it. */
async function findRun(ctx: Context, after: number): Promise<number> {
  const giveUp = Date.now() + 60_000;
  for (;;) {
    const run = await latestRun(ctx.token, ctx.signal);
    // Allow for this device's clock running ahead of GitHub's.
    if (run && run.createdAt >= after - 10_000) return run.id;
    if (Date.now() > giveUp) throw new Error('GitHub accepted the pull but no run started.');
    await sleep(3000, ctx.signal);
  }
}

/** Without a token: load what's published, and explain it when that's nothing new. */
async function check(ctx: Context): Promise<RefreshStatus | null> {
  ctx.report({ tone: 'progress', message: 'Checking for a newer snapshot' });
  const { updated: loaded, stamp } = await loadIfNewer(ctx);
  // Switched league meanwhile: that load read the newest index itself.
  if (!stamp) return null;
  // Unreachable or rate-limited, GitHub just can't say why.
  const run = await latestRun(null, ctx.signal).catch(() => null);

  if (run && run.status !== 'completed') {
    if (loaded) ctx.report(updated(stamp));
    return follow(ctx, run.id, run.startedAt);
  }
  if (loaded) return updated(stamp);

  const age = `This snapshot is from ${timeAgo(stamp)}.`;
  if (run && run.conclusion !== 'success') {
    return {
      tone: 'warning',
      message: `No newer data: GitHub's last pull, ${timeAgo(run.startedAt)}, ${failedAt(run, await failedStep(ctx, run))}. ${age}`,
      runUrl: run.htmlUrl,
    };
  }
  if (run && stamp < run.startedAt) {
    // Just finished, it may not be served yet; finished a while ago, it pulled nothing.
    return Date.now() < run.updatedAt + PUBLISH_LIMIT ? awaitPublished(ctx, run) : pulledNothing(run, stamp);
  }

  const stale = Date.now() - stamp > STALE_AFTER;
  return {
    tone: stale ? 'warning' : 'info',
    message:
      `${run ? "Up to date with GitHub's last pull." : 'No newer snapshot is published.'} ${age}` +
      (stale ? ' Add a GitHub token under League details (⚙) to pull from ESPN now.' : ''),
  };
}

function describe(err: unknown, token: string | null): string {
  if (err instanceof PublisherError) {
    if (err.status === 401) {
      return 'GitHub rejected the saved token — it may have expired. Replace it under League details (⚙).';
    }
    if (token && (err.status === 403 || err.status === 404)) {
      return `The saved token can't run ${PUBLISHER.repo}'s workflow: it needs Actions read and write on that repository.`;
    }
    if (err.status === 403 || err.status === 429) {
      return 'GitHub is rate-limiting this network. Try again in a few minutes.';
    }
    return `GitHub answered ${err.status}. Try again in a minute.`;
  }
  if (err instanceof TypeError) return "Couldn't connect. Check the connection and try again.";
  return err instanceof Error ? err.message : 'Refresh failed.';
}

export function useSnapshotRefresh(options: {
  token: string | null;
  current: () => LeagueData | null;
  adopt: (data: LeagueData) => void;
}) {
  const { token, current, adopt } = options;
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const running = useRef<AbortController | null>(null);

  useEffect(() => () => running.current?.abort(), []);

  // Good news clears itself; a warning waits to be read.
  useEffect(() => {
    if (status?.tone !== 'success' && status?.tone !== 'info') return;
    const id = setTimeout(() => setStatus(null), 8000);
    return () => clearTimeout(id);
  }, [status]);

  const refresh = useCallback(() => {
    if (running.current || !current()) return;
    const controller = new AbortController();
    running.current = controller;
    const report = (next: RefreshStatus | null) => {
      if (!controller.signal.aborted) setStatus(next);
    };
    const ctx: Context = { signal: controller.signal, token, current, adopt, report };
    (token ? pull(ctx, token) : check(ctx))
      .then(report, (err: unknown) => report({ tone: 'warning', message: describe(err, token) }))
      .finally(() => {
        if (running.current === controller) running.current = null;
      });
  }, [token, current, adopt]);

  const dismiss = useCallback(() => setStatus(null), []);

  return { status, refresh, dismiss };
}
