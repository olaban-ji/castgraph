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
internal/graph/    Neo4j store: UNWIND/MERGE writes, network/path queries
internal/crawl/    level-by-level crawler with two-phase cast scoring
internal/api/      handlers
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
curl -s 'localhost:8080/movies/603/network' | head -c 600
```

The graph fills itself on demand: the first `/network` request for a movie
crawls it to depth 1 (a few seconds, ~15–40 TMDb calls), then answers from
Neo4j. Concurrent first requests for the same movie share one crawl, which
runs detached from the requests so a client disconnecting does not abort it.
Deeper levels stay opt-in through `/nodes/{id}/expand`.

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
the network readable. The anchor sits on a gold trunk of its lead actor's
films running straight down the years; branch pathways step sideways to
films that share a cast member with each stop, drawn as gradients from the
source decade's hue to the target's, weighted by billing. Cards come in
three tiers — anchor, trunk, branch — that carry less detail the further
they sit from the anchor; branch cards are the poster alone until hovered.
Hovering an edge lights its whole lineage back to the anchor and names the
actor, role and billing. A fixed year rail tracks the scroll; ⌘/ctrl-scroll
or the corner buttons zoom (0.4–1.6×). Scrolling is the navigation: stops
near the viewport fetch their pathways and grow; stops further out show as
shimmering skeletons until the reader gets there.

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

What goes on the map is decided in `web/src/tree.ts` (`RULES`): 10 trunk
stops (the lead's most voted films); 6 co-stars of the anchor with 2 films
each; 2 co-stars at each trunk stop and **1** at every stop beyond, one
film each — so breadth decays with distance from the anchor and a chain
past the trunk reads as a route, not a fan. No depth cap. A connection is
drawn only through an actor billed in the top 5 of _both_ films, and only
to films with at least 200 TMDb votes (`billing` / `min_votes` on
`/pathways`), which is what keeps "12th-billed in an obscure title" edges
off the map.
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
| `GET /movies/{id}/pathways?costars=6&films=5&billing=5&min_votes=200` | the lean expansion of a stop: its lead cast (top billing first) and director, with each person's most voted other films and their role in each; `billing`/`min_votes` drop minor roles and obscure titles (directors ignore billing); crawls `{id}` first if needed and warms the films returned |
| `GET /movies/{id}/network?depth=1&limit=200`                          | movies reachable from `{id}` through shared cast or director, `depth` movie-hops out (1–3), as `{nodes, edges}`; crawls `{id}` first if it has never been                                                                                         |
| `GET /movies/{id}/path/{other}`                                       | shortest shared-cast-or-director chain between two movies                                                                                                                                                                                          |
| `POST /movies/{id}/crawl?depth=1`                                     | run the crawler from `{id}` (synchronous)                                                                                                                                                                                                          |
| `POST /nodes/{id}/expand?depth=1`                                     | fetch the next hop for a node already on screen and return that neighbourhood to merge in                                                                                                                                                          |
| `GET /healthz`                                                        | liveness                                                                                                                                                                                                                                           |

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

Edges nearest the seed and highest billed come first, so a `limit`-truncated
network is still the useful part of it.

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
`vote_count >= 50`) seed the next depth level. Pathways keep the lead actor
first so the map trunk is unchanged; the director is the first branch.

## Tests

```bash
go test ./...
```

The `graph` package has an integration test that runs only when pointed at
a Neo4j instance. It writes ids from 900000000 upward and deletes them after:

```bash
NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_PASSWORD=password123 go test ./...
```
