/**
 * The redraft trade market — the one price ESPN's own data doesn't carry.
 *
 * ESPN publishes ownership, start rates and a draft ADP, all of which say how
 * the crowd *uses* a player. None says what he would fetch in a trade this
 * week, which is the question a redraft manager with a surplus is asking.
 * FantasyCalc publishes that number as a free JSON feed, computed from real
 * trades, for redraft as well as dynasty, and matched to a league's size and
 * reception scoring. Every entry carries the player's ESPN id, so it joins onto
 * the snapshot with no name matching at all.
 *
 * Everything here is best-effort: the feed is a third party, so a failure must
 * degrade to "no market data" rather than break the load. It prices
 * quarterbacks, running backs, receivers and tight ends only — kickers and
 * defences legitimately come back empty and read as neutral.
 */

const FANTASYCALC = 'https://api.fantasycalc.com/values/current';

/** One player's redraft market snapshot, normalised to what the model reads. */
export interface MarketEntry {
  /** FantasyCalc redraft value (arbitrary units; only relative size matters). */
  value: number;
  /** Overall market rank across all valued players, 1 = most valuable. */
  overallRank: number;
  /** Rank within the player's own position. */
  positionRank: number;
  /** 30-day value change; its sign gives the market trend. */
  trend30Day: number;
  /** How often the player actually trades — a liquidity proxy. */
  tradeFrequency: number | null;
}

interface RawFantasyCalcEntry {
  player?: { espnId?: string | number | null };
  value?: number;
  overallRank?: number;
  positionRank?: number;
  trend30Day?: number;
  maybeTradeFrequency?: number | null;
}

/** Shape of the league inputs that steer the value feed to the right format. */
export interface MarketQuery {
  /** 1 for one-QB, 2 for superflex. */
  numQbs: number;
  numTeams: number;
  /** Points per reception (0, 0.5, 1). */
  ppr: number;
}

/**
 * Derives the market query from the league's own settings, so the values match
 * the format being scored — a reception-heavy receiver is worth more in PPR, and
 * the feed knows the difference if asked correctly.
 */
export function marketQueryFromLeague(
  rosterPositions: string[] | undefined,
  totalRosters: number | undefined,
  rec: number | undefined,
): MarketQuery {
  const positions = rosterPositions ?? [];
  const superflex = positions.some((p) => p === 'SUPER_FLEX');
  return {
    numQbs: superflex ? 2 : 1,
    numTeams: totalRosters && totalRosters > 0 ? totalRosters : 10,
    ppr: typeof rec === 'number' ? rec : 0.5,
  };
}

/**
 * Fetches current redraft market values keyed by ESPN player id.
 *
 * Returns an empty map on any failure; the model reads a missing entry as a
 * neutral market signal rather than a zero.
 */
export async function getMarketValues(
  query: MarketQuery,
  signal?: AbortSignal,
): Promise<Map<string, MarketEntry>> {
  const url =
    `${FANTASYCALC}?isDynasty=false` +
    `&numQbs=${query.numQbs}` +
    `&numTeams=${query.numTeams}` +
    `&ppr=${query.ppr}`;

  const out = new Map<string, MarketEntry>();
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return out;
    const raw = (await res.json()) as RawFantasyCalcEntry[];
    if (!Array.isArray(raw)) return out;

    for (const entry of raw) {
      const pid = entry.player?.espnId;
      if (pid === null || pid === undefined || pid === '' || typeof entry.value !== 'number') continue;
      out.set(String(pid), {
        value: entry.value,
        overallRank: entry.overallRank ?? 0,
        positionRank: entry.positionRank ?? 0,
        trend30Day: entry.trend30Day ?? 0,
        tradeFrequency:
          typeof entry.maybeTradeFrequency === 'number' ? entry.maybeTradeFrequency : null,
      });
    }
  } catch {
    /* Third-party feed — a failure means "no market data", never a broken load. */
  }
  return out;
}
