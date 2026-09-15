/**
 * The GitHub Actions workflow that publishes the snapshot, as the page sees it.
 *
 * The browser can't pull ESPN (see `data/snapshot.ts`), but it can ask GitHub
 * to: the Deploy workflow is the only thing that does, and it runs on a schedule
 * GitHub treats as best-effort. Reading that workflow's runs needs nothing — the
 * repository is public — which is how the refresh control can say *why* a
 * snapshot is old instead of silently re-reading the same one. Starting a run
 * needs a fine-grained token allowed to write Actions on this repository. A
 * reader pastes one into League details on their own device; it is kept in that
 * browser's storage and sent nowhere but api.github.com.
 */

export const PUBLISHER = {
  owner: 'JakeAtSt8Frm',
  repo: 'ESPN-redraft',
  workflow: 'deploy.yml',
  branch: 'main',
} as const;

const API = `https://api.github.com/repos/${PUBLISHER.owner}/${PUBLISHER.repo}/actions`;

/**
 * GitHub's new-token page, filled in: this account, Actions read and write, a
 * season long. Repository access can't be filled in by link, so the reader
 * still picks ESPN-redraft by hand.
 */
export const TOKEN_TEMPLATE_URL = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams(
  {
    name: 'ESPN-redraft refresh',
    description: 'Lets the ESPN-redraft page start its Deploy workflow (Actions: write).',
    target_name: PUBLISHER.owner,
    expires_in: '366',
    actions: 'write',
  },
)}`;

export interface PullRun {
  id: number;
  /** queued, in_progress, completed — and GitHub's rarer waiting states. */
  status: string;
  /** success, failure, cancelled, … once completed; null before. */
  conclusion: string | null;
  createdAt: number;
  startedAt: number;
  /** Last change — for a completed run, when it finished. */
  updatedAt: number;
  htmlUrl: string;
}

export class PublisherError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PublisherError';
    this.status = status;
  }
}

interface RawRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  html_url: string;
}

interface RawJob {
  name: string;
  status: string;
  conclusion: string | null;
  steps?: Array<{ name: string; status: string; conclusion: string | null }>;
}

async function github<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) throw new PublisherError(`GitHub answered ${res.status}`, res.status);
  return res.status === 204 ? null : ((await res.json()) as T);
}

function toRun(raw: RawRun): PullRun {
  const createdAt = Date.parse(raw.created_at);
  return {
    id: raw.id,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt,
    startedAt: raw.run_started_at ? Date.parse(raw.run_started_at) : createdAt,
    updatedAt: Date.parse(raw.updated_at),
    htmlUrl: raw.html_url,
  };
}

/** The workflow's newest run on the publishing branch, or null before its first. */
export async function latestRun(token: string | null, signal?: AbortSignal): Promise<PullRun | null> {
  const body = await github<{ workflow_runs: RawRun[] }>(
    `/workflows/${PUBLISHER.workflow}/runs?branch=${PUBLISHER.branch}&per_page=1`,
    token,
    { signal },
  );
  const raw = body?.workflow_runs[0];
  return raw ? toRun(raw) : null;
}

export async function getRun(id: number, token: string | null, signal?: AbortSignal): Promise<PullRun> {
  const raw = await github<RawRun>(`/runs/${id}`, token, { signal });
  if (!raw) throw new PublisherError('GitHub returned no run', 204);
  return toRun(raw);
}

/**
 * The step a run is on, and the one it failed at. The ESPN pull is allowed to
 * fail without failing the run (one league's expired cookie mustn't stop the
 * other), so a green run is not proof that anything was pulled — the snapshot's
 * own stamp is.
 */
export async function runSteps(
  id: number,
  token: string | null,
  signal?: AbortSignal,
): Promise<{ current: string | null; failed: string | null }> {
  const body = await github<{ jobs: RawJob[] }>(`/runs/${id}/jobs`, token, { signal });
  let current: string | null = null;
  let failed: string | null = null;
  for (const job of body?.jobs ?? []) {
    for (const step of job.steps ?? []) {
      if (!current && step.status === 'in_progress') current = step.name;
      if (!failed && step.conclusion === 'failure') failed = step.name;
    }
    if (!failed && job.conclusion === 'failure') failed = job.name;
  }
  return { current, failed };
}

/**
 * Starts a pull. Resolves to the run it started when GitHub says which — it
 * does when asked for run details — and to null when it only acknowledges.
 */
export async function dispatchPull(token: string, signal?: AbortSignal): Promise<number | null> {
  const path = `/workflows/${PUBLISHER.workflow}/dispatches`;
  const send = (body: object) =>
    github<{ workflow_run_id?: number }>(path, token, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  try {
    return (await send({ ref: PUBLISHER.branch, return_run_details: true }))?.workflow_run_id ?? null;
  } catch (err) {
    // An API that predates run details rejects the field; the run still starts
    // without it and is found by time instead.
    if (!(err instanceof PublisherError) || err.status !== 422) throw err;
    await send({ ref: PUBLISHER.branch });
    return null;
  }
}

/**
 * Whether GitHub recognises a token at all. It can't prove the token may start
 * a run — any token can read a public repository — so a missing permission
 * only shows on the first pull.
 */
export async function checkToken(token: string, signal?: AbortSignal): Promise<void> {
  await github(`/workflows/${PUBLISHER.workflow}`, token, { signal });
}

const TOKEN_KEY = 'espn-redraft.github-token';

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — the provider still holds it for this visit */
  }
}
