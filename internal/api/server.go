// Package api serves the graph over HTTP as node/edge JSON for the frontend.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/posthog/posthog-go"
	"golang.org/x/sync/singleflight"

	"cinedikt/internal/analytics"
	"cinedikt/internal/crawl"
	"cinedikt/internal/graph"
	"cinedikt/internal/tmdb"
)

// Reader is the part of the graph store the API queries.
type Reader interface {
	MovieCrawled(ctx context.Context, movieID int) (bool, error)
	Network(ctx context.Context, movieID, depth, limit int) (*graph.Graph, error)
	Pathways(ctx context.Context, movieID, costars, films int, f graph.PathwayFilter) (*graph.Pathways, error)
	ShortestPath(ctx context.Context, fromID, toID int) (*graph.Graph, error)
}

// Expander is the part of the crawler the API drives.
type Expander interface {
	ExpandMovie(ctx context.Context, movieID, depth int) (*crawl.Stats, error)
}

// Searcher finds seed movies by title.
type Searcher interface {
	SearchMovies(ctx context.Context, query string) (*tmdb.SearchResults, error)
}

// Server holds the handlers' dependencies.
type Server struct {
	reader   Reader
	expander Expander
	searcher Searcher
	logger   *slog.Logger

	// seeds collapses concurrent first requests for the same uncrawled
	// movie into one crawl.
	seeds singleflight.Group
	// warm, when started, crawls the films a pathways response points at
	// before the client asks for them.
	warm *warmer
}

// Limits on query parameters and on-demand crawling.
const (
	DefaultLimit = 200
	MaxLimit     = 2000
	// SeedTimeout bounds the depth-1 crawl a cold /network request triggers.
	SeedTimeout = 90 * time.Second
	// Pathway limits.
	DefaultCostars = 6
	MaxCostars     = 30
	DefaultFilms   = 5
	MaxFilms       = 20
)

// New builds the server. A nil logger uses slog.Default.
func New(reader Reader, expander Expander, searcher Searcher, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{reader: reader, expander: expander, searcher: searcher, logger: logger}
}

// StartWarming runs workers that pre-crawl the films handed out by
// /pathways until ctx ends. Without it every hop is crawled on demand.
func (s *Server) StartWarming(ctx context.Context, workers int) {
	s.warm = newWarmer(s.reader, s.expander, s.logger)
	go s.warm.run(ctx, workers)
}

// Handler returns the routed HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /analytics-config", analyticsConfig)
	mux.HandleFunc("GET /search/movies", s.searchMovies)
	mux.HandleFunc("GET /movies/{id}/network", s.movieNetwork)
	mux.HandleFunc("GET /movies/{id}/pathways", s.moviePathways)
	mux.HandleFunc("GET /movies/{id}/path/{other}", s.moviePath)
	return s.logRequests(posthog.NewRequestContextMiddleware(mux))
}

// searchMovies proxies a title search to TMDb so a client can pick a seed.
func (s *Server) searchMovies(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	res, err := s.searcher.SearchMovies(r.Context(), q)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	type hit struct {
		ID          int    `json:"id"`
		Title       string `json:"title"`
		ReleaseDate string `json:"release_date"`
	}
	hits := make([]hit, 0, len(res.Results))
	for _, m := range res.Results {
		hits = append(hits, hit{ID: m.ID, Title: m.Title, ReleaseDate: m.ReleaseDate})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits, "total": res.TotalResults})
	s.capture(r, "movie_search_completed", posthog.NewProperties().
		Set("result_count", len(hits)))
}

// movieNetwork is GET /movies/{id}/network?depth=1&limit=200. A movie whose
// cast has never been fetched is crawled to depth 1 first, so the graph
// fills itself as people browse; deeper levels stay opt-in via expand.
func (s *Server) movieNetwork(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	depth, err := queryInt(r, "depth", 1, 1, graph.MaxNetworkDepth)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := queryInt(r, "limit", DefaultLimit, 1, MaxLimit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.ensureSeeded(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	g, err := s.reader.Network(r.Context(), id, depth, limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
	s.capture(r, "movie_network_viewed", posthog.NewProperties().
		Set("movie_id", id).
		Set("depth", depth).
		Set("limit", limit))
}

// ensureSeeded crawls movieID to depth 1 unless its cast is already in the
// graph. Concurrent callers share one crawl, which runs detached from any
// single request's context so one client disconnecting does not abort it
// for the others.
func (s *Server) ensureSeeded(ctx context.Context, movieID int) error {
	crawled, err := s.reader.MovieCrawled(ctx, movieID)
	if err != nil || crawled {
		return err
	}
	ch := s.seeds.DoChan(strconv.Itoa(movieID), func() (any, error) {
		crawlCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), SeedTimeout)
		defer cancel()
		if s.warm != nil {
			s.warm.busy.Add(1)
			defer s.warm.busy.Add(-1)
		}
		s.logger.Info("seeding movie on demand", "movie", movieID)
		_, err := s.expander.ExpandMovie(crawlCtx, movieID, 1)
		return nil, err
	})
	select {
	case res := <-ch:
		return res.Err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// moviePathways is GET /movies/{id}/pathways?costars=6&films=5&billing=5&min_votes=200:
// the lean expansion of one stop — its lead cast, its director, and each
// person's most voted other films — which is all the map needs to grow
// from it. billing and min_votes (both optional) drop connections through
// minor roles and obscure titles; directors ignore billing. The movie is
// crawled first if it never was, and the films returned are queued for
// warming so the reader's next hop is already in the graph.
func (s *Server) moviePathways(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	costars, err := queryInt(r, "costars", DefaultCostars, 1, MaxCostars)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	films, err := queryInt(r, "films", DefaultFilms, 1, MaxFilms)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	billing, err := queryInt(r, "billing", 0, 0, 1000)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	minVotes, err := queryInt(r, "min_votes", 0, 0, 1_000_000)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.ensureSeeded(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	pw, err := s.reader.Pathways(r.Context(), id, costars, films, graph.PathwayFilter{MaxBilling: billing, MinVotes: minVotes})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if s.warm != nil {
		s.warm.enqueue(context.WithoutCancel(r.Context()), nextHop(pw))
	}
	writeJSON(w, http.StatusOK, pw)
	s.capture(r, "movie_pathways_opened", posthog.NewProperties().
		Set("movie_id", id).
		Set("costars", costars).
		Set("films", films).
		Set("billing", billing).
		Set("min_votes", minVotes))
}

// warmFilmsPerCostar is how many of each co-star's films are warmed. The
// map places a co-star's best film not already on it, so the first one or
// two are what will be asked for next.
const warmFilmsPerCostar = 2

// nextHop lists the films a client is likely to expand next, most likely
// first: every co-star's best film, then every co-star's second.
func nextHop(pw *graph.Pathways) []int {
	var ids []int
	for rank := 0; rank < warmFilmsPerCostar; rank++ {
		for _, c := range pw.Cast {
			if rank < len(c.Films) {
				ids = append(ids, c.Films[rank].TMDBID)
			}
		}
	}
	return ids
}

// moviePath is GET /movies/{id}/path/{other}.
func (s *Server) moviePath(w http.ResponseWriter, r *http.Request) {
	from, err := pathInt(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	to, err := pathInt(r, "other")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	g, err := s.reader.ShortestPath(r.Context(), from, to)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// analyticsConfig is the public PostHog project token and host for the map.
// The token is a write-only key, the same class of credential posthog-js
// would otherwise bake in at build time.
func analyticsConfig(w http.ResponseWriter, _ *http.Request) {
	host := os.Getenv("POSTHOG_HOST")
	if host == "" {
		host = "https://us.i.posthog.com"
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"token": os.Getenv("POSTHOG_PROJECT_TOKEN"),
		"host":  host,
	})
}

// capture records a successful public action. Distinct IDs come from the
// PostHog request-context middleware (the map sends them as headers); when
// a caller has none, EnqueueWithContext emits a personless event. Loopback
// requests are dropped so local development does not reach PostHog.
func (s *Server) capture(r *http.Request, event string, properties posthog.Properties) {
	if r == nil || analytics.LoopbackHost(r.Host) {
		return
	}
	client := analytics.Client()
	if client == nil {
		return
	}
	_ = posthog.EnqueueWithContext(r.Context(), client, posthog.Capture{
		Event:      event,
		Properties: properties,
	})
}

// fail maps an error to a status code and logs anything unexpected.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, graph.ErrNotFound), errors.Is(err, tmdb.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, context.Canceled):
		// Client went away; nothing to send.
	default:
		s.logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// logRequests writes one line per request once it has been served, with
// the status, wall time and response size.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.logger.Info("request",
			"method", r.Method,
			"path", r.URL.RequestURI(),
			"status", rec.status,
			"duration", time.Since(start).Round(time.Microsecond),
			"bytes", rec.bytes,
		)
	})
}

// responseRecorder captures the status code and body size written by a
// handler.
type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *responseRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func pathInt(r *http.Request, name string) (int, error) {
	v, err := strconv.Atoi(r.PathValue(name))
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return v, nil
}

// queryInt reads an optional integer query parameter within [min, max].
func queryInt(r *http.Request, name string, def, min, max int) (int, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < min || v > max {
		return 0, fmt.Errorf("%s must be an integer in %d..%d", name, min, max)
	}
	return v, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Default().Warn("write response", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
