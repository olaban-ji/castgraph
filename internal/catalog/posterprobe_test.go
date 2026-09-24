package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestAskPosterTreats404AsMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("method = %s, want HEAD", r.Method)
		}
		switch r.URL.Path {
		case "/missing.jpg":
			http.NotFound(w, r)
		case "/gone.jpg":
			w.WriteHeader(http.StatusGone)
		case "/live.jpg":
			w.WriteHeader(http.StatusOK)
		case "/down.jpg":
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	missing, known := askPoster(context.Background(), srv.URL+"/missing.jpg")
	if !missing || !known {
		t.Errorf("404 = missing %v known %v, want true true", missing, known)
	}
	missing, known = askPoster(context.Background(), srv.URL+"/gone.jpg")
	if !missing || !known {
		t.Errorf("410 = missing %v known %v, want true true", missing, known)
	}
	missing, known = askPoster(context.Background(), srv.URL+"/live.jpg")
	if missing || !known {
		t.Errorf("200 = missing %v known %v, want false true", missing, known)
	}
	missing, known = askPoster(context.Background(), srv.URL+"/down.jpg")
	if missing || known {
		t.Errorf("503 = missing %v known %v, want false false", missing, known)
	}
}

func TestRememberPosterMissingKeepsADefiniteAnswer(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	raw := srv.URL + "/cached.jpg"
	if !rememberPosterMissing(context.Background(), raw) {
		t.Fatal("a 404 was kept")
	}
	if !rememberPosterMissing(context.Background(), raw) {
		t.Fatal("the remembered 404 was kept the second time")
	}
	if hits.Load() != 1 {
		t.Errorf("the host was asked %d times, want 1", hits.Load())
	}
}

func TestFirstLiveSkipsAPosterThatIsGone(t *testing.T) {
	prev := posterMissing
	posterMissing = func(_ context.Context, raw string) bool {
		return raw == "" || raw == "https://img.test/gone.jpg"
	}
	t.Cleanup(func() { posterMissing = prev })

	// The broken poster is listed first, which is what a random draw
	// does when it lands on one. The era should still be filled.
	groups := [][]pick{
		{
			{hit: Hit{ID: "tt0133093", Poster: "https://img.test/gone.jpg"}, era: 1995},
			{hit: Hit{ID: "tt0234215", Poster: "https://img.test/live.jpg"}, era: 1995},
		},
		{
			{hit: Hit{ID: "tt0111161", Poster: ""}, era: 1980},
		},
		{
			{hit: Hit{ID: "tt0000099", Poster: "https://img.test/live.jpg"}, era: 2013},
		},
	}
	got := firstLive(context.Background(), groups)
	if len(got) != 2 || got[0].ID != "tt0234215" || got[1].ID != "tt0000099" {
		t.Fatalf("got %+v, want the two films whose posters exist, in era order", got)
	}
}
