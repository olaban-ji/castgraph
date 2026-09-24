package catalog

import (
	"context"
	"fmt"
	"strings"
)

// Hit is one search result, already known to be a movie this catalog can
// build a map from.
type Hit struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Year   int    `json:"year"`
	Poster string `json:"poster,omitempty"`
	Votes  int    `json:"-"`
}

// MinQuery is the shortest query worth asking about. Two characters
// matches half the catalog and tells the reader nothing.
const MinQuery = 2

// Search finds movies by title, out of the catalog itself.
//
// Every movie IMDb knows about is already on disk, so there is nothing
// an outside search could add except a network round trip on every
// keystroke and a dependency on someone else's uptime.
//
// Ranking is what makes a search feel right, and it is the one thing a
// title match cannot do on its own: "matrix" has to put The Matrix
// above the thirty other films with the word in the title.
//
// Votes do almost all of that work — they are the best proxy the
// dataset has for "the one they meant". An exact title is worth a great
// deal on top, but as a multiplier rather than an absolute: there is a
// film called "Godfather", and it is not the one anybody means.
//
// A bonus for titles *starting* with the query was tried and removed:
// it put "Matrix Zone" above "The Matrix", because an article at the
// front is enough to lose a prefix match and no number of votes could
// win it back.
func (s *Store) Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	query = strings.TrimSpace(query)
	if len(query) < MinQuery {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()

	lower := strings.ToLower(query)
	rows, err := s.pool.Query(ctx, `
		SELECT t.tconst, t.primary_title, coalesce(t.start_year, 0),
		       coalesce(p.poster_url, ''), coalesce(r.num_votes, 0)
		FROM `+Live+`.titles t
		LEFT JOIN `+Live+`.ratings r USING (tconst)
		LEFT JOIN meta.posters p USING (tconst)
		WHERE (lower(t.primary_title) LIKE $1 OR lower(t.original_title) LIKE $1)
		  AND `+gridFilm+`
		  AND EXISTS (SELECT 1 FROM `+Live+`.principals pr WHERE pr.tconst = t.tconst)
		ORDER BY
		    -- Votes decide, except that typing a title in full counts
		    -- for a great deal. A multiplier rather than a rank: an
		    -- obscure film actually called "Godfather" should not
		    -- outrank The Godfather, but a small film typed in full
		    -- should beat a blockbuster that merely contains the words.
		    coalesce(r.num_votes, 0)
		      * CASE WHEN lower(t.primary_title) = $2 THEN 50 ELSE 1 END DESC,
		    t.tconst
		LIMIT $3`,
		"%"+lower+"%", lower, limit)
	if err != nil {
		return nil, fmt.Errorf("catalog: search: %w", err)
	}
	defer rows.Close()

	out := make([]Hit, 0, limit)
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.ID, &h.Title, &h.Year, &h.Poster, &h.Votes); err != nil {
			return nil, fmt.Errorf("catalog: scan hit: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// FirstRunCount is how many movies the cold screen offers.
const FirstRunCount = 8

// FirstRun picks movies to open a map from, a different set each visit.
//
// They come one per era from a pool ranked at import time, so the screen
// shows how far apart two movies can be and still be two movies apart —
// and so nobody arrives to the same eight twice.
//
// The ranking is not done here. Choosing the best known movie of an era
// from the whole catalog means sorting a quarter of a million rows to
// return one, and there is no index that helps: the year is on `titles`
// and the votes are on `ratings`. The pool settles that once per
// generation; this reads a couple of thousand rows and picks.
func (s *Store) FirstRun(ctx context.Context, _ int) ([]Hit, error) {
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (f.era)
		       t.tconst, t.primary_title, coalesce(t.start_year, 0),
		       p.poster_url, f.num_votes
		FROM `+Live+`.first_run f
		JOIN `+Live+`.titles t USING (tconst)
		JOIN meta.posters p USING (tconst)
		-- A tile with no picture is a grey box, so only the candidates
		-- the backfill has reached are offered.
		WHERE p.poster_url IS NOT NULL
		  AND (p.released IS NULL OR p.released <= current_date)
		ORDER BY f.era, random()`)
	if err != nil {
		return nil, fmt.Errorf("catalog: first run: %w", err)
	}
	defer rows.Close()

	out := make([]Hit, 0, FirstRunCount)
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.ID, &h.Title, &h.Year, &h.Poster, &h.Votes); err != nil {
			return nil, fmt.Errorf("catalog: scan first run: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
