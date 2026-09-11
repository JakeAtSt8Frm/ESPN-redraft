/**
 * Application shell: header controls on every screen, plus navigation that
 * adapts to the viewport — a horizontal tab strip on desktop, a fixed bottom
 * tab bar on phones (thumb-reachable, matching platform convention on iOS).
 */

import { Suspense, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLeague } from '../data/LeagueProvider';
import { LEAGUES } from '../lib/leagues';
import { ErrorBoundary } from './ErrorBoundary';
import { Spinner } from './primitives';
import { SettingsMenu } from './SettingsMenu';
import { useHideOnScroll } from './useHideOnScroll';

interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: string;
  /** Starts fetching the route's chunk before the reader commits to the tap. */
  prefetch: () => Promise<unknown>;
}

const NAV: NavItem[] = [
  { to: '/teams', label: 'Teams', short: 'Teams', icon: '▣', prefetch: () => import('../pages/Teams') },
  { to: '/matchups', label: 'Matchups', short: 'H2H', icon: '⇄', prefetch: () => import('../pages/Matchups') },
  { to: '/optimal', label: 'Optimal Lineup', short: 'Optimal', icon: '✦', prefetch: () => import('../pages/Optimal') },
  { to: '/history', label: 'History', short: 'History', icon: '◷', prefetch: () => import('../pages/History') },
  { to: '/players', label: 'Available Players', short: 'Players', icon: '⌕', prefetch: () => import('../pages/Players') },
  { to: '/schedule', label: 'Schedule', short: 'Schedule', icon: '▦', prefetch: () => import('../pages/Schedule') },
  { to: '/analytics', label: 'Analytics', short: 'Stats', icon: '◨', prefetch: () => import('../pages/Analytics') },
];

/*
 * Routes are code-split (see App.tsx), so the chunk for a page is not on the
 * device until it is visited. Warming it on hover or keyboard focus hides that
 * fetch behind the reader's own reaction time — by the time the tap lands the
 * module is usually parsed. Failure is deliberately ignored: this is an
 * optimisation, and the real navigation will surface any problem itself.
 */
function warm(item: NavItem) {
  void item.prefetch().catch(() => {});
}

/** "PPR", "Half-PPR" or "Standard", from the league's own points per reception. */
function formatLabel(receptionPoints: number): string {
  if (receptionPoints >= 1) return receptionPoints === 1 ? 'PPR' : `${receptionPoints} PPR`;
  if (receptionPoints === 0.5) return 'Half-PPR';
  if (receptionPoints > 0) return `${receptionPoints} PPR`;
  return 'Standard';
}

export function AppShell() {
  const {
    status,
    data,
    error,
    progress,
    leagueKey,
    setLeagueKey,
    week,
    setWeek,
    refresh,
  } = useLeague();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const headerHidden = useHideOnScroll();
  const location = useLocation();

  const weekCount = data ? Math.max(data.maxWeek, week) : 0;
  const weeks = Array.from({ length: weekCount }, (_, i) => i + 1);

  return (
    <div className="app">
      {/* Seven tab stops separate a keyboard or switch user from the content on
          every single navigation. This is the standard escape hatch: hidden
          until focused, first in the tab order.

          The jump is done in JS rather than left to the `#main` href, because
          this app routes on the hash — letting the fragment navigation through
          would hand "main" to the router as a route and move focus nowhere. The
          href stays so the control is a real link to assistive technology. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          const main = document.getElementById('main');
          main?.focus();
          main?.scrollIntoView();
        }}
      >
        Skip to content
      </a>

      {/* The settings panel hangs off the header, so letting the header slide
          away on scroll would take an open panel with it. */}
      <header className={`topbar${headerHidden && !settingsOpen ? ' is-hidden' : ''}`}>
        <div className="topbar__inner">
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <span className="brand" title="Redraft league analytics">RD</span>
            <span className="topbar__league">
              {data ? data.league.name : 'Loading…'}
              {data && (
                <span className="topbar__format">
                  {formatLabel(data.receptionPoints)} · {data.season}
                </span>
              )}
            </span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <label className="sr-only" htmlFor="league-select">
              League
            </label>
            <select
              id="league-select"
              className="select"
              value={leagueKey}
              onChange={(e) => setLeagueKey(e.target.value)}
            >
              {LEAGUES.map((league) => (
                <option key={league.key} value={league.key}>
                  {league.name}
                </option>
              ))}
            </select>

            {weeks.length > 0 && (
              <>
                <label className="sr-only" htmlFor="week-select">
                  Week
                </label>
                <select
                  id="week-select"
                  className="select"
                  value={week}
                  onChange={(e) => setWeek(Number(e.target.value))}
                >
                  {weeks.map((w) => (
                    <option key={w} value={w}>
                      Week {w}
                    </option>
                  ))}
                </select>
              </>
            )}

            <button
              className="btn btn-ghost btn-sm topbar__icon topbar__icon--refresh"
              onClick={refresh}
              aria-label="Refresh data"
              title="Clear cache and load the latest published snapshot"
            >
              ⟳
            </button>

            <div className="topbar__settings">
              <button
                className="btn btn-ghost btn-sm topbar__icon"
                onClick={() => setSettingsOpen((v) => !v)}
                aria-label="League details"
                aria-expanded={settingsOpen}
                title="League details"
              >
                ⚙
              </button>
              <SettingsMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </div>
          </div>
        </div>

        <nav className="tabs" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `tabs__link${isActive ? ' is-active' : ''}`}
              onMouseEnter={() => warm(item)}
              onFocus={() => warm(item)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* tabIndex lets the skip link move focus here, not just the scroll
          position — otherwise the next Tab returns to the top of the header. */}
      <main className="page" id="main" tabIndex={-1}>
        {status === 'loading' && (
          <div style={{ paddingTop: 48 }}>
            <Spinner label={progress ? `${progress.phase}…` : 'Loading league…'} />
            {progress && progress.total > 1 && (
              <div className="progress" role="progressbar" aria-valuenow={progress.loaded} aria-valuemin={0} aria-valuemax={progress.total}>
                <span style={{ width: `${(progress.loaded / progress.total) * 100}%` }} />
              </div>
            )}
            <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
              First load pulls the whole season's snapshot. It's cached after this.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="card card-pad" style={{ marginTop: 32 }}>
            <h2 className="bold">Couldn't load the league</h2>
            <p className="small muted" style={{ marginTop: 6 }}>
              {error}
            </p>
            <button className="btn" style={{ marginTop: 12 }} onClick={refresh}>
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && data && data.league.status === 'pre_draft' && (
          <div className="card card-pad" style={{ marginTop: 32 }}>
            <h2 className="bold">{data.league.name} hasn't drafted yet</h2>
            <p className="small muted" style={{ marginTop: 6 }}>
              Rosters, matchups and values fill in once the draft is done and the next
              snapshot is published.
            </p>
          </div>
        )}

        {status === 'ready' && data && data.league.status !== 'pre_draft' && (
          /* Scoped to the page: a page that throws leaves the header and tabs
             standing, so the reader can navigate out of it. The path resets the
             boundary, which is what makes that recovery work. */
          <ErrorBoundary resetKey={location.pathname} scope="This page">
            <Suspense fallback={<Spinner label="Loading page…" />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `bottom-nav__link${isActive ? ' is-active' : ''}`}
            onTouchStart={() => warm(item)}
            onMouseEnter={() => warm(item)}
            onFocus={() => warm(item)}
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="bottom-nav__label">{item.short}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
