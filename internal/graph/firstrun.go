package graph

import (
	"context"
	"fmt"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j/dbtype"
)

// FirstRunBand is one era the cold screen draws a film from, with the
// vote floor that era has to clear. The floor slides with age because a
// vote count is accumulated attention against a shrinking audience: 3,000
// votes is ordinary for a 2015 film and rare for a 1950s one, so a flat
// floor would offer nothing but this century.
type FirstRunBand struct {
	From  int
	To    int
	Votes int
}

// DefaultFirstRunBands spans the century in eight steps, one per tile on
// the cold screen. The floors were picked from the graph's own
// distribution so that no band holds fewer than about 150 candidates.
var DefaultFirstRunBands = []FirstRunBand{
	{From: 1900, To: 1959, Votes: 400},
	{From: 1960, To: 1969, Votes: 400},
	{From: 1970, To: 1979, Votes: 400},
	{From: 1980, To: 1989, Votes: 1000},
	{From: 1990, To: 1999, Votes: 1000},
	{From: 2000, To: 2009, Votes: 3000},
	{From: 2010, To: 2019, Votes: 3000},
	{From: 2020, To: 2999, Votes: 3000},
}

// MaxFirstRunTitle is the longest title a cold-screen tile shows whole.
// The tile is one line of 12px type about 125px wide; anything longer is
// cut with an ellipsis, which makes the screen look different depending
// on which films came up.
const MaxFirstRunTitle = 22

// MinFirstRunRating keeps the invitation an invitation. The vote floors
// alone admit the widely-seen-but-poorly-liked; 6.5 drops those while
// leaving every band over 150 films deep, so the screen is still drawn
// from thousands rather than from a shortlist.
const MinFirstRunRating = 6.5

const firstRunCypher = `
	UNWIND $bands AS band
	CALL (band) {
		MATCH (m:Movie)
		WHERE m.year >= band.from AND m.year <= band.to
		  AND m.poster_path IS NOT NULL
		  AND coalesce(m.vote_count, 0) >= band.votes
		  AND coalesce(m.rating, 0) >= $minRating
		  AND size(m.title) <= $maxTitle
		WITH m, rand() AS r ORDER BY r LIMIT $perBand
		RETURN collect(m) AS films
	}
	RETURN films`

// FirstRunCandidates returns up to perBand random films for each band, in
// band order. Bands with nothing to offer come back empty rather than
// missing, so the caller can still line them up with their band.
func (s *Store) FirstRunCandidates(ctx context.Context, bands []FirstRunBand, perBand int) ([][]Node, error) {
	rows := make([]map[string]any, 0, len(bands))
	for _, b := range bands {
		rows = append(rows, map[string]any{"from": b.From, "to": b.To, "votes": b.Votes})
	}
	records, err := s.run(ctx, firstRunCypher, map[string]any{
		"bands": rows, "perBand": perBand,
		"maxTitle": MaxFirstRunTitle, "minRating": MinFirstRunRating,
	})
	if err != nil {
		return nil, fmt.Errorf("graph: first-run candidates: %w", err)
	}
	out := make([][]Node, 0, len(records))
	for _, rec := range records {
		raw, _ := rec.Get("films")
		list, _ := raw.([]any)
		band := make([]Node, 0, len(list))
		for _, item := range list {
			n, ok := item.(dbtype.Node)
			if !ok {
				return nil, fmt.Errorf("graph: first-run item is %T, want Node", item)
			}
			node, err := nodeFromDB(n)
			if err != nil {
				return nil, err
			}
			band = append(band, node)
		}
		out = append(out, band)
	}
	return out, nil
}
