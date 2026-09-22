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
	mu           sync.Mutex
	crawled      map[int]bool
	networkCalls []int // depths requested
}

func (f *fakeReader) MovieCrawled(_ context.Context, movieID int) (bool, error) {
	return f.isCrawled(movieID), nil
}

func (f *fakeReader) isCrawled(movieID int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.crawled[movieID]
}

func (f *fakeReader) Pathways(_ context.Context, movieID, costars, films int, _ graph.PathwayFilter) (*graph.Pathways, error) {
	if movieID == 404 {
		return nil, graph.ErrNotFound
	}
	pw := &graph.Pathways{Movie: graph.Node{ID: graph.MovieNodeID(movieID), Type: graph.KindMovie, TMDBID: movieID}}
	for i := 0; i < costars; i++ {
		p := graph.Pathway{Person: graph.Node{ID: graph.PersonNodeID(100 + i), Type: graph.KindPerson, TMDBID: 100 + i}, Order: i}
		for j := 0; j < films; j++ {
			p.Films = append(p.Films, graph.PathwayFilm{Node: graph.Node{ID: graph.MovieNodeID(1000 + i*10 + j), Type: graph.KindMovie, TMDBID: 1000 + i*10 + j}})
		}
		pw.Cast = append(pw.Cast, p)
	}
	return pw, nil
}

func (f *fakeReader) Network(_ context.Context, movieID, depth, _ int) (*graph.Graph, error) {
	f.mu.Lock()
	f.networkCalls = append(f.networkCalls, depth)
	f.mu.Unlock()
	if movieID == 404 {
		return nil, graph.ErrNotFound
	}
	if movieID == 500 {
		return nil, errors.New("neo4j down")
	}
	return &graph.Graph{
		Nodes: []graph.Node{{ID: graph.MovieNodeID(movieID), Type: graph.KindMovie, Label: "Seed", TMDBID: movieID, Year: 1999}},
		Edges: []graph.Edge{},
	}, nil
}

func (f *fakeReader) ShortestPath(_ context.Context, fromID, toID int) (*graph.Graph, error) {
	if toID == 404 {
		return nil, graph.ErrNotFound
	}
	return &graph.Graph{
		Nodes: []graph.Node{{ID: graph.MovieNodeID(fromID)}, {ID: graph.MovieNodeID(toID)}},
		Edges: []graph.Edge{},
	}, nil
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

type fakeSearcher struct{}

func (fakeSearcher) SearchMovies(_ context.Context, q string) (*tmdb.SearchResults, error) {
	return &tmdb.SearchResults{Results: []tmdb.Movie{{ID: 603, Title: "The Matrix", ReleaseDate: "1999-03-31"}}, TotalResults: 1}, nil
}

func newTestServer(t *testing.T) (*httptest.Server, *fakeReader, *fakeExpander) {
	t.Helper()
	reader := &fakeReader{crawled: map[int]bool{603: true}}
	expander := &fakeExpander{reader: reader}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(reader, expander, fakeSearcher{}, logger).Handler())
	t.Cleanup(srv.Close)
	return srv, reader, expander
}

func do(t *testing.T, method, url string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		// The mux answers 405s itself, in plain text.
		return resp.StatusCode, nil
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("%s %s: decode: %v", method, url, err)
	}
	return resp.StatusCode, body
}

func TestNetwork(t *testing.T) {
	srv, reader, _ := newTestServer(t)
	status, body := do(t, http.MethodGet, srv.URL+"/movies/603/network?depth=2&limit=50")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	nodes := body["nodes"].([]any)
	if len(nodes) != 1 || nodes[0].(map[string]any)["id"] != "m:603" {
		t.Errorf("nodes = %v", nodes)
	}
	if _, ok := body["edges"].([]any); !ok {
		t.Errorf("edges missing or null: %v", body["edges"])
	}
	if len(reader.networkCalls) != 1 || reader.networkCalls[0] != 2 {
		t.Errorf("Network called with depths %v, want [2]", reader.networkCalls)
	}
}

func TestNetworkSeedsUncrawledMovie(t *testing.T) {
	srv, reader, expander := newTestServer(t)
	status, _ := do(t, http.MethodGet, srv.URL+"/movies/550/network")
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(expander.expanded) != 1 || expander.expanded[0] != "m:550" {
		t.Errorf("expanded = %v, want [m:550]", expander.expanded)
	}
	if !reader.isCrawled(550) {
		t.Error("movie not marked crawled after seeding")
	}
	// Second request finds it crawled and does not expand again.
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/550/network"); status != http.StatusOK {
		t.Fatalf("second status = %d", status)
	}
	if len(expander.expanded) != 1 {
		t.Errorf("expanded = %v after second request, want no new crawl", expander.expanded)
	}
}

func TestNetworkDoesNotReseedCrawledMovie(t *testing.T) {
	srv, _, expander := newTestServer(t)
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/603/network"); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(expander.expanded) != 0 {
		t.Errorf("expanded = %v, want none for an already crawled movie", expander.expanded)
	}
}

func TestNetworkConcurrentColdRequestsShareOneCrawl(t *testing.T) {
	srv, _, expander := newTestServer(t)
	release := make(chan struct{})
	expander.onExpandMovie = func() { <-release }

	const n = 5
	var wg sync.WaitGroup
	statuses := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			statuses[i], _ = do(t, http.MethodGet, srv.URL+"/movies/550/network")
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
	if len(expander.expanded) != 1 {
		t.Errorf("crawls = %d, want 1 shared across %d requests", len(expander.expanded), n)
	}
}

func TestPathwaysSeedsAndWarmsNextHop(t *testing.T) {
	reader := &fakeReader{crawled: map[int]bool{}}
	expander := &fakeExpander{reader: reader}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := New(reader, expander, fakeSearcher{}, logger)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server.StartWarming(ctx, 2)
	srv := httptest.NewServer(server.Handler())
	t.Cleanup(srv.Close)

	status, body := do(t, http.MethodGet, srv.URL+"/movies/550/pathways?costars=2&films=3")
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	cast := body["cast"].([]any)
	if len(cast) != 2 || len(cast[0].(map[string]any)["films"].([]any)) != 3 {
		t.Errorf("cast = %v", cast)
	}
	if !reader.isCrawled(550) {
		t.Error("movie not seeded before pathways")
	}

	// Each co-star's first two films get crawled in the background, best
	// films of every co-star first.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		expander.mu.Lock()
		n := len(expander.expanded)
		expander.mu.Unlock()
		if n == 5 { // 550 + 2 co-stars × 2 films
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	expander.mu.Lock()
	defer expander.mu.Unlock()
	if len(expander.expanded) != 5 {
		t.Errorf("expanded = %v, want the seed plus 4 warmed films", expander.expanded)
	}
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
	if status, _ := do(t, http.MethodGet, srv.URL+"/movies/404/pathways"); status != http.StatusNotFound {
		t.Errorf("missing movie: status = %d, want 404", status)
	}
}

func TestNetworkParamValidation(t *testing.T) {
	srv, _, _ := newTestServer(t)
	for _, url := range []string{
		"/movies/abc/network",
		"/movies/0/network",
		"/movies/603/network?depth=0",
		"/movies/603/network?depth=9",
		"/movies/603/network?limit=0",
		"/movies/603/network?limit=99999",
	} {
		if status, _ := do(t, http.MethodGet, srv.URL+url); status != http.StatusBadRequest {
			t.Errorf("GET %s: status = %d, want 400", url, status)
		}
	}
}

func TestNotFoundMapping(t *testing.T) {
	srv, _, _ := newTestServer(t)
	for _, tc := range []struct{ method, url string }{
		{http.MethodGet, "/movies/404/network"},
		{http.MethodGet, "/movies/1/path/404"},
	} {
		if status, _ := do(t, tc.method, srv.URL+tc.url); status != http.StatusNotFound {
			t.Errorf("%s %s: status = %d, want 404", tc.method, tc.url, status)
		}
	}
}

func TestInternalErrorHidesDetail(t *testing.T) {
	srv, _, _ := newTestServer(t)
	status, body := do(t, http.MethodGet, srv.URL+"/movies/500/network")
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
	srv := httptest.NewServer(New(reader, &fakeExpander{reader: reader}, fakeSearcher{}, logger).Handler())
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/movies/603/network")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	line := buf.String()
	for _, want := range []string{
		"msg=request",
		"path=/movies/603/network",
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
	if len(results) != 1 || results[0].(map[string]any)["title"] != "The Matrix" {
		t.Errorf("results = %v", results)
	}
}

func TestAnalyticsConfig(t *testing.T) {
	srv, _, _ := newTestServer(t)
	status, body := do(t, http.MethodGet, srv.URL+"/analytics-config")
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if _, ok := body["token"]; !ok {
		t.Fatal("missing token")
	}
	if host, _ := body["host"].(string); host == "" {
		t.Fatal("missing host")
	}
}
