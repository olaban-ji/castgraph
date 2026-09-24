package catalog

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"cinedikt/internal/omdb"
)

// Poster is what OMDb knows that the dump does not.
type Poster struct {
	TConst   string
	URL      string
	Released time.Time
	OK       bool
}

// PosterFiller looks up a title. The importer owns the client, so the
// rate it runs at is set in one place.
type PosterFiller interface {
	Lookup(ctx context.Context, imdbID string) (omdb.Title, error)
}

// PosterJob fills meta.posters. It is the only thing in the catalog that
// calls an API, and nothing a reader does can reach it.
//
// meta is never renamed by the daily swap, so what it learns survives
// every future generation: a title is looked up once, ever, unless the
// lookup itself failed.
type PosterJob struct {
	Store  *Store
	Client PosterFiller
	Logger *slog.Logger
	// Batch is how many ids are claimed per round.
	Batch int

	// Workers is how many lookups are in flight at once.
	//
	// Without this the rate limit is not a dial at all: one lookup at a
	// time means throughput is one over the round trip, so setting the
	// limiter to 200/s on a 40ms round trip still gives 25/s. The
	// limiter bounds the rate; this is what lets it be reached.
	Workers int
}

// DefaultPosterBatch is how many titles are taken at a time. Small
// enough that a cancelled job loses almost nothing, large enough that
// the query to find them is not most of the work.
const DefaultPosterBatch = 500

// DefaultPosterWorkers is how many lookups run at once. Enough that the
// rate limiter is what decides the pace rather than the round trip, and
// few enough that the answers do not outrun the writes behind them.
const DefaultPosterWorkers = 16

// Run fills in what it can before ctx is done.
//
// Order matters more than speed here. Three-quarters of a million
// lookups take days at any polite rate, so the most voted films go
// first: the few thousand anyone actually searches have posters and
// dates within minutes of the first run, and the long tail fills in over
// following nights.
func (j *PosterJob) Run(ctx context.Context, schema string) error {
	batch := j.Batch
	if batch <= 0 {
		batch = DefaultPosterBatch
	}
	workers := j.Workers
	if workers <= 0 {
		workers = DefaultPosterWorkers
	}
	// A lookup that failed is written as `missing` so tomorrow retries
	// it — which means this run must not pick it straight back up, or it
	// would ask the same dead id until the budget ran out. Only rows
	// last touched before this run started are offered.
	started := time.Now()
	outstanding, err := j.Store.postersOutstanding(ctx, schema, started)
	if err != nil {
		return err
	}
	var done, failed atomic.Int64
	// Set when the key is spent. There is no point spending the rest of
	// the budget being told no.
	var spent atomic.Bool
	track := newProgress(j.Logger, "filling in posters", outstanding)

	for {
		if ctx.Err() != nil || spent.Load() {
			j.Logger.Info("poster backfill paused",
				"filled", done.Load(), "failed", failed.Load(), "quota", spent.Load())
			return nil
		}
		ids, err := j.Store.postersWanted(ctx, schema, batch, started)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			track.done(done.Load() + failed.Load())
			j.Logger.Info("poster backfill caught up",
				"filled", done.Load(), "failed", failed.Load())
			return nil
		}

		// Lookups fan out; their answers fan back in to one writer that
		// puts them away in batches. A write per lookup would make the
		// connection pool the ceiling long before the rate limit was.
		queue := make(chan string)
		answers := make(chan Poster, workers*2)
		var wg sync.WaitGroup
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for id := range queue {
					if ctx.Err() != nil || spent.Load() {
						continue // drain, so the sender is never blocked
					}
					got, err := j.Client.Lookup(ctx, id)
					switch {
					case errors.Is(err, omdb.ErrQuota):
						spent.Store(true)
					case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
					case errors.Is(err, omdb.ErrNotFound):
						// OMDb answered and has nothing. That is an
						// answer, and it is stored so the title is
						// never asked about again.
						answers <- Poster{TConst: id, OK: true}
					case err != nil:
						// The lookup failed rather than came back
						// empty, so it is worth asking again tomorrow.
						answers <- Poster{TConst: id}
					default:
						answers <- Poster{TConst: id, URL: got.Poster, Released: got.Released, OK: true}
					}
				}
			}()
		}

		written := make(chan error, 1)
		go func() {
			written <- j.Store.savePosters(ctx, answers, func(ok, bad int64) {
				done.Add(ok)
				failed.Add(bad)
				track.step(done.Load() + failed.Load())
			})
		}()

		for _, id := range ids {
			queue <- id
		}
		close(queue)
		wg.Wait()
		close(answers)
		if err := <-written; err != nil {
			return err
		}
	}
}

// postersWanted is the next titles to look up: the ones never asked
// about, and the ones whose lookup failed, most voted first.
func (s *Store) postersWanted(ctx context.Context, schema string, limit int, before time.Time) ([]string, error) {
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT t.tconst
		FROM %s.titles t
		LEFT JOIN %s.ratings r USING (tconst)
		LEFT JOIN meta.posters p USING (tconst)
		WHERE NOT t.is_adult
		  AND (p.tconst IS NULL OR (p.status = 'missing' AND p.fetched_at < $2))
		ORDER BY coalesce(r.num_votes, 0) DESC, t.tconst
		LIMIT $1`, schema, schema), limit, before)
	if err != nil {
		return nil, fmt.Errorf("catalog: find titles wanting a poster: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// postersOutstanding is how many titles this run still has to ask about.
// It is the same set postersWanted hands out, counted once at the start
// so the log can say how far through that set the run is.
func (s *Store) postersOutstanding(ctx context.Context, schema string, before time.Time) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, fmt.Sprintf(`
		SELECT count(*)
		FROM %s.titles t
		LEFT JOIN meta.posters p USING (tconst)
		WHERE NOT t.is_adult
		  AND (p.tconst IS NULL OR (p.status = 'missing' AND p.fetched_at < $1))`, schema), before).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("catalog: count titles wanting a poster: %w", err)
	}
	return n, nil
}

// PosterWriteBatch is how many answers go into one statement. Large
// enough that the database is nowhere near the bottleneck, small enough
// that a cancelled run loses almost nothing.
const PosterWriteBatch = 500

// savePosters drains answers and writes them in batches. One statement
// per few hundred titles rather than one per title: at three-quarters of
// a million lookups the round trips would otherwise be most of the work.
func (s *Store) savePosters(ctx context.Context, answers <-chan Poster, progress func(ok, bad int64)) error {
	pending := make([]Poster, 0, PosterWriteBatch)
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		if err := s.writePosters(ctx, pending); err != nil {
			return err
		}
		var ok, bad int64
		for _, p := range pending {
			if p.OK {
				ok++
			} else {
				bad++
			}
		}
		progress(ok, bad)
		pending = pending[:0]
		return nil
	}
	for p := range answers {
		pending = append(pending, p)
		if len(pending) >= PosterWriteBatch {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	return flush()
}

// writePosters puts one batch away in a single statement.
func (s *Store) writePosters(ctx context.Context, batch []Poster) error {
	ids := make([]string, len(batch))
	urls := make([]*string, len(batch))
	dates := make([]*time.Time, len(batch))
	states := make([]string, len(batch))
	for i, p := range batch {
		ids[i] = p.TConst
		if p.URL != "" {
			url := p.URL
			urls[i] = &url
		}
		if !p.Released.IsZero() {
			when := p.Released
			dates[i] = &when
		}
		states[i] = "missing"
		if p.OK {
			states[i] = "ok"
		}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO meta.posters (tconst, poster_url, released, status, fetched_at)
		SELECT u.tconst, u.url, u.released, u.status, now()
		FROM unnest($1::text[], $2::text[], $3::date[], $4::text[])
		     AS u(tconst, url, released, status)
		ON CONFLICT (tconst) DO UPDATE
		SET poster_url = EXCLUDED.poster_url,
		    released   = EXCLUDED.released,
		    status     = EXCLUDED.status,
		    fetched_at = EXCLUDED.fetched_at`,
		ids, urls, dates, states)
	if err != nil {
		return fmt.Errorf("catalog: save %d posters: %w", len(batch), err)
	}
	return nil
}

func (s *Store) savePoster(ctx context.Context, p Poster) error {
	status := "missing"
	if p.OK {
		status = "ok"
	}
	var released any
	if !p.Released.IsZero() {
		released = p.Released
	}
	var url any
	if p.URL != "" {
		url = p.URL
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO meta.posters (tconst, poster_url, released, status, fetched_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (tconst) DO UPDATE
		SET poster_url = EXCLUDED.poster_url,
		    released   = EXCLUDED.released,
		    status     = EXCLUDED.status,
		    fetched_at = EXCLUDED.fetched_at`,
		p.TConst, url, released, status)
	if err != nil {
		return fmt.Errorf("catalog: save poster %s: %w", p.TConst, err)
	}
	return nil
}

// ForgetUnknownPosters drops rows for titles the live catalog no longer
// holds, so meta does not grow for ever on films IMDb withdrew.
func (s *Store) ForgetUnknownPosters(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM meta.posters p
		WHERE NOT EXISTS (SELECT 1 FROM `+Live+`.titles t WHERE t.tconst = p.tconst)`)
	if err != nil {
		return 0, fmt.Errorf("catalog: forget posters: %w", err)
	}
	return tag.RowsAffected(), nil
}
