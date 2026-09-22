# cinedikt

Given a movie, build a graph of everyone who acted in it or directed it
and every other movie those people appeared in or directed, stored in
Neo4j and served as node/edge JSON for a timeline-constrained force graph.

```
TMDb API --> Go crawler --> Neo4j --> Go query API --> React map (web/)
```

## Layout

```
cmd/crawler/       CLI: seed the graph from one movie
cmd/api/           HTTP server over the graph
internal/tmdb/     TMDb client: token-bucket rate limit, retries
internal/omdb/     OMDb client for IMDb ratings
internal/rediscache/ Redis response cache for both clients (REDIS_URL)
internal/app/      wiring shared by the two commands
internal/graph/    Neo4j store: UNWIND/MERGE writes, pathway queries
internal/crawl/    level-by-level crawler with two-phase cast scoring
internal/seen/     bounded, expiring "already fetched" memory
internal/api/      handlers, rate limiting, the cold-crawl gate, warming
internal/config/   env loading
```

## Setup

Neo4j must be reachable over Bolt (the browser at http://localhost:7474 is
not the driver endpoint). Copy `.env.example` to `.env` and fill in either a
TMDb v3 API key or a v4 read access token.

```bash
cp .env.example .env
```

## Run

```bash
go run ./cmd/api
```

```bash
curl -s 'localhost:8080/movies/603/pathways' | head -c 600
```

The graph fills itself on demand: the first `/pathways` request for a movie
crawls it to depth 1 (about a second, ~10 TMDb calls), then answers from
Neo4j in single-digit milliseconds. Concurrent first requests for the same
movie share one crawl, which runs detached from the requests so a client
disconnecting does not abort it. Further hops are filled by the warmer as
people browse, or by `cmd/crawler`.

Because those endpoints crawl on demand, public traffic is bounded in two
places (`internal/api/limit.go`): a token bucket per client address
(`RATE_LIMIT_PER_SEC`, `RATE_LIMIT_BURST`), and a cap on how many
first-visit crawls run at once across all clients (`MAX_COLD_CRAWLS`).
A request that cannot get a crawl slot within a few seconds gets 503 and a
`Retry-After` rather than queueing behind a rate-limited TMDb. The warmer
only takes a slot no reader wants, so background work never slows a
reader.

## Deploy

Railway is the deployment target of record: [`railway.toml`](railway.toml)
builds [`Dockerfile`](Dockerfile) and health-checks `/api/healthz`, and the
service's variables hold the secrets. The image is production by
construction — it sets `APP_ENV=production`, which is the only thing that
turns analytics on — and Railway injects `PORT`, which the config prefers
over `API_ADDR`.

```bash
railway up
```

Variables to set on the Railway service (see `.env.example` for the rest):
`TMDB_API_KEY` or `TMDB_ACCESS_TOKEN`, `NEO4J_URI`, `NEO4J_USER`,
`NEO4J_PASSWORD`, `REDIS_URL`, `OMDB_API_KEY`, `POSTHOG_PROJECT_TOKEN`.

The multi-stage build compiles the map with Node, the API with Go
(`-trimpath -ldflags="-s -w"`, an 11MB binary in a 31MB image) and ships
neither toolchain; it runs as `nobody`.

Service settings live in [`.railway/railway.ts`](.railway/railway.ts)
(Infrastructure as Code), which replaces the deprecated `railway.toml`:
the Dockerfile builder, the health check, the restart policy, and every
variable name the service holds. Values are `preserve()`d, so secrets stay
in Railway and out of the repository — but a name missing from that list
is a name the next `railway config apply` deletes.

```bash
cd .railway && npm install     # once, so the CLI can evaluate the config
railway config plan            # review; expect "0 to destroy"
railway config apply           # write the settings to Railway
```

The file declares `partial = "cinedikt"`, so it owns this service only and
leaves the Neo4j and Redis services alone.

## Pre-seeding (optional)

```bash
go run ./cmd/crawler -movie 603            # The Matrix, depth 1
go run ./cmd/crawler -movie 603 -depth 2 -v
```

Depth 1 writes the seed movie, its full cast, and the filmographies of cast
members who pass scoring. Each further level fetches the credits of the
movies just discovered and scores their casts in turn. Constraints on
`Movie.id` and `Person.id` are created on startup; all writes are `MERGE`, so
re-running over the same data never duplicates anything.

Set `REDIS_URL` to cache raw TMDb and OMDb responses in Redis (7-day TTL
for TMDb, 30 days for OMDb), so a re-crawl or an expansion of an
already-seen node costs no API calls. Several API instances can share one
cache. Keys carry no credentials; give Redis a `maxmemory` with
`allkeys-lru` and it sizes itself. Without `REDIS_URL` every request hits
the upstream APIs.

## Frontend

The map in `web/` is built from the v3 ("Terrain") design handoff: a
filmstrip canvas where **y is strictly the release year** and x only keeps
the network readable. The searched film is a seed at the centre. It blows
out through its cast and directors to other films, each of which is a seed
in turn and blows out the same way. A title is one card; a later seed that
reaches it draws another edge instead of a duplicate. Edges are gradients
from the source decade's hue to the target's, weighted by billing. Cards come in three tiers — anchor, trunk,
branch — that carry less detail the further they sit from the search; branch
cards are the poster alone until hovered. Hovering an edge lights its whole
lineage back to the anchor and names the person, role and billing. A fixed
year rail tracks the scroll; ⌘/ctrl-scroll or the corner buttons zoom
(0.4–1.6×). Scrolling is the navigation: stops near the viewport fetch their
pathways and grow; stops further out show as shimmering skeletons until the
reader gets there.

```bash
cd web && npm install && npm run dev      # http://localhost:5173, proxies /api to :8080
```

Each stop asks `GET /movies/{id}/pathways` for its cast and their best
films — a ~15 KB answer from Neo4j in a few milliseconds when the movie has
been crawled. The API crawls a movie on its first request (about a second:
two TMDb round trips) and then **warms the next hop in the background**:
every film a pathways response hands out is crawled by worker goroutines
before the reader scrolls to it, so on a warm server nearly every request
is served from the graph.

For a single process, build it and point the API at the bundle:

```bash
cd web && npm run build
```

```bash
WEB_DIR=web/dist go run ./cmd/api         # http://localhost:8080/?movie=603
```

The API is always available under `/api/...`; with `WEB_DIR` unset it also
answers at `/`.

What goes on the map is decided in `web/src/tree.ts` by a blow-out from
each seed, not by a gold trunk or a share of 360°. A person *p* connecting
seed *m* to film *f* scores `σ = log(1+π(p)) · φ(o(p,m)) · log(1+votes(f)) · φ(o(p,f))`
with `φ(o) = 1/(1+λo)` and `λ = 0.2`. Billing order is o; directing is o = 0;
π is TMDb person popularity. σ only ranks the fan: the searched film blows
out its directors (always) plus 10 billed people × 6 films, every later seed
8 × 3, heaviest first. No depth cap. A hop to a film already on the map
becomes a network edge.
Films still need a year and at least 200 TMDb votes (`min_votes` on
`/pathways`). The API returns billed actors plus directors as a candidate
pool; the map sends `billing=0` and ranks that pool.
Growth is paid for in scrolling (`web/src/App.tsx`): a stop is expanded
when it comes within a quarter screen of the viewport, but a stop born from
an expansion waits until the reader has scrolled half a screen since it
appeared, and a screen that already holds about one card per 320×200 px
only expands the stop under the spotlight. Left alone, a map settles in a
few seconds; it never grows on its own.
Geometry per device (phone / tablet / desktop) is in `web/src/layout.ts`,
straight from the handoff table; clashes are resolved sideways only, each
new card settled exactly against the cards already placed so nothing on
screen ever moves. Cards show the IMDb rating when the film
has one, otherwise TMDb's.

```bash
cd web && npm test
```

## Routes

| Route                                                                 | What it does                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /search/movies?q=matrix`                                         | TMDb title search, to pick a seed                                                                                                                                                                                                                  |
| `GET /movies/{id}/pathways?costars=6&films=5&billing=0&min_votes=200` | the lean expansion of a stop: its cast (top billing first) and director, with each person's most voted other films and their role in each; `billing`/`min_votes` narrow the candidate pool (`billing=0` means no cutoff; directors ignore billing); the map ranks hops itself; crawls `{id}` first if needed and warms the films returned |
| `GET /healthz`                                                        | readiness: pings Neo4j (and Redis when configured) and answers 503 if either is unreachable, so a broken instance leaves the load balancer                                                                                                          |

Node ids are `m:<tmdb id>` for movies and `p:<tmdb id>` for people:

```json
{
  "nodes": [
    {
      "id": "m:603",
      "type": "movie",
      "label": "The Matrix",
      "tmdb_id": 603,
      "year": 1999,
      "poster": "https://image.tmdb.org/t/p/w342/p96dm7sCMn4VYAStA6siNz30G1r.jpg",
      "rating": 8.2,
      "votes": 26000,
      "imdb_id": "tt0133093",
      "imdb_rating": 8.7,
      "imdb_votes": 2081234
    },
    {
      "id": "p:6384",
      "type": "person",
      "label": "Keanu Reeves",
      "tmdb_id": 6384
    }
  ],
  "edges": [
    { "source": "p:6384", "target": "m:603", "role": "Neo", "order": 0 }
  ]
}
```

`rating` is TMDb's 0–10 user score over `votes` ratings. With an
`OMDB_API_KEY` set (free at omdbapi.com, 1,000 requests/day), movies whose
cast has been fetched also carry `imdb_rating` and `imdb_votes` from IMDb;
movies known only from a filmography keep the TMDb score, since the lookup
needs an IMDb id that only the movie endpoint returns. Lookups are cached
for 30 days, misses included, to stay inside the quota. `poster` is a w342
image URL (see `graph.PosterBaseURL` for other sizes).

Pathways come back top-billed first with the film's directors spliced in
after the first actor, so a `costars`-truncated answer is still the part of
the cast a reader would recognise.

## Scoring

Who gets crawled further is decided per cast member, not by a flat billing
cutoff (`internal/crawl/score.go`):

1. **Phase 1, free** — from the credits payload: skip anyone whose
   `known_for_department` is not Acting; then
   `popularity - 0.05 * order >= 0.5 * (depth + 1)`. The constants are
   calibrated to TMDb's current popularity scale (leads 3–8, supporting 1–3,
   extras under 1) and can be overridden with `CRAWL_THRESHOLD_BASE` and
   `CRAWL_ORDER_PENALTY`.
2. **Directors** — the film's Directors (usually one, sometimes two) are
   always expanded. Crew is already on the movie's credits payload, so this
   costs one extra `/person` round trip and writes `DIRECTED` edges to their
   other films. They skip the acting popularity bar; `MaxPeoplePerMovie`
   does not apply to them.
3. **Phase 2** — fetch `/person/{id}` (with `movie_credits` appended, one
   round trip) and confirm the authoritative department and popularity
   before writing the filmography and fanning out from it.

Everyone in a cast list is still written to the graph; scoring only decides
whose filmography is fetched. Filmography entries where the person appears
as themselves or via archive footage are dropped, and only acting entries
with `order <= 10` and `vote_count >= 50` (or directed films with
`vote_count >= 50`) seed the next depth level. Pathways return the first
actor, then the directors, then the rest of the cast — a candidate pool.
Who actually hangs off a seed is the hop score in
`web/src/tree.ts`, not payload order. Person popularity is returned on
pathway people so the map can weight σ. A film already placed is linked,
not duplicated.

## Tests

```bash
go test ./...
```

The `graph` package has an integration test that runs only when pointed at
a Neo4j instance. It writes ids from 900000000 upward and deletes them after:

```bash
NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_PASSWORD=password123 go test ./...
```
