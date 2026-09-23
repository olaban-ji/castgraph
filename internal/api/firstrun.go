package api

import (
	"context"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"cinedikt/internal/graph"
)

// FirstRunTiles is how many films the cold screen offers.
const FirstRunTiles = 8

// firstRunPerBand is how many candidates to hold for each era. Sampling
// happens here rather than in Neo4j so a visitor waits for nothing: the
// query is eight label scans, which is cheap once an hour and wasteful on
// every first paint.
const firstRunPerBand = 250

// firstRunTTL is how long a set of candidates is reused. The graph grows
// by crawling, so an hour keeps new films arriving without ever making a
// reader wait for a scan.
const firstRunTTL = time.Hour

// firstRunCache holds random candidates per era and hands out a different
// eight on every request. A stale set is better than a slow one, so a
// failed refresh keeps serving what it has.
type firstRunCache struct {
	reader FirstRunReader
	bands  []graph.FirstRunBand

	mu      sync.Mutex
	bandsOf [][]graph.Node
	fetched time.Time
	filling bool
}

// FirstRunReader is the graph read the cold screen needs.
type FirstRunReader interface {
	FirstRunCandidates(ctx context.Context, bands []graph.FirstRunBand, perBand int) ([][]graph.Node, error)
}

func newFirstRunCache(r FirstRunReader) *firstRunCache {
	return &firstRunCache{reader: r, bands: graph.DefaultFirstRunBands}
}

// films returns one film per era, shuffled. It refreshes the candidates
// when they are stale, and returns nil only when it has never had any.
func (c *firstRunCache) films(ctx context.Context) []graph.Node {
	held, stale := c.held()
	if stale {
		if fresh, err := c.refresh(ctx); err == nil {
			held = fresh
		}
	}
	if len(held) == 0 {
		return nil
	}
	out := make([]graph.Node, 0, len(held))
	seen := make(map[string]bool, len(held))
	for _, band := range held {
		if len(band) == 0 {
			continue
		}
		// A film can sit in only one era, but a band can be short enough
		// to repeat one across refreshes; keep the answer distinct.
		pick := band[rand.IntN(len(band))]
		if seen[pick.ID] {
			continue
		}
		seen[pick.ID] = true
		out = append(out, pick)
	}
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

func (c *firstRunCache) held() ([][]graph.Node, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	stale := c.bandsOf == nil || time.Since(c.fetched) > firstRunTTL
	// One refresh at a time: the rest keep serving what is already here.
	if stale && c.filling {
		stale = false
	}
	if stale {
		c.filling = true
	}
	return c.bandsOf, stale
}

func (c *firstRunCache) refresh(ctx context.Context) ([][]graph.Node, error) {
	bands, err := c.reader.FirstRunCandidates(ctx, c.bands, firstRunPerBand)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.filling = false
	if err != nil {
		return nil, err
	}
	c.bandsOf = bands
	c.fetched = time.Now()
	return bands, nil
}

// firstRun is GET /first-run: eight films to start a map from, one per
// era so the screen spans the century rather than the last ten years,
// and a different eight every time it is asked. The client keeps its own
// built-in set for when this is unreachable, so an empty answer is not
// an error worth failing a page load over.
func (s *Server) firstRun(w http.ResponseWriter, r *http.Request) {
	films := s.firstRunFilms(r.Context())
	hits := make([]map[string]any, 0, len(films))
	for _, f := range films {
		hits = append(hits, map[string]any{
			"id":     f.TMDBID,
			"title":  f.Label,
			"year":   f.Year,
			"poster": f.Poster,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits})
}
