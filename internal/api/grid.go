package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"cinedikt/internal/graph"
)

// movieGrid is GET /grid/{id}: the spine of one grid — the searched
// film, the people it is built from, and the place of every card. The
// whole spine comes at once, because a card whose place is not yet known
// is a card that will move later, and moving cards are what makes a grid
// unreadable while it loads. What the cards *say* comes from
// /grid/{id}/films, a screen at a time.
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
	if err := s.ensureGridSeeded(r.Context(), id, 0); err != nil {
		s.fail(w, r, err)
		return
	}
	payload, err := s.reader.Grid(r.Context(), id, graph.GridQuery{
		CastLimit:   castLimit,
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

// movieGridFilms is GET /grid/{id}/films?ids=1,2,3: what the cards the
// reader can see actually say. The client asks by id because the spine
// already told it which ids those are, so this never has to guess at a
// window or page around one.
func (s *Server) movieGridFilms(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ids, err := idList(r.URL.Query().Get("ids"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	films, err := s.reader.GridFilms(r.Context(), id, ids)
	if err != nil {
		if errors.Is(err, graph.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no such movie")
			return
		}
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"films": films})
}

// idList reads a comma-separated list of film ids.
func idList(raw string) ([]int, error) {
	if raw == "" {
		return nil, errors.New("ids is required")
	}
	parts := strings.Split(raw, ",")
	if len(parts) > graph.MaxGridFilms {
		return nil, errors.New("too many ids for one request")
	}
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n <= 0 {
			return nil, errors.New("ids must be film ids")
		}
		out = append(out, n)
	}
	return out, nil
}
