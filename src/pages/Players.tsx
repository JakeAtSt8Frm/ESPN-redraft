/**
 * Players — searchable browser over everyone, rostered or free.
 *
 * Defaults to free agents because in redraft that's the actionable list — the
 * waiver wire — but the whole league is searchable.
 *
 * Value is a percentile within a position group, so it ranks kickers against
 * kickers and is the right sort once a position is chosen. Across positions it
 * can't be compared — the best kicker on waivers tops a small pool, not the
 * whole list — and the page says so when that view is open. "Rest of season"
 * is the plain alternative: ESPN's projected points for the weeks left, byes
 * and injuries included, which is the scale ESPN's own free-agent list uses.
 *
 * Points over replacement looks like the obvious cross-position sort and is the
 * wrong one here. Every free agent sits below his position's starter cliff, so
 * it ranks them by how *close* to startable they are — and the positions where
 * the whole pool is close are kicker and defence, whose waiver options are
 * nearly as good as the starters precisely because nobody needs a second one.
 */

import { useDeferredValue, useMemo, useState } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { enrichPlayer, rosterOwnerByPlayer } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState, fmt1 } from '../components/primitives';
import { timeAgo } from '../lib/time';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';
import { rosterStatus, ROSTER_LABELS, type NflRosterStatus } from '../lib/availability';

type Availability = 'free' | 'rostered' | 'all';
type SortKey = 'ros' | 'value' | 'ppg' | 'total' | 'last4' | 'trend';

const SORTS: Array<{ key: SortKey; label: string; title: string }> = [
  { key: 'value', label: 'Value', title: 'Headline Value Score — ranks within a position' },
  { key: 'ros', label: 'Rest of season', title: 'ESPN projected points for the weeks left, byes and injuries included' },
  { key: 'ppg', label: 'PPG', title: 'Points per game this season' },
  { key: 'total', label: 'Total', title: 'Points this season' },
  { key: 'last4', label: 'Last 4', title: 'Average of the last four games' },
  { key: 'trend', label: 'Trending', title: 'Change in ESPN rostered % this week' },
];

export function PlayersPage() {
  const data = useLeagueData();
  const [group, setGroup] = useState<PositionGroup | 'ALL'>('ALL');
  const [availability, setAvailability] = useState<Availability>('free');
  const [rosterId, setRosterId] = useState<number | 'ALL'>('ALL');
  const [sort, setSort] = useState<SortKey>('value');
  const [query, setQuery] = useState('');
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [nflStatus, setNflStatus] = useState<NflRosterStatus | 'all'>('all');

  // Keeps typing responsive while the list re-filters.
  const deferredQuery = useDeferredValue(query);

  const ownerByPid = useMemo(() => rosterOwnerByPlayer(data.teams), [data]);

  const results = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const rows: Array<{ pid: string; sortValue: number }> = [];

    for (const [pid, combinedScore] of data.combinedScores) {
      const player = data.playersById.get(pid);
      if (nflStatus !== 'all' && rosterStatus(player) !== nflStatus) continue;
      const value = data.valueIndex.byPlayer.get(pid) ?? null;
      const ros = data.rosIndex.byPlayer.get(pid) ?? null;
      const playerGroup = ros?.group ?? value?.group ?? null;
      if (!playerGroup || (group !== 'ALL' && playerGroup !== group)) continue;

      const owner = ownerByPid.get(pid) ?? null;
      const isOwned = owner !== null;
      if (availability === 'free' && isOwned) continue;
      if (availability === 'rostered' && !isOwned) continue;
      if (rosterId !== 'ALL' && owner?.rosterId !== rosterId) continue;

      if (needle) {
        const name = (
          player?.full_name ?? `${player?.first_name ?? ''} ${player?.last_name ?? ''}`
        ).toLowerCase();
        const team = (player?.team ?? '').toLowerCase();
        if (!name.includes(needle) && !team.includes(needle)) continue;
      }

      const sortValue =
        sort === 'ros'
          ? (ros?.breakdown.rosPoints ?? 0)
          : sort === 'value'
            ? combinedScore
            : sort === 'ppg'
              ? (value?.breakdown.ppg ?? ros?.breakdown.rosPpg ?? 0)
              : sort === 'total'
                ? (value?.breakdown.total ?? 0)
                : sort === 'last4'
                  ? (value?.breakdown.last4 ?? 0)
                  : (player?.percent_change ?? -1e6);

      rows.push({ pid, sortValue });
    }

    rows.sort((a, b) => b.sortValue - a.sortValue);
    // Cap the render — nobody scrolls past the first hundred and fifty.
    return rows.slice(0, 150).map((r) => {
      const ros = data.rosIndex.byPlayer.get(r.pid)?.breakdown;
      const owner = ownerByPid.get(r.pid)?.name ?? null;
      const pct = data.playersById.get(r.pid)?.percent_owned;
      const context =
        sort === 'trend'
          ? pct != null
            ? `${pct.toFixed(0)}% rostered`
            : null
          : ros
            ? `${fmt1(ros.rosPoints)} pts left`
            : null;
      return {
        player: enrichPlayer(data, r.pid, data.currentWeek, '', false),
        note: [owner, context].filter(Boolean).join(' · ') || null,
      };
    });
  }, [data, group, availability, rosterId, sort, deferredQuery, ownerByPid, nflStatus]);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Waivers • trades • start/sit</p>
          <h1 className="page-title">Player explorer</h1>
          <p className="page-description">ESPN's rest-of-season outlook, scored the way your league scores.</p>
        </div>
      </div>

      <div className="data-note">
        <span className="data-note__dot" aria-hidden="true" />
        ESPN snapshot · {timeAgo(data.generatedAt)}
        <span>
          Rest of season covers weeks {data.rosIndex.fromWeek}–{data.maxWeek}, byes and
          injuries included.
        </span>
      </div>

      <div className="filters">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          placeholder="Search name or team…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search players"
        />

        <div className="segmented" role="group" aria-label="Fantasy ownership">
          <button
            aria-pressed={availability === 'free'}
            onClick={() => {
              setAvailability('free');
              setRosterId('ALL');
            }}
          >
            Free agents
          </button>
          <button
            aria-pressed={availability === 'rostered'}
            onClick={() => {
              setAvailability('rostered');
              setRosterId('ALL');
            }}
          >
            Rostered
          </button>
          <button
            aria-pressed={availability === 'all'}
            onClick={() => {
              setAvailability('all');
              setRosterId('ALL');
            }}
          >
            All
          </button>
        </div>

        <select
          className="select"
          aria-label="NFL status"
          value={nflStatus}
          onChange={(e) => setNflStatus(e.target.value as NflRosterStatus | 'all')}
        >
          <option value="all">All NFL statuses</option>
          {Object.entries(ROSTER_LABELS).map(([status, label]) => (
            <option key={status} value={status}>
              {label}
            </option>
          ))}
        </select>

        <div className="segmented" role="group" aria-label="Sort by">
          {SORTS.map((option) => (
            <button
              key={option.key}
              aria-pressed={sort === option.key}
              title={option.title}
              onClick={() => setSort(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Position group">
          <button aria-pressed={group === 'ALL'} onClick={() => setGroup('ALL')}>
            All
          </button>
          {POSITION_GROUPS.map((g) => (
            <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>

      {sort === 'value' && group === 'ALL' && (
        <p className="tiny muted" style={{ margin: '-6px 0 12px' }}>
          Value ranks a player within his position, so across positions the best kicker
          available sits beside the best receiver available. Pick a position to compare
          like with like.
        </p>
      )}

      <div className="filters">
        <div className="segmented" role="group" aria-label="Fantasy team">
          <button aria-pressed={rosterId === 'ALL'} onClick={() => setRosterId('ALL')}>
            All fantasy teams
          </button>
          {data.teams.map((team) => (
            <button
              key={team.rosterId}
              aria-pressed={rosterId === team.rosterId}
              onClick={() => {
                setAvailability('rostered');
                setRosterId(team.rosterId);
              }}
            >
              {team.name}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          title="No players match"
          hint="Try a different fantasy team, position group, or clear the search."
        />
      ) : (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>
              {results.length} shown
              {results.length === 150 ? ' (top 150)' : ''}
            </span>
          </div>
          {results.map(({ player, note }) => (
            <PlayerRow key={player.pid} player={player} onSelect={setOpenPid} note={note} />
          ))}
        </section>
      )}

      <PlayerModal pid={openPid} week={data.currentWeek} onClose={() => setOpenPid(null)} />
    </>
  );
}
