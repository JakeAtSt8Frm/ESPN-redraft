import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadLeague, type LeagueData, type LoadProgress } from './league';
import { cacheClear } from './cache';
import { DEFAULT_LEAGUE_KEY, findLeague } from '../lib/leagues';

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
  refresh: () => void;
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

  const refresh = useCallback(() => {
    void cacheClear().then(() => setReloadToken((n) => n + 1));
  }, []);

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
