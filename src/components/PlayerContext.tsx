import { useMemo } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { availabilityFactor, rosterStatus } from '../lib/availability';
import { playerMetrics } from '../lib/playerMetrics';
import { AvailabilityBadge } from './AvailabilityBadge';
import type { Player } from '../lib/types';

/**
 * Season production rates. Split from the availability panel so the player
 * sheet can place this with the other season sections and keep today's NFL
 * status at the very bottom.
 */
export function PlayerOpportunity({ player }: { player: Player }) {
  const data = useLeagueData();
  const profile = useMemo(
    () => playerMetrics(player.player_id, player, data.weeks, data.currentWeek),
    [player, data],
  );

  if (profile.games === 0 || profile.metrics.length === 0) return null;

  return (
    <section>
      <h3 className="section-title">
        Opportunity &amp; efficiency <span className="tiny muted">· {data.season}</span>
      </h3>
      <div className="metric-grid">
        {profile.metrics.map((metric) => (
          <div className="metric" key={metric.label} title={metric.detail}>
            <div className="tiny muted">{metric.label}</div>
            <div className="mono bold">
              {metric.value === null
                ? '—'
                : `${metric.value.toFixed(1)}${metric.unit === 'percent' ? '%' : ''}`}
            </div>
          </div>
        ))}
      </div>
      <p className="tiny muted">{profile.games} games with participation.</p>
    </section>
  );
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  QUESTIONABLE: 'Questionable',
  DOUBTFUL: 'Doubtful',
  OUT: 'Out',
  INJURY_RESERVE: 'Injured reserve',
  SUSPENSION: 'Suspended',
  DAY_TO_DAY: 'Day to day',
};

/** Today's status from ESPN, what it does to Value, and ESPN's own outlook. */
export function PlayerAvailability({ player }: { player: Player }) {
  const data = useLeagueData();
  const factor = availabilityFactor(player);
  const ros = data.rosIndex.byPlayer.get(player.player_id)?.breakdown ?? null;
  const status = player.injury_status ? (STATUS_LABELS[player.injury_status] ?? player.injury_status) : 'Not reported';

  return (
    <section className="availability-panel">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <h3 className="section-title">
          NFL availability <span className="tiny muted">· current</span>
        </h3>
        <AvailabilityBadge player={player} includeActive />
      </div>
      <dl className="context-grid">
        <div>
          <dt>NFL team</dt>
          <dd>{rosterStatus(player) === 'free-agent' ? 'None' : player.team || 'Not reported'}</dd>
        </div>
        <div>
          <dt>ESPN status</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>Bye week</dt>
          <dd>
            {player.bye_week
              ? `Week ${player.bye_week}${player.bye_week < data.rosIndex.fromWeek ? ' (done)' : ''}`
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Games projected</dt>
          <dd>
            {ros ? `${ros.projectedGames} of ${ros.weeksLeft} weeks left` : 'Not projected'}
          </dd>
        </div>
      </dl>
      {factor < 1 && (
        <div className="value-adjustment">
          <strong>Availability adjustment</strong>
          <span>
            In-season form ×{factor.toFixed(2)}. The rest-of-season half needs none: ESPN
            already projects him for nothing in the weeks it expects him to miss.
          </span>
        </div>
      )}
      {player.outlook && (
        <details className="context-details">
          <summary>ESPN outlook</summary>
          <p className="small" style={{ marginTop: 8 }}>
            {player.outlook}
          </p>
        </details>
      )}
      <p className="tiny muted">
        Status, team and outlook: ESPN, as of the snapshot published{' '}
        {new Date(data.generatedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}
        .
      </p>
    </section>
  );
}
