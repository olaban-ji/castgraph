package omdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func clientFor(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New("key", WithBaseURL(srv.URL), WithRateLimit(1000, 1000))
}

func TestLookupReadsPosterAndDate(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("apikey") != "key" {
			t.Error("the key was not sent")
		}
		w.Write([]byte(`{"Response":"True","Poster":"https://m.media-amazon.com/images/M/x.jpg","Released":"31 Mar 1999"}`))
	})
	got, err := c.Lookup(context.Background(), "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	if got.Poster != "https://m.media-amazon.com/images/M/x.jpg" {
		t.Errorf("poster = %q", got.Poster)
	}
	if want := time.Date(1999, 3, 31, 0, 0, 0, 0, time.UTC); !got.Released.Equal(want) {
		t.Errorf("released = %v, want %v", got.Released, want)
	}
}

func TestLookupRefusesAPosterCarryingTheKey(t *testing.T) {
	// img.omdbapi.com puts the key in the address. A page using one of
	// those as an <img src> publishes the key to every reader.
	for _, poster := range []string{
		"https://img.omdbapi.com/?apikey=SECRET&i=tt0133093",
		"http://www.omdbapi.com/?apikey=SECRET",
		"N/A",
		"",
		"ftp://elsewhere/x.jpg",
	} {
		c := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte(`{"Response":"True","Poster":"` + poster + `","Released":"31 Mar 1999"}`))
		})
		got, err := c.Lookup(context.Background(), "tt1")
		if err != nil {
			t.Fatal(err)
		}
		if got.Poster != "" {
			t.Errorf("poster %q was stored as %q", poster, got.Poster)
		}
	}
}

func TestAnAnsweredLookupWithNothingInItIsStillAnAnswer(t *testing.T) {
	// Otherwise this title is asked for again every night for ever.
	c := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"Response":"True","Poster":"N/A","Released":"N/A"}`))
	})
	got, err := c.Lookup(context.Background(), "tt1")
	if err != nil {
		t.Fatalf("an empty answer was read as a failure: %v", err)
	}
	if got.Poster != "" || !got.Released.IsZero() {
		t.Errorf("title = %+v", got)
	}
}

func TestParseReleased(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want bool
	}{
		{"31 Mar 1999", true},
		{"01 Jan 2020", true},
		{"N/A", false},
		{"", false},
		{"1999", false}, // a year alone stores no date; month-day stays 0
		{"Mar 1999", false},
		{"garbage", false},
	} {
		got, ok := ParseReleased(c.raw)
		if ok != c.want {
			t.Errorf("ParseReleased(%q) ok = %v, want %v", c.raw, ok, c.want)
		}
		if !c.want && !got.IsZero() {
			t.Errorf("ParseReleased(%q) gave %v", c.raw, got)
		}
	}
}

func TestSearchReturnsMoviesOnly(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("type"); got != "movie" {
			t.Errorf("type = %q, want movie", got)
		}
		w.Write([]byte(`{"Response":"True","Search":[
			{"Title":"The Matrix","Year":"1999","imdbID":"tt0133093","Type":"movie","Poster":"https://x/p.jpg"},
			{"Title":"The Matrix Reloaded","Year":"2003","imdbID":"tt0234215","Type":"movie","Poster":"N/A"},
			{"Title":"The Matrix Series","Year":"2015–2019","imdbID":"tt9","Type":"series","Poster":"N/A"},
			{"Title":"Nameless","Year":"2001","imdbID":"","Type":"movie","Poster":"N/A"}
		]}`))
	})
	hits, err := c.Search(context.Background(), "matrix")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("hits = %d, want the two movies: %+v", len(hits), hits)
	}
	if hits[0].IMDbID != "tt0133093" || hits[0].Year != 1999 || hits[0].Poster == "" {
		t.Errorf("hit = %+v", hits[0])
	}
	if hits[1].Poster != "" {
		t.Errorf("an N/A poster came through as %q", hits[1].Poster)
	}
}

func TestSearchWithNoMatchIsNotAFailure(t *testing.T) {
	for _, message := range []string{"Movie not found!", "Too many results."} {
		c := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte(`{"Response":"False","Error":"` + message + `"}`))
		})
		hits, err := c.Search(context.Background(), "zzzz")
		if err != nil {
			t.Errorf("%q was read as an error: %v", message, err)
		}
		if len(hits) != 0 {
			t.Errorf("hits = %v", hits)
		}
	}
}

func TestSearchYear(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want int
	}{{"1999", 1999}, {"2015–2019", 2015}, {"", 0}, {"N/A", 0}, {"abcd", 0}} {
		if got := searchYear(c.raw); got != c.want {
			t.Errorf("searchYear(%q) = %d, want %d", c.raw, got, c.want)
		}
	}
}

func TestSearchIsCachedSoARepeatCostsNothing(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Write([]byte(`{"Response":"True","Search":[{"Title":"The Matrix","Year":"1999","imdbID":"tt0133093","Type":"movie","Poster":"N/A"}]}`))
	}))
	defer srv.Close()
	c := New("key", WithBaseURL(srv.URL), WithRateLimit(1000, 1000), WithCache(newMemCache()))
	for i := 0; i < 3; i++ {
		if _, err := c.Search(context.Background(), "Matrix"); err != nil {
			t.Fatal(err)
		}
	}
	// And the same query in another case is the same query.
	if _, err := c.Search(context.Background(), "matrix"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Errorf("OMDb was called %d times for one repeated query", calls)
	}
}

func TestOptionsDoNotDependOnTheirOrder(t *testing.T) {
	// WithHTTPTimeout used to replace the whole http.Client, so giving
	// it after WithConnections silently threw the pool away and left
	// the backfill on two connections.
	for _, c := range []struct {
		name string
		opts []Option
	}{
		{"connections then timeout", []Option{WithConnections(24), WithHTTPTimeout(9 * time.Second)}},
		{"timeout then connections", []Option{WithHTTPTimeout(9 * time.Second), WithConnections(24)}},
	} {
		t.Run(c.name, func(t *testing.T) {
			client := New("key", c.opts...)
			if client.http.Timeout != 9*time.Second {
				t.Errorf("timeout = %v", client.http.Timeout)
			}
			tr, ok := client.http.Transport.(*http.Transport)
			if !ok {
				t.Fatalf("transport = %T, want the pooled one", client.http.Transport)
			}
			if tr.MaxIdleConnsPerHost != 24 {
				t.Errorf("MaxIdleConnsPerHost = %d, want 24", tr.MaxIdleConnsPerHost)
			}
		})
	}
}
