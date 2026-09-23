package api

import (
	"errors"
	"net/http"

	"cinedikt/internal/graph"
)

// movieGrid is GET /grid/{id}: the searched film, the people it is built
// from — every director and the top-billed cast — and every film those
// people made, in one answer. The map is one step deep, so this is the
// whole map: there is no second request to grow it.
func (s *Server) movieGrid(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	castLimit, err := queryInt(r, "cast", graph.DefaultCastLimit, 1, MaxCostars)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.ensureSeeded(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	payload, err := s.reader.Grid(r.Context(), id, castLimit)
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
