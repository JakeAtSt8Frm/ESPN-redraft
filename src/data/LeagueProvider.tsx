import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { loadLeague, type LeagueData, type LoadProgress } from './league';
import { cacheClear } from './cache';
import { useSnapshotRefresh, type RefreshStatus } from './refresh';
import { DEFAULT_LEAGUE_KEY, findLeague } from '../lib/leagues';
import { readToken, writeToken } from '../lib/publishing';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface LeagueContextValue {
  status: Status;
  data: LeagueData | null;
  error: string | null;
  progress: LoadProgress | null;
  /** Which league is shown — a key from `lib/leagues.ts`. */
  leagueKey: string;
  setLeagueKey: (key: string) => void;
  /** Week the user is currently viewing. */
  week: number;
  setWeek: (week: number) => void;
  /** Roster the user has selected, defaults to the first team. */
  selectedRosterId: number | null;
  setSelectedRosterId: (id: number) => void;
  /** The header control: pull fresh data, or say why there is none. See `refresh.ts`. */
  refresh: () => void;
  refreshStatus: RefreshStatus | null;
  dismissRefreshStatus: () => void;
  /** After a failed load: drop every cached payload and load from scratch. */
  retry: () => void;
  /** Whether this device holds a GitHub token that lets refresh start a pull. */
  canStartPull: boolean;
  setGithubToken: (token: string | null) => void;
}

const LeagueContext = createContext<LeagueContextValue | null>(null);

const LEAGUE_KEY = 'espn-redraft.league';
/** Per league, so switching back lands on the team you were looking at. */
const ROSTER_KEY = (league: string) => `espn-redraft.team.${league}`;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

function initialLeague(): string {
  // A shared link can name the league: ?league=oj-invitational.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('league');
    if (findLeague(fromUrl)) return fromUrl!;
  } catch {
    /* no window in tests */
  }
  const saved = readStorage(LEAGUE_KEY);
  return findLeague(saved) ? saved! : DEFAULT_LEAGUE_KEY;
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const [leagueKey, setLeagueKeyState] = useState(initialLeague);
  const [status, setStatus] = useState<Status>('idle');
  const [data, setData] = useState<LeagueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [week, setWeek] = useState(1);
  const [selectedRosterId, setSelectedRosterIdState] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus('loading');
    setError(null);
    setProgress(null);

    loadLeague(
      leagueKey,
      (p) => {
        if (!cancelled) setProgress(p);
      },
      controller.signal,
    )
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setWeek(result.currentWeek);
        const saved = Number(readStorage(ROSTER_KEY(leagueKey)));
        setSelectedRosterIdState(
          result.teamsById.has(saved) ? saved : (result.teams[0]?.rosterId ?? null),
        );
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load league data');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [leagueKey, reloadToken]);

  const setLeagueKey = useCallback((next: string) => {
    if (!findLeague(next)) return;
    setLeagueKeyState(next);
    writeStorage(LEAGUE_KEY, next);
    // A `?league=` from a shared link would otherwise win again on reload.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('league')) {
        url.searchParams.set('league', next);
        window.history.replaceState(window.history.state, '', url);
      }
    } catch {
      /* no window in tests */
    }
  }, []);

  const setSelectedRosterId = useCallback(
    (id: number) => {
      setSelectedRosterIdState(id);
      writeStorage(ROSTER_KEY(leagueKey), String(id));
    },
    [leagueKey],
  );

  const retry = useCallback(() => {
    void cacheClear().then(() => setReloadToken((n) => n + 1));
  }, []);

  // The league on screen, for a refresh that outlives renders.
  const shown = useRef<LeagueData | null>(null);
  useEffect(() => {
    shown.current = status === 'ready' && data?.leagueKey === leagueKey ? data : null;
  }, [status, data, leagueKey]);
  const current = useCallback(() => shown.current, []);

  /** A newer snapshot of the league on screen, swapped in without a loading screen. */
  const adopt = useCallback((next: LeagueData) => {
    const prev = shown.current;
    if (!prev || prev.leagueKey !== next.leagueKey) return;
    shown.current = next;
    setData(next);
    // Someone on the live week follows it when it moves on; someone looking back stays put.
    setWeek((w) => (w === prev.currentWeek ? next.currentWeek : Math.min(w, next.maxWeek)));
    setSelectedRosterIdState((id) =>
      id !== null && next.teamsById.has(id) ? id : (next.teams[0]?.rosterId ?? null),
    );
  }, []);

  const [githubToken, setGithubTokenState] = useState(readToken);
  const setGithubToken = useCallback((token: string | null) => {
    writeToken(token);
    setGithubTokenState(token);
  }, []);

  const {
    status: refreshStatus,
    refresh,
    dismiss: dismissRefreshStatus,
  } = useSnapshotRefresh({ token: githubToken, current, adopt });

  const value = useMemo<LeagueContextValue>(
    () => ({
      status,
      data,
      error,
      progress,
      leagueKey,
      setLeagueKey,
      week,
      setWeek,
      selectedRosterId,
      setSelectedRosterId,
      refresh,
      refreshStatus,
      dismissRefreshStatus,
      retry,
      canStartPull: githubToken !== null,
      setGithubToken,
    }),
    [
      status,
      data,
      error,
      progress,
      leagueKey,
      setLeagueKey,
      week,
      selectedRosterId,
      setSelectedRosterId,
      refresh,
      refreshStatus,
      dismissRefreshStatus,
      retry,
      githubToken,
      setGithubToken,
    ],
  );

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague(): LeagueContextValue {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error('useLeague must be used inside a LeagueProvider');
  return ctx;
}

/**
 * Convenience hook for pages that only render once data is ready.
 * Throws if called before load completes, so callers can rely on non-null data.
 */
export function useLeagueData(): LeagueData {
  const { data } = useLeague();
  if (!data) throw new Error('League data is not loaded yet');
  return data;
}
