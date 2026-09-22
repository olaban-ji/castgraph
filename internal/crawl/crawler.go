// Package crawl walks TMDb outward from a seed movie and writes what it
// finds into the graph store.
package crawl

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"

	"cinedikt/internal/graph"
	"cinedikt/internal/omdb"
	"cinedikt/internal/seen"
	"cinedikt/internal/tmdb"
)

// Source is the part of the TMDb client the crawler uses.
type Source interface {
	Movie(ctx context.Context, id int) (*tmdb.Movie, error)
	// Person returns the profile with MovieCredits populated.
	Person(ctx context.Context, id int) (*tmdb.Person, error)
}

// Writer is the part of the graph store the crawler uses.
type Writer interface {
	WriteMovieCast(ctx context.Context, m graph.Movie, cast []graph.CastEntry, directors []graph.Person) error
	WriteFilmography(ctx context.Context, p graph.Person, credits []graph.FilmCredit) error
	WriteIMDbRating(ctx context.Context, movieID int, rating float64, votes int) error
}

// RatingSource looks up IMDb ratings by IMDb id.
type RatingSource interface {
	IMDbRating(ctx context.Context, imdbID string) (omdb.Rating, error)
}

// Options tunes a Crawler. Zero values take the defaults noted per field.
type Options struct {
	// Concurrency is the number of TMDb requests in flight at once (default 8).
	// The client's rate limiter, not this, bounds the request rate.
	Concurrency int
	// Scoring decides who gets crawled further (default DefaultScoring).
	Scoring Scoring
	// Ratings, if set, adds an IMDb rating to every movie whose cast is
	// fetched. Lookups that fail are logged and the movie written without.
	Ratings RatingSource
	// MaxPeoplePerMovie caps how many cast members of one movie, top
	// billing first, have their filmography fetched (0 = everyone who
	// passes scoring). Each one is a TMDb round trip.
	MaxPeoplePerMovie int
	// MemoryTTL is how long the crawler remembers having fetched a node
	// before it is willing to fetch it again (default MemoryTTL). It
	// bounds staleness: a server that never restarts still picks up new
	// credits eventually.
	MemoryTTL time.Duration
	// MemorySize caps how many ids that memory holds (default
	// seen.DefaultMax), so a long-lived process cannot grow without end.
	MemorySize int
	Logger     *slog.Logger
}

// MemoryTTL is the default lifetime of the crawler's "already fetched"
// memory. A day is long enough that a browsing session never refetches
// and short enough that a long-running server is not frozen on the data
// it happened to see first.
const MemoryTTL = 24 * time.Hour

// Stats summarises one crawl.
type Stats struct {
	MoviesFetched int64
	PeopleFetched int64
	PeopleSkipped int64 // failed phase-2 scoring
	FetchErrors   int64
	RatingErrors  int64 // OMDb lookups that failed (the movie is still written)
	WriteErrors   int64
}

// Crawler expands movies and people level by level. It remembers what it
// has processed, so one long-lived Crawler never fetches a node twice.
type Crawler struct {
	src  Source
	w    Writer
	opts Options

	// seenMovies and seenPeople are bounded, expiring: they stop a crawl
	// refetching what it just fetched without pinning every id a
	// long-lived process ever touched in memory.
	seenMovies *seen.Set
	seenPeople *seen.Set
	// mustExpand is person ids that skip phase-2 scoring: directors of a
	// movie we crawled. Their department is often Directing, not Acting,
	// and there is only one (or two) per film.
	mustExpand *seen.Set
	// expands makes concurrent ExpandMovie calls for one movie share a
	// single crawl and all return once it has been written, so no caller
	// reads a half-written neighbourhood.
	expands singleflight.Group
	// quotaWarnedAt is when the OMDb quota was last reported (unix seconds).
	quotaWarnedAt atomic.Int64
}

// New returns a Crawler reading from src and writing to w.
func New(src Source, w Writer, opts Options) *Crawler {
	if opts.Concurrency <= 0 {
		opts.Concurrency = 8
	}
	if opts.Scoring == (Scoring{}) {
		opts.Scoring = DefaultScoring
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.MemoryTTL == 0 {
		opts.MemoryTTL = MemoryTTL
	}
	return &Crawler{
		src:        src,
		w:          w,
		opts:       opts,
		seenMovies: seen.New(opts.MemorySize, opts.MemoryTTL),
		seenPeople: seen.New(opts.MemorySize, opts.MemoryTTL),
		mustExpand: seen.New(opts.MemorySize, opts.MemoryTTL),
	}
}

// run is the per-call state: counters plus the rating lookups still in
// flight, which a call waits for before returning.
type run struct {
	stats   Stats
	ratings sync.WaitGroup
}

// Run crawls outward from seedMovieID for maxDepth levels. One level is the
// seed's cast and their filmographies; each further level fetches the
// credits of the movies found and scores their casts in turn.
func (c *Crawler) Run(ctx context.Context, seedMovieID, maxDepth int) (*Stats, error) {
	if maxDepth < 1 {
		return nil, fmt.Errorf("crawl: max depth %d must be at least 1", maxDepth)
	}
	r := &run{}
	defer r.ratings.Wait()
	candidates, err := c.processMovie(ctx, r, seedMovieID, 1)
	if err != nil {
		return &r.stats, fmt.Errorf("crawl: seed movie %d: %w", seedMovieID, err)
	}
	for depth := 1; depth <= maxDepth; depth++ {
		if depth > 1 {
			// Movies from the previous level's filmographies; their casts
			// are scored at this depth.
			candidates = c.fanOut(ctx, candidates, func(ctx context.Context, id int) ([]int, error) {
				return c.processMovie(ctx, r, id, depth)
			})
		}
		c.opts.Logger.Info("crawl level", "depth", depth, "people", len(candidates))
		candidates = c.fanOut(ctx, candidates, func(ctx context.Context, id int) ([]int, error) {
			return c.processPerson(ctx, r, id, depth)
		})
		if ctx.Err() != nil {
			return &r.stats, ctx.Err()
		}
	}
	r.ratings.Wait()
	return &r.stats, nil
}

// ExpandMovie runs one level from a movie: its cast and director are
// written, the cast is scored at depth, and the filmographies of those
// who pass (and of the director) are written too. A call for a movie
// already being expanded waits for that expansion instead of starting
// its own.
func (c *Crawler) ExpandMovie(ctx context.Context, movieID, depth int) (*Stats, error) {
	ch := c.expands.DoChan(strconv.Itoa(movieID), func() (any, error) {
		return c.expandMovie(ctx, movieID, depth)
	})
	select {
	case res := <-ch:
		stats, _ := res.Val.(*Stats)
		if stats == nil {
			stats = &Stats{}
		}
		return stats, res.Err
	case <-ctx.Done():
		return &Stats{}, ctx.Err()
	}
}

func (c *Crawler) expandMovie(ctx context.Context, movieID, depth int) (*Stats, error) {
	r := &run{}
	defer r.ratings.Wait()
	candidates, err := c.processMovie(ctx, r, movieID, depth)
	if err != nil {
		return &r.stats, fmt.Errorf("crawl: expand movie %d: %w", movieID, err)
	}
	c.fanOut(ctx, candidates, func(ctx context.Context, id int) ([]int, error) {
		return c.processPerson(ctx, r, id, depth)
	})
	r.ratings.Wait()
	return &r.stats, ctx.Err()
}

// processMovie fetches a movie with its cast and director, writes them, and
// returns the people worth a phase-2 look at this depth. Directors always
// qualify. A movie already processed returns no candidates. The IMDb rating
// is looked up alongside whatever the caller does next and written when it
// arrives.
func (c *Crawler) processMovie(ctx context.Context, r *run, movieID, depth int) ([]int, error) {
	if !c.seenMovies.Add(movieID) {
		return nil, nil
	}
	start := time.Now()
	m, err := c.src.Movie(ctx, movieID)
	if err != nil {
		c.seenMovies.Forget(movieID)
		atomic.AddInt64(&r.stats.FetchErrors, 1)
		return nil, err
	}
	atomic.AddInt64(&r.stats.MoviesFetched, 1)
	fetched := time.Now()

	var cast []graph.CastEntry
	var directors []graph.Person
	var candidates []int
	if m.Credits != nil {
		for _, cm := range m.Credits.Cast {
			if isNoiseCredit(cm.Character) {
				continue
			}
			cast = append(cast, graph.CastEntry{
				Person:    graph.Person{ID: cm.ID, Name: cm.Name, Popularity: cm.Popularity},
				Character: cm.Character,
				Order:     cm.Order,
			})
			if c.opts.Scoring.ShouldCrawl(cm, depth) &&
				(c.opts.MaxPeoplePerMovie == 0 || len(candidates) < c.opts.MaxPeoplePerMovie) {
				candidates = append(candidates, cm.ID)
			}
		}
		seenCand := make(map[int]bool, len(candidates))
		for _, id := range candidates {
			seenCand[id] = true
		}
		for _, d := range movieDirectors(m.Credits) {
			directors = append(directors, graph.Person{ID: d.ID, Name: d.Name, Popularity: d.Popularity})
			c.mustExpand.Add(d.ID)
			if !seenCand[d.ID] {
				candidates = append(candidates, d.ID)
				seenCand[d.ID] = true
			}
		}
	}
	movie := graph.Movie{
		ID: m.ID, Title: m.Title, ReleaseDate: m.ReleaseDate, PosterPath: m.PosterPath, BackdropPath: m.BackdropPath,
		Rating: m.VoteAverage, VoteCount: m.VoteCount, IMDbID: m.IMDbID,
	}
	if err := c.write(ctx, r, func(ctx context.Context) error {
		return c.w.WriteMovieCast(ctx, movie, cast, directors)
	}); err != nil {
		c.seenMovies.Forget(movieID)
		return nil, err
	}
	if c.opts.Ratings != nil && m.IMDbID != "" {
		r.ratings.Add(1)
		go func() {
			defer r.ratings.Done()
			defer c.recoverPanic("imdb rating", m.ID)
			c.writeIMDbRating(ctx, r, m.ID, m.IMDbID)
		}()
	}
	c.opts.Logger.Debug("movie written", "id", m.ID, "title", m.Title, "cast", len(cast), "directors", len(directors), "candidates", len(candidates),
		"fetch", fetched.Sub(start).Round(time.Millisecond), "write", time.Since(fetched).Round(time.Millisecond))
	return candidates, nil
}

func (c *Crawler) writeIMDbRating(ctx context.Context, r *run, movieID int, imdbID string) {
	rating, err := c.opts.Ratings.IMDbRating(ctx, imdbID)
	switch {
	case errors.Is(err, omdb.ErrNotFound):
		c.opts.Logger.Debug("no imdb rating", "movie", movieID, "imdb_id", imdbID)
		return
	case errors.Is(err, omdb.ErrQuota):
		// Warn once per pause; every movie until then is skipped quietly.
		atomic.AddInt64(&r.stats.RatingErrors, 1)
		if last := c.quotaWarnedAt.Load(); time.Since(time.Unix(last, 0)) > omdb.QuotaPause &&
			c.quotaWarnedAt.CompareAndSwap(last, time.Now().Unix()) {
			c.opts.Logger.Warn("OMDb daily quota reached; skipping IMDb ratings for a while", "pause", omdb.QuotaPause)
		}
		return
	case err != nil:
		atomic.AddInt64(&r.stats.RatingErrors, 1)
		c.opts.Logger.Warn("imdb rating lookup failed", "movie", movieID, "imdb_id", imdbID, "err", err)
		return
	}
	_ = c.write(ctx, r, func(ctx context.Context) error {
		return c.w.WriteIMDbRating(ctx, movieID, rating.Value, rating.Votes)
	})
}

// processPerson applies phase-2 scoring, then writes the filmography and
// returns the movies in it that seed the next level.
func (c *Crawler) processPerson(ctx context.Context, r *run, personID, depth int) ([]int, error) {
	if c.seenPeople.Has(personID) {
		return nil, nil
	}
	start := time.Now()
	p, err := c.src.Person(ctx, personID)
	if err != nil {
		atomic.AddInt64(&r.stats.FetchErrors, 1)
		return nil, err
	}
	c.opts.Logger.Debug("person fetched", "id", p.ID, "name", p.Name, "fetch", time.Since(start).Round(time.Millisecond))
	force := c.mustExpand.Has(personID)
	if !force && !c.opts.Scoring.ShouldExpand(*p, depth) {
		atomic.AddInt64(&r.stats.PeopleSkipped, 1)
		c.opts.Logger.Debug("person skipped", "id", p.ID, "name", p.Name, "popularity", p.Popularity, "depth", depth)
		return nil, nil
	}
	return c.writeFilmography(ctx, r, p)
}

// writeFilmography writes a person's filmography, returning the movies in
// it that seed the next level. A person already written returns no movies.
func (c *Crawler) writeFilmography(ctx context.Context, r *run, p *tmdb.Person) ([]int, error) {
	if !c.seenPeople.Add(p.ID) {
		return nil, nil
	}
	atomic.AddInt64(&r.stats.PeopleFetched, 1)

	var credits []graph.FilmCredit
	var next []int
	if p.MovieCredits != nil {
		for _, cr := range p.MovieCredits.Cast {
			if isNoiseCredit(cr.Character) {
				continue
			}
			credits = append(credits, graph.FilmCredit{
				Movie: graph.Movie{
					ID: cr.ID, Title: cr.Title, ReleaseDate: cr.ReleaseDate, PosterPath: cr.PosterPath, BackdropPath: cr.BackdropPath,
					Rating: cr.VoteAverage, VoteCount: cr.VoteCount,
				},
				Character: cr.Character,
				Order:     cr.Order,
			})
			if seedsNextLevel(cr) {
				next = append(next, cr.ID)
			}
		}
		seenDirected := map[int]bool{}
		for _, cr := range p.MovieCredits.Crew {
			if cr.Job != tmdb.JobDirector || seenDirected[cr.ID] {
				continue
			}
			seenDirected[cr.ID] = true
			credits = append(credits, graph.FilmCredit{
				Movie: graph.Movie{
					ID: cr.ID, Title: cr.Title, ReleaseDate: cr.ReleaseDate, PosterPath: cr.PosterPath, BackdropPath: cr.BackdropPath,
					Rating: cr.VoteAverage, VoteCount: cr.VoteCount,
				},
				Job: graph.JobDirector,
			})
			if seedsDirected(cr) {
				next = append(next, cr.ID)
			}
		}
	}
	person := graph.Person{ID: p.ID, Name: p.Name, Popularity: p.Popularity}
	start := time.Now()
	if err := c.write(ctx, r, func(ctx context.Context) error {
		return c.w.WriteFilmography(ctx, person, credits)
	}); err != nil {
		c.seenPeople.Forget(p.ID)
		return nil, err
	}
	c.opts.Logger.Debug("filmography written", "id", p.ID, "name", p.Name, "movies", len(credits), "write", time.Since(start).Round(time.Millisecond))
	return next, nil
}

// write runs one graph write. Writes run concurrently: two MERGEs meeting
// on a shared node can deadlock in Neo4j, but the driver's managed
// transactions retry that, and it costs far less than queueing every write
// behind a TMDb round trip.
func (c *Crawler) write(ctx context.Context, r *run, op func(context.Context) error) error {
	if err := op(ctx); err != nil {
		atomic.AddInt64(&r.stats.WriteErrors, 1)
		return err
	}
	return nil
}

// recoverPanic keeps one malformed record from taking the process down.
// Crawls run in goroutines started by user requests, so a panic here is
// not merely a lost crawl: without this it is the whole server.
func (c *Crawler) recoverPanic(what string, id int) {
	if v := recover(); v != nil {
		c.opts.Logger.Error("crawl panic recovered", "at", what, "id", id,
			"panic", fmt.Sprintf("%v", v), "stack", string(debug.Stack()))
	}
}

// fanOut runs fn over ids with bounded concurrency and returns the
// deduplicated union of what each call produced. Per-id failures are logged,
// not propagated: one dead TMDb record should not abort a crawl.
func (c *Crawler) fanOut(ctx context.Context, ids []int, fn func(context.Context, int) ([]int, error)) []int {
	var (
		mu   sync.Mutex
		out  []int
		seen = map[int]bool{}
		wg   sync.WaitGroup
		sem  = make(chan struct{}, c.opts.Concurrency)
	)
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(id int) {
			defer wg.Done()
			defer func() { <-sem }()
			defer c.recoverPanic("crawl item", id)
			got, err := fn(ctx, id)
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					c.opts.Logger.Warn("crawl item failed", "id", id, "err", err)
				}
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, g := range got {
				if !seen[g] {
					seen[g] = true
					out = append(out, g)
				}
			}
		}(id)
	}
	wg.Wait()
	return out
}
