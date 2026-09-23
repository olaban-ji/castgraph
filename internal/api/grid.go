package api

import (
	"errors"
	"net/http"
	"strconv"

	"cinedikt/internal/graph"
)

// movieGrid is GET /grid/{id}: the searched film, the people it is built
// from, and the films a screen can show. `limit` is how many films fit
// on that screen. `before` and `after` are a film the reader already
// has, and ask for the next screen of films on that side of it.
func (s *Server) movieGrid(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The whole cast by default. `?cast=N` narrows it, which is only ever
	// a reviewer's knob: the map does not ask for one.
	castLimit, err := queryInt(r, "cast", graph.AllCast, graph.AllCast, 1000)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := queryInt(r, "limit", graph.DefaultGridLimit, 1, graph.MaxGridLimit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A film id, not a year. The page continues from that card.
	before, err := queryInt(r, "before", 0, 0, 1_000_000_000)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	after, err := queryInt(r, "after", 0, 0, 1_000_000_000)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if before > 0 && after > 0 {
		writeError(w, http.StatusBadRequest, "before and after are different requests")
		return
	}
	minRating, err := queryRating(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.ensureGridSeeded(r.Context(), id, limit); err != nil {
		s.fail(w, r, err)
		return
	}
	payload, err := s.reader.Grid(r.Context(), id, graph.GridQuery{
		CastLimit:   castLimit,
		Limit:       limit,
		Before:      before,
		After:       after,
		MinRating:   minRating,
		HideUnrated: r.URL.Query().Get("unrated") == "0",
	})
	if err != nil {
		if errors.Is(err, graph.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such movie")
			return
		}
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
	s.capture(r, "grid_loaded", nil)
}

// queryRating reads an optional floor. Empty means no floor.
func queryRating(r *http.Request) (float64, error) {
	raw := r.URL.Query().Get("min")
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v < 0 || v > 10 {
		return 0, errors.New("min must be a rating from 0 to 10")
	}
	return v, nil
}
