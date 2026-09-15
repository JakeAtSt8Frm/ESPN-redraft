/**
 * One line under the header saying what the refresh control is doing, or why
 * it found nothing new — see `data/refresh.ts`.
 *
 * The live region stays mounted while empty so a message that appears in it is
 * announced. The elapsed-time readout is hidden from assistive technology,
 * which would otherwise read it out every second.
 */

import { useEffect, useState } from 'react';
import type { RefreshStatus } from '../data/refresh';

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return (
    <span className="refresh-status__elapsed mono" aria-hidden="true">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

export function RefreshStatusBar({
  status,
  onDismiss,
}: {
  status: RefreshStatus | null;
  onDismiss: () => void;
}) {
  return (
    <div
      className={`refresh-status${status ? ` refresh-status--${status.tone}` : ''}`}
      role="status"
      aria-live="polite"
    >
      {status && (
        <div className="refresh-status__inner">
          {status.tone === 'progress' && <span className="refresh-status__spinner" aria-hidden="true" />}
          <span className="refresh-status__message">
            {status.message}
            {status.tone === 'progress' ? '…' : ''}
            {status.tone === 'progress' && status.since !== undefined && <Elapsed since={status.since} />}
          </span>
          {status.runUrl && (
            <a className="refresh-status__link" href={status.runUrl} target="_blank" rel="noreferrer">
              View run ↗
            </a>
          )}
          {status.tone !== 'progress' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm refresh-status__dismiss"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}
