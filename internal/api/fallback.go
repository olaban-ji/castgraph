package api

import (
	"context"
	"errors"
	"time"

	"cinedikt/internal/catalog"
	"cinedikt/internal/tmdb"
)

// OutsideSearch is asked only when the catalog's own search is empty.
// It returns TMDb's ids. Which IMDb title each one is was matched when
// the catalog was imported, so this call is the whole of the fallback.
type OutsideSearch interface {
	SearchMovies(ctx context.Context, query string) (*tmdb.SearchResults, error)
}

// WithSearchFallback asks TMDb when a catalog search comes back empty.
func (s *CatalogServer) WithSearchFallback(f OutsideSearch) {
	s.outside = f
}

// fallbackBudget is how long a missed search will wait on TMDb. Past
// that the field should say nothing matched, not keep spinning.
const fallbackBudget = 3 * time.Second

// fallbackSearch turns an empty catalog search into the films TMDb
// named that this catalog has already matched. TMDb being down, or
// naming a film the map does not know yet, is an empty list — the same
// one the catalog itself returned.
func (s *CatalogServer) fallbackSearch(ctx context.Context, q string) []catalog.Hit {
	if s.outside == nil {
		return nil
	}
	lookCtx, cancel := context.WithTimeout(ctx, fallbackBudget)
	defer cancel()

	res, err := s.outside.SearchMovies(lookCtx, q)
	if err != nil {
		s.warnFallback(err)
		return nil
	}
	if res == nil || ctx.Err() != nil {
		return nil
	}
	ids := make([]int, 0, len(res.Results))
	seen := make(map[int]struct{}, len(res.Results))
	for _, m := range res.Results {
		if m.ID == 0 {
			continue
		}
		if _, ok := seen[m.ID]; ok {
			continue
		}
		seen[m.ID] = struct{}{}
		ids = append(ids, m.ID)
	}
	if len(ids) == 0 {
		return nil
	}
	hits, err := s.Catalog.ByTMDB(ctx, ids)
	if err != nil {
		s.warnFallback(err)
		return nil
	}
	if len(hits) > SearchHits {
		return hits[:SearchHits]
	}
	return hits
}

func (s *CatalogServer) warnFallback(err error) {
	if err == nil || s.Logger == nil || errors.Is(err, context.Canceled) {
		return
	}
	s.Logger.Warn("tmdb search fallback", "err", err)
}
