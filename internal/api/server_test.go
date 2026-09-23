package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"cinedikt/internal/crawl"
	"cinedikt/internal/graph"
	"cinedikt/internal/tmdb"
)

type fakeReader struct {
	mu            sync.Mutex
	crawled       map[int]bool
	crawledChecks int
	lastFilter    graph.PathwayFilter
}

func (f *fakeReader) filter() graph.PathwayFilter {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastFilter
}

func (f *fakeReader) MovieCrawled(_ context.Context, movieID int) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.crawledChecks++
	return f.crawled[movieID], nil
}

func (f *fakeReader) isCrawled(movieID int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.crawled[movieID]
}

func (f *fakeReader) checks() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.crawledChecks
}

func (f *fakeReader) Pathways(_ context.Context, movieID, costars, films int, filter graph.PathwayFilter) (*graph.Pathways, error) {
	f.mu.Lock()
	f.lastFilter = filter
	f.mu.Unlock()
	switch movieID {
	case 404:
		return nil, graph.ErrNotFound
	case 500:
		return nil, errors.New("neo4j down")
	}
	pw := &graph.Pathways{Movie: graph.Node{ID: graph.MovieNodeID(movieID), Type: graph.KindMovie, TMDBID: movieID}}
	for i := range costars {
		p := graph.Pathway{Person: graph.Node{ID: graph.PersonNodeID(100 + i), Type: graph.KindPerson, TMDBID: 100 + i}, Order: i}
		for j := range films {
			p.Films = append(p.Films, graph.PathwayFilm{Node: graph.Node{ID: graph.MovieNodeID(1000 + i*10 + j), Type: graph.KindMovie, TMDBID: 1000 + i*10 + j}})
		}
		pw.Cast = append(pw.Cast, p)
	}
	return pw, nil
}

type fakeExpander struct {
	mu       sync.Mutex
	expanded []string
	// onExpandMovie, if set, runs inside ExpandMovie (to simulate a slow crawl).
	onExpandMovie func()
	reader        *fakeReader
}

func (f *fakeExpander) ExpandMovie(_ context.Context, movieID, depth int) (*crawl.Stats, error) {
	if movieID == 404 {
		return nil, tmdb.ErrNotFound
	}
	if f.onExpandMovie != nil {
		f.onExpandMovie()
	}
	f.mu.Lock()
	f.expanded = append(f.expanded, graph.MovieNodeID(movieID))
	f.mu.Unlock()
	// A real crawl marks the movie crawled in the graph.
	f.reader.mu.Lock()
	f.reader.crawled[movieID] = true
	f.reader.mu.Unlock()
	return &crawl.Stats{}, nil
}

func (f *fakeExpander) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.expanded)
}

type fakeSearcher struct{}

func (fakeSearcher) SearchMovies(_ context.Context, q string) (*tmdb.SearchResults, error) {
	return &tmdb.SearchResults{
		Results:      []tmdb.Movie{{ID: 603, Title: "The Matrix", ReleaseDate: "1999-03-31", PosterPath: "/m.jpg"}},
		TotalResults: 1,
	}, nil
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// testLimits are generous on rate (so unrelated tests are never throttled)
// and quick to give up on a slot.
func testLimits() Limits {
	return Limits{RequestsPerSecond: 1000, Burst: 1000, ColdCrawls: 8, SlotWait: 100 * time.Millisecond}
}

func newTestServerWith(t *testing.T, limits Limits, crawled ...int) (*httptest.Server, *fakeReader, *fakeExpander) {
	t.Helper()
	reader := &fakeReader{crawled: map[int]bool{}}
	for _, id := range crawled {
		reader.crawled[id] = true
	}
	expander := &fakeExpander{reader: reader}
	srv := httptest.NewServer(NewWithLimits(reader, expander, fakeSearcher{}, limits, discardLogger()).Handler())
	t.Cleanup(srv.Close)
	return srv, reader, expander
}

func newTestServer(t *testing.T) (*httptest.Server, *fakeReader, *fakeExpander) {
	t.Helper()
	return newTestServerWith(t, testLimits(), 603)
}

func do(t *testing.T, method, url string) (int, map[string]any) {
	t.Helper()
	status, body, _ := doWithHeaders(t, method, url, nil)
	return status, body
}

func doWithHeaders(t *testing.T, method, url string, headers map[string]string) (int, map[string]any, http.Header) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		// The mux answers 405s itself, in plain text.
		return resp.StatusCode, nil, resp.Header
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("%s %s: decode: %v", method, url, err)
	}
	return resp.StatusCode, body, resp.Header
}

func TestPathways(t *testing.T) {
	srv, _, _ := newTestServer(t)
	status, body := do(t, http.MethodGet, srv.URL+"/movies/603/pathways?costars=2&films=3")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if movie, _ := body["movie"].(map[string]any); movie["id"] != "m:603" {
		t.Errorf("movie = %v", body["movie"])
	}
	cast := body["cast"].([]any)
	if len(cast) != 2 || len(cast[0].(map[string]any)["films"].([]any)) != 3 {
		t.Errorf("cast = %v", cast)
	}
}

func TestPathwaysSeedsUncrawledMovie(t *testing.T) {
	srv, reader, expander := newTestServer(t)
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/550/pathways"); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if expander.count() != 1 {
		t.Errorf("expanded = %v, want one crawl", expander.expanded)
	}
	if !reader.isCrawled(550) {
		t.Error("movie not marked crawled after seeding")
	}
	// Second request finds it crawled and does not expand again.
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/550/pathways"); status != http.StatusOK {
		t.Fatalf("second status = %d", status)
	}
	if expander.count() != 1 {
		t.Errorf("expanded = %v after second request, want no new crawl", expander.expanded)
	}
}

func TestPathwaysDoesNotReseedCrawledMovie(t *testing.T) {
	srv, _, expander := newTestServer(t)
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/603/pathways"); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if expander.count() != 0 {
		t.Errorf("expanded = %v, want none for an already crawled movie", expander.expanded)
	}
}

func TestConcurrentColdRequestsShareOneCrawl(t *testing.T) {
	srv, _, expander := newTestServer(t)
	release := make(chan struct{})
	expander.onExpandMovie = func() { <-release }

	const n = 5
	var wg sync.WaitGroup
	statuses := make([]int, n)
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			statuses[i], _ = do(t, http.MethodGet, srv.URL+"/movies/550/pathways")
		}(i)
	}
	// Let every request reach the singleflight before the crawl completes.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	for i, st := range statuses {
		if st != http.StatusOK {
			t.Errorf("request %d: status = %d", i, st)
		}
	}
	if expander.count() != 1 {
		t.Errorf("crawls = %d, want 1 shared across %d requests", expander.count(), n)
	}
}

func TestColdCrawlsAreCappedAndShedLoad(t *testing.T) {
	limits := testLimits()
	limits.ColdCrawls = 1
	srv, _, expander := newTestServerWith(t, limits)
	release := make(chan struct{})
	expander.onExpandMovie = func() { <-release }

	// One crawl takes the only slot and holds it.
	started := make(chan struct{})
	go func() {
		close(started)
		do(t, http.MethodGet, srv.URL+"/movies/550/pathways")
	}()
	<-started
	time.Sleep(50 * time.Millisecond)

	// A different cold movie cannot get a slot and is turned away rather
	// than queueing behind a rate-limited TMDb.
	status, body, header := doWithHeaders(t, http.MethodGet, srv.URL+"/movies/551/pathways", nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body %v", status, body)
	}
	if header.Get("Retry-After") == "" {
		t.Error("503 without a Retry-After header")
	}
	close(release)

	// The slot is released, so the next request is served.
	waitFor(t, time.Second, func() bool {
		status, _ := do(t, http.MethodGet, srv.URL+"/movies/552/pathways")
		return status == http.StatusOK
	})
}

func TestRateLimitTurnsAwayAFlood(t *testing.T) {
	limits := testLimits()
	limits.RequestsPerSecond = 1
	limits.Burst = 3
	srv, _, _ := newTestServerWith(t, limits, 603)

	var limited int
	var retryAfter string
	for range 10 {
		status, _, header := doWithHeaders(t, http.MethodGet, srv.URL+"/movies/603/pathways", nil)
		if status == http.StatusTooManyRequests {
			limited++
			retryAfter = header.Get("Retry-After")
		}
	}
	if limited == 0 {
		t.Fatal("ten requests against a burst of three were all served")
	}
	if retryAfter == "" {
		t.Error("429 without a Retry-After header")
	}
}

func TestRateLimitIsPerClient(t *testing.T) {
	limits := testLimits()
	limits.RequestsPerSecond = 1
	limits.Burst = 2
	srv, _, _ := newTestServerWith(t, limits, 603)

	noisy := map[string]string{"X-Forwarded-For": "203.0.113.1"}
	for range 5 {
		doWithHeaders(t, http.MethodGet, srv.URL+"/movies/603/pathways", noisy)
	}
	// A second client still has its full burst.
	quiet := map[string]string{"X-Forwarded-For": "203.0.113.2"}
	status, _, _ := doWithHeaders(t, http.MethodGet, srv.URL+"/movies/603/pathways", quiet)
	if status != http.StatusOK {
		t.Errorf("second client: status = %d, want 200 — one client must not throttle another", status)
	}
}

func TestHealthzReportsDependencies(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	server := NewWithLimits(reader, &fakeExpander{reader: reader}, fakeSearcher{}, testLimits(), discardLogger())
	server.WithHealth(
		Dependency{Name: "neo4j", Ping: func(context.Context) error { return nil }},
		Dependency{Name: "redis", Ping: func(context.Context) error { return errors.New("connection refused") }},
	)
	srv := httptest.NewServer(server.Handler())
	t.Cleanup(srv.Close)

	status, body := do(t, http.MethodGet, srv.URL+"/healthz")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when a dependency is down", status)
	}
	if body["neo4j"] != "ok" || body["redis"] != "unreachable" || body["status"] != "degraded" {
		t.Errorf("body = %v", body)
	}
}

func TestHealthzOKWhenEverythingAnswers(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	server := NewWithLimits(reader, &fakeExpander{reader: reader}, fakeSearcher{}, testLimits(), discardLogger())
	server.WithHealth(Dependency{Name: "neo4j", Ping: func(context.Context) error { return nil }})
	srv := httptest.NewServer(server.Handler())
	t.Cleanup(srv.Close)

	status, body := do(t, http.MethodGet, srv.URL+"/healthz")
	if status != http.StatusOK || body["status"] != "ok" || body["neo4j"] != "ok" {
		t.Errorf("status = %d, body = %v", status, body)
	}
}

func TestPathwaysWarmsNextHopOffTheRequestPath(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	expander := &fakeExpander{reader: reader}
	server := NewWithLimits(reader, expander, fakeSearcher{}, testLimits(), discardLogger())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server.StartWarming(ctx, 2)
	srv := httptest.NewServer(server.Handler())
	t.Cleanup(srv.Close)

	status, body := do(t, http.MethodGet, srv.URL+"/movies/550/pathways?costars=2&films=3")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	if !reader.isCrawled(550) {
		t.Error("movie not seeded before pathways")
	}

	// Each co-star's first two films get crawled in the background, best
	// films of every co-star first.
	waitFor(t, 2*time.Second, func() bool { return expander.count() == 5 }) // 550 + 2 co-stars × 2 films
	for _, id := range []int{1000, 1010, 1001, 1011} {
		if !reader.isCrawled(id) {
			t.Errorf("film %d not warmed", id)
		}
	}
	if reader.isCrawled(1002) {
		t.Error("third film warmed; only the first two per co-star should be")
	}
}

func TestNextHopOrder(t *testing.T) {
	film := func(id int) graph.PathwayFilm { return graph.PathwayFilm{Node: graph.Node{TMDBID: id}} }
	pw := &graph.Pathways{Cast: []graph.Pathway{
		{Films: []graph.PathwayFilm{film(1), film(2), film(3)}},
		{Films: []graph.PathwayFilm{film(4)}},
		{Films: []graph.PathwayFilm{film(5), film(6)}},
	}}
	got := nextHop(pw)
	want := []int{1, 4, 5, 2, 6}
	if len(got) != len(want) {
		t.Fatalf("nextHop = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("nextHop = %v, want %v", got, want)
		}
	}
}

func TestPathwaysParamValidation(t *testing.T) {
	srv, _, _ := newTestServer(t)
	for _, url := range []string{
		"/movies/abc/pathways",
		"/movies/0/pathways",
		"/movies/603/pathways?costars=0",
		"/movies/603/pathways?costars=999",
		"/movies/603/pathways?films=abc",
		"/movies/603/pathways?billing=-1",
		"/movies/603/pathways?min_votes=x",
	} {
		if status, _ := do(t, http.MethodGet, srv.URL+url); status != http.StatusBadRequest {
			t.Errorf("GET %s: status = %d, want 400", url, status)
		}
	}
}

func TestNotFoundMapping(t *testing.T) {
	srv, _, _ := newTestServerWith(t, testLimits(), 404)
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/404/pathways"); status != http.StatusNotFound {
		t.Errorf("missing movie: status = %d, want 404", status)
	}
}

func TestInternalErrorHidesDetail(t *testing.T) {
	srv, _, _ := newTestServerWith(t, testLimits(), 500)
	status, body := do(t, http.MethodGet, srv.URL+"/movies/500/pathways")
	if status != http.StatusInternalServerError {
		t.Errorf("internal failure: status = %d, want 500", status)
	}
	if msg, _ := body["error"].(string); strings.Contains(msg, "neo4j") {
		t.Errorf("internal error detail leaked to client: %q", msg)
	}
}

func TestRequestLogIncludesStatusDurationAndSize(t *testing.T) {
	var buf bytes.Buffer
	reader := &fakeReader{crawled: map[int]bool{603: true}}
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	srv := httptest.NewServer(NewWithLimits(reader, &fakeExpander{reader: reader}, fakeSearcher{}, testLimits(), logger).Handler())
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/movies/603/pathways")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	line := buf.String()
	for _, want := range []string{
		"msg=request",
		"path=/movies/603/pathways",
		"status=200",
		"duration=",
		"bytes=" + strconv.Itoa(len(body)),
	} {
		if !strings.Contains(line, want) {
			t.Errorf("log line %q lacks %q", line, want)
		}
	}
}

func TestSearch(t *testing.T) {
	srv, _, _ := newTestServer(t)
	if status, _ := do(t, http.MethodGet, srv.URL+"/search/movies"); status != http.StatusBadRequest {
		t.Errorf("missing q: status = %d, want 400", status)
	}
	status, body := do(t, http.MethodGet, srv.URL+"/search/movies?q=matrix")
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	results := body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("results = %v", results)
	}
	hit := results[0].(map[string]any)
	if hit["title"] != "The Matrix" {
		t.Errorf("results = %v", results)
	}
	if poster, _ := hit["poster"].(string); !strings.HasPrefix(poster, graph.PosterBaseURL) {
		t.Errorf("search hit has no poster url: %v", hit)
	}
}

func TestRemovedEndpointsAreGone(t *testing.T) {
	srv, _, _ := newTestServer(t)
	for _, url := range []string{"/movies/603/network", "/movies/603/path/550"} {
		if status, _ := do(t, http.MethodGet, srv.URL+url); status != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404 — the map does not use it and it can hammer Neo4j", url, status)
		}
	}
}

func TestAnalyticsConfig(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	server := NewWithLimits(reader, &fakeExpander{reader: reader}, fakeSearcher{}, testLimits(), discardLogger())
	server.WithAnalytics(AnalyticsConfig{Token: "phc_test", Host: "https://us.i.posthog.com"})
	srv := httptest.NewServer(server.Handler())
	t.Cleanup(srv.Close)

	status, body := do(t, http.MethodGet, srv.URL+"/analytics-config")
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if body["token"] != "phc_test" || body["host"] != "https://us.i.posthog.com" {
		t.Errorf("body = %v", body)
	}
}

func TestClientIPTrustsTheProxyNotTheCaller(t *testing.T) {
	cases := map[string]struct {
		forwarded string
		remote    string
		want      string
	}{
		"no proxy":                    {"", "198.51.100.7:4321", "198.51.100.7"},
		"one proxy":                   {"203.0.113.5", "10.0.0.1:80", "203.0.113.5"},
		"caller forged its own entry": {"1.2.3.4, 203.0.113.5", "10.0.0.1:80", "203.0.113.5"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r, err := http.NewRequest(http.MethodGet, "/", nil)
			if err != nil {
				t.Fatal(err)
			}
			r.RemoteAddr = tc.remote
			if tc.forwarded != "" {
				r.Header.Set("X-Forwarded-For", tc.forwarded)
			}
			if got := clientIP(r); got != tc.want {
				t.Errorf("clientIP = %q, want %q: a caller must not pick its own rate-limit bucket", got, tc.want)
			}
		})
	}
}

func waitFor(t *testing.T, limit time.Duration, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", limit)
}

// The map asks for the same billing and vote floor on every request, so
// the API holds them rather than making the client restate them.
func TestPathwaysDefaultsThePoolTheMapWants(t *testing.T) {
	srv, reader, _ := newTestServer(t)
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/603/pathways"); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	want := graph.PathwayFilter{MaxBilling: DefaultBilling, MinVotes: DefaultMinVotes}
	if got := reader.filter(); got != want {
		t.Errorf("filter with no query = %+v, want %+v", got, want)
	}

	// Stated explicitly, they still win: the default is a default.
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/603/pathways?billing=3&min_votes=0&person=525"); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	want = graph.PathwayFilter{MaxBilling: 3, MinVotes: 0, PersonID: 525}
	if got := reader.filter(); got != want {
		t.Errorf("filter with a query = %+v, want %+v", got, want)
	}
}
