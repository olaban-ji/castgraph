package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"cinedikt/internal/tmdb"
)

type fakeLookup struct {
	found tmdb.Found
	err   error
	calls atomic.Int32
}

func (f *fakeLookup) FindByIMDb(context.Context, string) (tmdb.Found, error) {
	f.calls.Add(1)
	return f.found, f.err
}

type fakeKeeper struct {
	got   tmdb.Found
	calls atomic.Int32
}

func (f *fakeKeeper) KeepTMDbPoster(_ context.Context, _ string, got tmdb.Found) error {
	f.calls.Add(1)
	f.got = got
	return nil
}

func askStandIn(t *testing.T, s *CatalogServer, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/posters/"+id, nil)
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	s.posterStandIn(rec, req)
	return rec
}

func TestPosterStandInReturnsWhatTMDbHas(t *testing.T) {
	const poster = "https://image.tmdb.org/t/p/w780/abc.jpg"
	lookup := &fakeLookup{found: tmdb.Found{ID: 603, Poster: poster}}
	keep := &fakeKeeper{}
	s := NewCatalogServer(nil, nil)
	s.WithPosterStandIn(lookup, keep)

	rec := askStandIn(t, s, "tt0133093")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), poster) {
		t.Fatalf("body = %s", rec.Body)
	}
	if keep.calls.Load() != 1 || keep.got.Poster != poster {
		t.Errorf("kept %+v, %d times", keep.got, keep.calls.Load())
	}
}

func TestPosterStandInKeepsAMissWithoutAPicture(t *testing.T) {
	lookup := &fakeLookup{err: tmdb.ErrNotFound}
	keep := &fakeKeeper{}
	s := NewCatalogServer(nil, nil)
	s.WithPosterStandIn(lookup, keep)

	rec := askStandIn(t, s, "tt0133093")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if keep.calls.Load() != 1 || keep.got.Poster != "" {
		t.Errorf("kept %+v", keep.got)
	}
}

func TestPosterStandInDoesNotKeepAFault(t *testing.T) {
	lookup := &fakeLookup{err: errors.New("tmdb down")}
	keep := &fakeKeeper{}
	s := NewCatalogServer(nil, nil)
	s.WithPosterStandIn(lookup, keep)

	rec := askStandIn(t, s, "tt0133093")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if keep.calls.Load() != 0 {
		t.Error("a fault was written down as an answer")
	}
}

func TestPosterStandInRejectsABadID(t *testing.T) {
	lookup := &fakeLookup{}
	s := NewCatalogServer(nil, nil)
	s.WithPosterStandIn(lookup, &fakeKeeper{})
	if rec := askStandIn(t, s, "nope"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if lookup.calls.Load() != 0 {
		t.Error("a bad id was asked of tmdb")
	}
}
