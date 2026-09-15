# Redraft — ESPN League Analytics

A fantasy football analytics app for two ESPN **redraft** leagues, built around
each league's own scoring rather than any standard format:

| League | Format | Teams | Lineup | Playoffs |
|---|---|---|---|---|
| **UK-BG** | PPR (1 per reception, −2 per INT) | 8 | QB, 2 RB, 2 WR, TE, FLEX, D/ST, K · 7 BN · 1 IR | Top 6, weeks 15–17 |
| **The O.J. Invitational** | Half-PPR (0.5 per reception, −1 per INT), custom D/ST ladder | 8 | QB, 2 RB, 2 WR, TE, FLEX, D/ST, K · 6 BN · 1 IR | Top 5, weeks 15–17 |

Switch leagues from the header. A link can name one: `?league=oj-invitational`.

It is the SLA app — the Sleeper dynasty league app — converted: the same pages,
the same models and the same care about what a number can and can't claim, with
Sleeper swapped for ESPN, the IDP positions swapped for a team D/ST, every
dynasty measure replaced by a redraft one, and the blue swapped for red.

## Where the data comes from

ESPN serves these leagues only to a request carrying a logged-in browser's
`SWID` and `espn_s2` cookies, and a page on `github.io` cannot send espn.com
cookies to anything. So the browser never talks to ESPN. A Node script does, and
publishes plain JSON beside the app:

```
scripts/snapshot.ts  →  public/data/<league>/index.json     the stamp the page checks
                                            league.json     settings, teams, schedule, NFL games, draft
                                            players.json    the player universe, ESPN ownership/ADP/rank
                                            weeks/1-17.json projections, results and real lineups, per week
                                            prior.json      last season's weekly projections and results
```

Each league is read with its own cookie pair — the two leagues are reached
through different ESPN logins — from `ESPN_SWID_<KEY>` / `ESPN_S2_<KEY>`, where
`<KEY>` is the league key upper-cased (`UK_BG`, `OJ_INVITATIONAL`). Locally they
live in a gitignored `.env`; in CI they are repository secrets. Nothing with a
cookie in it is ever committed or shipped.

A run pulls both leagues in about fifteen seconds. The page fetches `index.json`
fresh on every load and everything else is cached in IndexedDB under the
index's stamp, so a new snapshot is picked up the moment it's published and an
unchanged one costs nothing. The cookies expire every few months; when a
snapshot starts failing with a 401, copy fresh ones from a logged-in browser
(DevTools → Application → Cookies → espn.com) into `.env` and the secrets.

The only other request the page makes is to [FantasyCalc](https://fantasycalc.com)
for the redraft trade market (see below), which is keyed by ESPN player id.

## Custom scoring is the whole point

Every number in the app — projections, results, Value Scores, matchup ratings,
optimal lineups, win probabilities — is computed by multiplying the league's
own ESPN scoring table against raw stat lines. ESPN's precomputed totals are
never used as the source of truth; they are what the engine is checked against.

ESPN expresses D/ST scoring as overrides on slot 16: the same stat ids mean
something else for a defence. The engine folds that into one table by splitting
each re-scored key in two — the D/ST line carries `def_int` at the D/ST value,
and any individual's copy moves to `def_int~ind` at the base value. That split
is there because the first version assumed `def_*` ids only ever appear on a
defence's line, and ESPN's totals refuted it on the first run: Travis Hunter
plays both ways, and his projection carries interceptions and sacks under the
very ids a D/ST uses. Folded naively he was paid for them, 0.15 points a week
above ESPN in both leagues.

### Verified

`npm run verify` recomputes every weekly result and projection ESPN published
an `appliedTotal` for — and every completed team score — from the snapshot's raw
lines, and requires agreement to the cent:

```
uk-bg — UK-BG, 1 per reception
  player-week actuals          87 compared, 0 mismatches (100.000%)
  player-week projections    7919 compared, 0 mismatches (100.000%)

oj-invitational — The O.J. Invitantional, 0.5 per reception
  player-week actuals          87 compared, 0 mismatches (100.000%)
  player-week projections    7919 compared, 0 mismatches (100.000%)
```

(Week 1, after the opener. Team totals reconcile once a week is final.)

That proves the arithmetic, not the stat-id *names*: both sides of the multiply
are keyed through the same id table, so a consistent mislabel cancels out and
still reads 100%. `npm run verify:stat-ids` checks the labels against evidence
that could refute them — every D/ST points- and yards-allowed flag against the
raw total on the same line (548 of 548 games agree), the kicking distance
buckets against field goals made (547 of 547), and the rate of every D/ST
counting stat. Ids 120–122 (points allowed, and the 18–21 and 22–27 rungs the
O.J. ladder pays for) were pinned this way, as was id 64, sacks taken, which
matches the opposing defence's sacks in 538 of 544 games.

## The metrics

**Custom score** — the league's scoring table × raw stat lines. Exact, above.

**Value Score (0–1000)** — the headline number, a blend of two halves. Every
signal in both is a percentile *within the player's own position group*, which
is what lets them be averaged and read the same way — "top of his own pool".
A 900 kicker and a 900 receiver are both near the top of their positions; the
number does not say one is worth the other.

- *In-season form* — what he has done this season. Ten signals: PPG (.22),
  weighted recent form (.16), the next projection (.17), position-group
  opportunity share (.17), last four (.08), schedule-adjusted PPG (.07), usage
  (.07), floor, availability and efficiency. (The Sleeper app's snap-share
  signal is gone — ESPN's feed has no snap counts — and its weight moved to the
  two nearest role measures and the projection.) A signal that can't tell a
  position apart is left out and the rest rescaled: kickers and defences have
  no opportunity share, because each has his whole unit to himself, and after a
  single week everyone's availability is the same. Scored as a tie, either one
  held the position's best short of the top of the scale.

- *Rest of season* — what he is projected to do from here, which in redraft is
  the whole of his value: nothing after this season counts. Its lead signal is
  ESPN's weekly projection for **every remaining week**, scored under the
  league's table and summed. That sum already contains the three things that
  decide redraft value: byes (a week without a game projects to nothing),
  injuries (ESPN projects a player it expects back in week 7 for nothing until
  week 7, and a player lost for the year for nothing at all) and the fantasy
  playoffs (the horizon runs through week 17). Legs: projected points left (.60),
  the redraft market (.20), role (.15), efficiency (.05). Role and efficiency
  start from ESPN's projection and hand over to what the player has actually
  shown across his first four games, rather than letting one game replace a
  season of projection.

The two are blended by how much of this season a player has played: before his
first game the rest-of-season half carries the score alone, and from his fourth
game on the halves count equally. Current injury status discounts only the
in-season half — the rest-of-season half's projections already leave out the
games an injury will cost, and discounting them again would bill those games
twice.

No dynasty measure enters anything: no age curve, no multi-year production, no
dynasty market, no contender/rebuilder lens, no taxi squad.

### The redraft market, and buy / sell

The market leg is [FantasyCalc](https://fantasycalc.com)'s **redraft** trade
value, computed from real trades and matched to each league's size and reception
scoring, averaged with ESPN's rostered percentage. FantasyCalc prices QB/RB/WR/TE
only; kickers and defences read ESPN ownership alone.

The player sheet's verdict compares two ranks built the same way over the same
pool — this model's rest-of-season rank among the players FantasyCalc prices at
his position, *with every trace of the market removed*, against FantasyCalc's
rank over those same players. A gap of fifteen percentiles either way is a
**Buy low** or **Sell high**; anything closer is **Fairly valued**. Players at the
bottom of the market ("Thin market"), players with neither a projection nor a
game ("No read") and kickers and defences ("No market") get an abstention rather
than a call. On the week-1 snapshot the split is about 10% buy, 80% fair, 9% sell.

### Comparing across positions

Value can't be — see above. The cross-position numbers are points: *projected
points left* (the player browser's "Rest of season" sort, the same scale ESPN's
own free-agent list uses) and *points over replacement* in the player sheet,
where replacement is the player at the startable cliff of this league's lineup
(8 QBs, ~19 backs, 20 receivers, ~9 tight ends, 8 kickers, 8 defences).

Points over replacement is deliberately **not** a free-agent sort. Every free
agent sits below his position's cliff, so it ranks them by how close to
startable they are — and the positions where the whole waiver pool is close are
kicker and defence, whose free agents are nearly as good as the starters
precisely because nobody needs a second one.

### Team Outlook

The Analytics page's outlook is measured in the only thing a redraft roster is
worth: the lineups it can field from here to the final. For every remaining
week, each team's best legal lineup from its current roster under ESPN's
projection for that week, solved exactly by the same matcher as the Optimal
page, averaged — projected starter points per week. Byes and injuries cost
exactly the weeks they take. Waiver moves and trades aren't modelled. Positional
tabs split those points by the position of whoever fills each slot, flex
included, and add back up to the total (`npm run verify:outlook`).

**Power Rankings** measure the season entering the selected week: 50% average
weekly starter points, 25% the last four completed weeks, 25% that week's
starter projection. Week 1 uses projections only.

**Matchup Score (0–100)** — an opponent-only rating: schedule-adjusted custom
points allowed (.60) and opportunity volume allowed (.40), fit two-way so a
defence isn't flattered by a soft run of offences. For a D/ST, the "defence" is
the offence it faces. How much the chip is worth varies enormously by position
— measured against ESPN's projections on 2023–2025:

| D/ST | K | QB | TE | WR | RB |
|---|---|---|---|---|---|
| 1.00 | 0.31 | 0.28 | 0.19 | 0.17 | 0.01 |

A defence's whole score is the offence across from it; a running back's
matchup adds nothing a projection doesn't already know. Chips below 0.15 are
dimmed and labelled rather than rescaled. Ratings are pregame-only: a week's
chip never contains that week's or later results, so week 1 has none.

## Weekly forecasts and win probability

Each position group's conditional distribution of a real result given its
projection is fit — bias, heteroskedastic spread and skew, all measured — and
drawn from to simulate matchups (10,000 runs) and the rest of the season through
the league's own playoff bracket.

In week 1 of a season there are no (projection, result) pairs to fit, so the
fit also pools **last season's**: ESPN's standard-scoring template league returns
every player's weekly logs *and the weekly projections that preceded them* for
any finished season, and the raw lines are scored under each league's own table.
This season's share of the evidence grows every week.

The per-player projection-bias correction the Sleeper app used is wired up and
switched off: it earned its place only against Sleeper's crude IDP projections,
and against ESPN's it never did.

## Pages

| Page | What it answers |
|---|---|
| **Teams** | Roster by slot group, with positional heatmaps |
| **Matchups** | Who plays who in the selected week, the record each side carries in, and live or pregame win probability |
| **Optimal Lineup** | The best legal lineup, and what it cost to miss it |
| **History** | Season trend: Projected vs Actual vs Optimal, week by week |
| **Available Players** | The waiver wire and everyone else: Value, points left, trending adds |
| **Schedule** | The NFL week with rostered players, owners and custom scores overlaid |
| **Analytics** | Playoff odds, standings, Power Rankings, Team Outlook, all-play, luck, matchup research |

Any player opens a sheet with his week forecast, the rest-of-season breakdown,
his trade value and verdict, ESPN's rank, ownership, ADP, draft slot, bye week,
a projected-vs-actual chart and a week-by-week table. The gear opens the league's
lineup, playoff shape, scoring highlights and the snapshot's age.

## Running it

```bash
npm install
```

Put the cookie pairs in `.env` (see `.env` naming above), then:

```bash
npm run snapshot
```

```bash
npm run dev
```

```bash
npm run verify
```

```bash
npm run verify:all
```

```bash
npm run build
```

## Deploying

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`,
which also runs hourly through the American day. With the four repository
secrets set (`ESPN_SWID_UK_BG`, `ESPN_S2_UK_BG`, `ESPN_SWID_OJ_INVITATIONAL`,
`ESPN_S2_OJ_INVITATIONAL`) every run pulls ESPN first, re-verifies the scoring
against ESPN's totals and publishes the fresh snapshot; without them it deploys
the committed one. `gh secret set -f .env` sets all four from a local `.env`.

One league failing — an expired cookie — doesn't stop the other refreshing or
the site deploying: a failed league writes nothing and keeps serving its last
data, and the run carries a warning. A failed check does stop the deploy, and
the site keeps its last snapshot until a run passes.

"Hourly" is what the workflow asks for; GitHub runs scheduled workflows on a
best-effort queue and in practice drops most of them, leaving gaps of several
hours. So the header's ⟳ can start a pull itself. On a device given a GitHub
token (League details → Fresh data) it triggers the workflow, follows the run
and swaps the new snapshot in when it's published, about two minutes later.
The token must be fine-grained, limited to this repository, with **Actions:
read and write**; the link in the panel fills in everything but the
repository. It is stored in that browser only and sent only to
api.github.com. Without a token ⟳ loads the newest published snapshot, and
when there is nothing newer it reads the workflow's last run (public, so no
token needed) to say why: a run still going, a run that failed and at which
step, or a run that finished without new ESPN data.

## Adding a league

Add it to `LEAGUES` in `src/lib/leagues.ts` and give it a cookie pair. Scoring,
lineup, playoff format and team names are all read from the league itself.

## Notable differences from the SLA app

- **ESPN, not Sleeper**, through a published snapshot rather than live
  browser requests — the leagues are private and cookie-only.
- **D/ST instead of IDP.** Position groups are QB, RB, WR, TE, K, D/ST; the
  heatmaps carry a FLEX column where the superflex column was.
- **Redraft, not dynasty.** The dynasty half of Value is replaced by the
  rest-of-season half; the dynasty market by the redraft market; the roster
  value outlook by projected starter points; the roster-season override and the
  taxi squad are gone.
- **One season per league**, with a league switcher where the season picker was.
  UK-BG started in 2026; the O.J. Invitational has 2021–2025 history on ESPN that
  isn't loaded.
- **The lineup solver pads thin rosters.** The Hungarian matcher looped forever
  when a team had fewer players than starting slots, which Sleeper's huge rosters
  never produced and an ESPN roster mid-drop can.
- **Red.** ESPN red chrome; the red → yellow → green data scale is unchanged,
  and chart series use a neutral projected line, red actual and teal optimal,
  each with its own dash pattern.

Keyboard, colour-vision, installability and failure-mode behaviour are as in
the SLA app: every heatmap cell and chip prints its value, the player sheet is a
real modal with a focus trap, a skip link jumps past the tabs, page errors are
contained to the page, and a deploy landing on an open tab triggers one guarded
reload.
