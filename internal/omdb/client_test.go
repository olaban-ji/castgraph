package omdb

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.HandlerFunc, opts ...Option) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New("k3y", append([]Option{WithBaseURL(srv.URL + "/")}, opts...)...)
}

func TestIMDbRating(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("i") != "tt0133093" || r.URL.Query().Get("apikey") != "k3y" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		w.Write([]byte(`{"Title":"The Matrix","imdbRating":"8.7","imdbVotes":"2,081,234","imdbID":"tt0133093","Response":"True"}`))
	})
	got, err := c.IMDbRating(context.Background(), "tt0133093")
	if err != nil {
		t.Fatalf("IMDbRating: %v", err)
	}
	if want := (Rating{Value: 8.7, Votes: 2081234}); got != want {
		t.Errorf("rating = %+v, want %+v", got, want)
	}
}

func TestNotFoundAndNA(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"unknown id", `{"Response":"False","Error":"Incorrect IMDb ID."}`},
		{"error not found", `{"Response":"False","Error":"Movie not found!"}`},
		{"no rating yet", `{"Title":"Unreleased","imdbRating":"N/A","imdbVotes":"N/A","Response":"True"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(tt.body)) })
			_, err := c.IMDbRating(context.Background(), "tt0000000")
			if tt.name == "unknown id" {
				if err == nil || errors.Is(err, ErrNotFound) {
					t.Errorf("error = %v, want a non-ErrNotFound error", err)
				}
				return
			}
			if !errors.Is(err, ErrNotFound) {
				t.Errorf("error = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestQuotaPausesLookups(t *testing.T) {
	var hits atomic.Int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"Response":"False","Error":"Request limit reached!"}`))
	})
	now := time.Now()
	c.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if _, err := c.IMDbRating(context.Background(), "tt0133093"); !errors.Is(err, ErrQuota) {
			t.Fatalf("call %d: error = %v, want ErrQuota", i, err)
		}
	}
	if hits.Load() != 1 {
		t.Errorf("server hits = %d, want 1: lookups must pause after a quota error", hits.Load())
	}
	// After the pause the client tries again.
	now = now.Add(QuotaPause + time.Second)
	c.IMDbRating(context.Background(), "tt0133093")
	if hits.Load() != 2 {
		t.Errorf("server hits = %d after the pause, want 2", hits.Load())
	}
}

func TestCacheServesRepeatsIncludingMisses(t *testing.T) {
	var hits atomic.Int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Query().Get("i") == "tt1" {
			w.Write([]byte(`{"imdbRating":"7.1","imdbVotes":"10","Response":"True"}`))
			return
		}
		w.Write([]byte(`{"imdbRating":"N/A","Response":"True"}`))
	}, WithCache(newMemCache()))

	for i := 0; i < 2; i++ {
		if _, err := c.IMDbRating(context.Background(), "tt1"); err != nil {
			t.Fatal(err)
		}
		if _, err := c.IMDbRating(context.Background(), "tt2"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("tt2 error = %v, want ErrNotFound", err)
		}
	}
	if hits.Load() != 2 {
		t.Errorf("server hits = %d, want 2 (one per id)", hits.Load())
	}
}

type memCache struct {
	mu sync.Mutex
	m  map[string][]byte
}

func newMemCache() *memCache {
	return &memCache{m: map[string][]byte{}}
}

func (c *memCache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.m[key]
	return b, ok
}

func (c *memCache) Set(key string, body []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = append([]byte(nil), body...)
	return nil
}
