/**
 * League details popover.
 *
 * Everything a reader might want to check before trusting a number: which
 * league and format this is, the lineup and playoff shape the models use, the
 * scoring rules that differ from ESPN's defaults, and — because this is a
 * published snapshot rather than a live feed — how old the data is.
 */

import { useEffect, useRef } from 'react';
import { useLeague } from '../data/LeagueProvider';
import { fmtSlot } from '../lib/labels';
import { STAT_LABELS } from '../lib/espn-stats';
import { timeAgo } from '../lib/time';

/** The scoring rules worth calling out, in the order a manager thinks of them. */
const HIGHLIGHT_KEYS = ['rec', 'pass_td', 'pass_yd', 'pass_int', 'rush_yd', 'rec_yd', 'fum_lost', 'fgmiss'];

export function SettingsMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useLeague();
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape or a click outside the panel.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener('keydown', onKey);
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(id);
    };
  }, [open, onClose]);

  if (!open) return null;

  const scoring = data?.league.scoring_settings ?? {};
  const lineup = data ? summarizeLineup(data.starterSlots) : '';
  const bench = data?.league.roster_positions.filter((s) => s === 'BN').length ?? 0;
  const ir = data?.league.roster_positions.filter((s) => s === 'IR').length ?? 0;

  return (
    <div className="settings" ref={ref} role="dialog" aria-label="League details">
      <div className="settings__title">League details</div>

      {data ? (
        <>
          <dl className="settings__facts">
            <div>
              <dt>League</dt>
              <dd>
                {data.league.name} · {data.teams.length} teams · redraft
              </dd>
            </div>
            <div>
              <dt>Lineup</dt>
              <dd>
                {lineup}
                {bench ? ` · ${bench} BN` : ''}
                {ir ? ` · ${ir} IR` : ''}
              </dd>
            </div>
            <div>
              <dt>Playoffs</dt>
              <dd>
                Top {data.playoff.teams}, weeks {data.playoff.weekStart}–{data.maxWeek}
              </dd>
            </div>
            <div>
              <dt>Scoring</dt>
              <dd>
                {HIGHLIGHT_KEYS.filter((key) => typeof scoring[key] === 'number')
                  .map((key) => `${STAT_LABELS[key] ?? key} ${fmtPoints(scoring[key])}`)
                  .join(' · ')}
              </dd>
            </div>
          </dl>

          <p className="settings__hint">
            Every number is computed from this league's own ESPN scoring table, D/ST
            points-allowed ladder included — never from a standard format.
          </p>

          <div className="settings__meta tiny muted">
            ESPN snapshot {timeAgo(data.generatedAt)} ·{' '}
            {new Date(data.generatedAt).toLocaleString(undefined, {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
            <br />
            Forecast spread fit on {data.priorSeason ? `${data.priorSeason} weekly results` : 'this season'}
            {data.latestCompletedWeek > 0 ? ` + ${data.latestCompletedWeek} weeks of ${data.season}` : ''}.
            <br />
            Redraft market:{' '}
            {data.marketCount > 0 ? `FantasyCalc, ${data.marketCount} players priced` : 'unavailable right now'}.
          </div>
        </>
      ) : (
        <p className="settings__hint">Loading…</p>
      )}
    </div>
  );
}

function fmtPoints(n: number): string {
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return n > 0 ? `+${s}` : s;
}

/** "QB, 2 RB, 2 WR, TE, FLEX, D/ST, K" from the starting slots. */
function summarizeLineup(slots: string[]): string {
  const counts = new Map<string, number>();
  for (const slot of slots) counts.set(slot, (counts.get(slot) ?? 0) + 1);
  return [...counts]
    .map(([slot, n]) => (n > 1 ? `${n} ${fmtSlot(slot)}` : fmtSlot(slot)))
    .join(', ');
}
