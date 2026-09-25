package catalog

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"cinedikt/internal/notify"
	"cinedikt/internal/omdb"
	"cinedikt/internal/tmdb"
)

// Runner keeps a catalog up to date: it imports one if there is none,
// checks hourly for a new generation, and fills in posters continuously
// beside both.
//
// It is the whole of what the importer does, in one place, because the
// API can run it too. Starting the app on an empty database should
// leave you with a working map rather than a 503 and a second command
// to find.
type Runner struct {
	// Store is the pool the jobs write through. Leave it nil and set
	// DatabaseURL to have Start open one of its own — which is what
	// the API does, so a bulk load never takes a connection a reader
	// is waiting for.
	Store *Store
	// DatabaseURL and MaxConns open that pool. Ignored when Store is
	// already set, which is how cmd/importer supplies its own.
	DatabaseURL string
	MaxConns    int32
	Logger      *slog.Logger
	// Dir is where the downloads are kept. Empty means a temp directory.
	Dir string
	// OMDbKey enables posters and release dates. Empty leaves the
	// catalog working, without pictures.
	OMDbKey       string
	BackfillRate  float64
	PosterWorkers int
	// TMDbAuth turns on the second-chance poster fetch for titles OMDb
	// has no picture for, and for addresses that have stopped
	// answering. Empty leaves those titles without one.
	TMDbAuth tmdb.Auth
	// TMDbRate caps it; zero takes the client's own default, which is
	// already under TMDb's ceiling.
	TMDbRate float64
	// TMDbSweepMinVotes is how well known a title has to be to be
	// fetched ahead of anybody asking. Zero sweeps the whole catalog.
	TMDbSweepMinVotes int
	// Keep leaves the downloaded files on disk, for development.
	Keep bool
	// Notify is told when an import starts, finishes, fails, or the
	// catalog goes stale, and how the other jobs are getting on. Nil
	// leaves all of that in the log.
	Notify notify.Sink
	// alertedStale keeps a stale catalog from buzzing once an hour.
	// The hourly check is what notices it; the alert is for the
	// transition, and it clears when a generation is published.
	alertedStale bool
}

// Start runs the whole cycle until ctx is done. It returns immediately;
// everything happens behind it, so a caller that also serves requests
// can answer "still being built" while the first import runs.
// Start runs the whole cycle until ctx is done. It returns as soon as
// the pool is open; everything else happens behind it, so a caller that
// also serves requests can answer "still being built" while the first
// import runs.
//
// Nothing starts until this process holds the lease, and everything
// stops if it loses it. Two runners would call OMDb and TMDb twice over
// and hand each other the same page.
func (r *Runner) Start(ctx context.Context) error {
	own := false
	if r.Store == nil {
		if r.DatabaseURL == "" {
			return errors.New("catalog: the runner needs a Store or a DatabaseURL")
		}
		store, err := Open(ctx, r.DatabaseURL, r.MaxConns)
		if err != nil {
			return fmt.Errorf("catalog: open the runner's pool: %w", err)
		}
		r.Store = store
		own = true
		r.Logger.Info("the catalog jobs have their own pool", "max_conns", r.MaxConns)
	}
	go func() {
		if own {
			defer r.Store.Close()
		}
		HoldLease(ctx, r.leaseURL(), r.Logger, r.run)
	}()
	return nil
}

// leaseURL is where the lease connection goes. It is the same database
// the pool uses; a runner given a ready-made Store is told the URL the
// same way.
func (r *Runner) leaseURL() string { return r.DatabaseURL }

// run is everything the runner does while it holds the lease. It
// returns when ctx is cancelled, which is either shutdown or the lease
// being lost.
func (r *Runner) run(ctx context.Context, wakes *Wakes) {
	im, posters := r.build()
	var wg sync.WaitGroup
	start := func(loop func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			loop()
		}()
	}

	if posters != nil {
		start(func() { fillPosters(ctx, posters, r.Logger, wakes) })
	}
	// One client between the two TMDb jobs, so they share one rate
	// limit. Each with its own would be twice TMDb's ceiling.
	if client := r.tmdbClient(); client != nil {
		start(func() {
			fillFromTMDb(ctx, &TMDbJob{
				Store:    r.Store,
				Client:   client,
				Logger:   r.Logger.With("job", "tmdb-posters"),
				MinVotes: r.TMDbSweepMinVotes,
				Notify:   r.Notify,
			}, r.Logger, wakes)
		})
		start(func() {
			fillTMDbIDs(ctx, &TMDbIDJob{
				Store:  r.Store,
				Client: client,
				Logger: r.Logger.With("job", "tmdb-ids"),
				Notify: r.Notify,
			}, r.Logger, wakes)
		})
	} else {
		r.Logger.Info("no TMDb credentials; movies OMDb has no poster for will have none, and an empty search stays empty")
	}
	// And the colours the opening screen fills its frames with. It
	// needs no credentials — the posters are public — so it runs
	// wherever the catalog does.
	start(func() {
		fillColours(ctx, &ColourJob{
			Store:  r.Store,
			Logger: r.Logger.With("job", "opening-colours"),
			Notify: r.Notify,
		}, r.Logger, wakes)
	})
	start(func() {
		// The files are rebuilt once a day. The hourly check is not
		// about catching the moment they land; it is about not waiting
		// most of a day after they have. The first attempt is now,
		// which is what imports an empty catalog on startup.
		r.attempt(ctx, im)
		ticker := time.NewTicker(PollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.attempt(ctx, im)
			}
		}
	})
	wg.Wait()
}

// Once runs a single attempt and reports whether it ended well. A run
// that decided not to import is a success: most hours are.
func (r *Runner) Once(ctx context.Context) bool {
	im, _ := r.build()
	return r.attempt(ctx, im)
}

// Posters fills in what it can and returns. Nothing else runs.
func (r *Runner) Posters(ctx context.Context) error {
	_, job := r.build()
	if job == nil {
		return nil
	}
	return job.Run(ctx, Live)
}

func (r *Runner) build() (*Importer, *PosterJob) {
	dir := r.Dir
	if dir == "" {
		dir = os.TempDir() + "/cinedikt-catalog"
	}
	im := &Importer{
		Store: r.Store,
		// Two files are most of a gigabyte; the per-file deadline lives
		// in the downloader, so this client has none of its own.
		Client: &http.Client{},
		Dir:    dir,
		Logger: r.Logger,
		Keep:   r.Keep,
		Notify: r.Notify,
	}
	if r.OMDbKey == "" {
		r.Logger.Warn("OMDB_API_KEY is not set; posters and release dates will be missing")
		return im, nil
	}
	workers := r.PosterWorkers
	if workers <= 0 {
		workers = DefaultPosterWorkers
	}
	return im, &PosterJob{
		Store: r.Store,
		Client: omdb.New(r.OMDbKey,
			omdb.WithRateLimit(r.BackfillRate, int(r.BackfillRate)),
			omdb.WithHTTPTimeout(15*time.Second),
			omdb.WithConnections(workers)),
		Logger:  r.Logger,
		Batch:   DefaultPosterBatch,
		Workers: workers,
		Notify:  r.Notify,
	}
}

// TMDbPosters fills in what OMDb could not and returns. Nothing else
// runs, and no credentials means nothing to do.
func (r *Runner) TMDbPosters(ctx context.Context) error {
	job := r.buildTMDb()
	if job == nil {
		return nil
	}
	return job.Run(ctx)
}

// tmdbClient is the one TMDb client the runner's jobs share. Nil when
// there are no credentials: both jobs then have nothing to do.
func (r *Runner) tmdbClient() *tmdb.Client {
	if r.TMDbAuth.APIKey == "" && r.TMDbAuth.AccessToken == "" {
		return nil
	}
	opts := []tmdb.Option{}
	if r.TMDbRate > 0 {
		opts = append(opts, tmdb.WithRateLimit(rate.Limit(r.TMDbRate), int(r.TMDbRate)))
	}
	return tmdb.New(r.TMDbAuth, opts...)
}

// buildTMDb is the poster fallback, or nil when there are no TMDb
// credentials to use.
func (r *Runner) buildTMDb() *TMDbJob {
	client := r.tmdbClient()
	if client == nil {
		r.Logger.Info("no TMDb credentials; movies OMDb has no poster for will have none")
		return nil
	}
	return &TMDbJob{
		Store:  r.Store,
		Client: client,
		// `job`, not `component`: the runner's logger already carries a
		// component, and a second one makes two keys of the same name in
		// every JSON line this writes. A strict reader keeps one of them.
		Logger:   r.Logger.With("job", "tmdb-posters"),
		MinVotes: r.TMDbSweepMinVotes,
		Notify:   r.Notify,
	}
}

func (r *Runner) attempt(ctx context.Context, im *Importer) bool {
	out, err := im.RunOnce(ctx)
	if err != nil {
		// Worth an alert: a skipped hour is not a crisis, but a run of
		// them means the catalog is going stale.
		r.Logger.Error("import failed", "err", err)
		report(r.Notify, notify.JobImport, notify.Failed, err.Error())
		return false
	}
	if !out.Ran {
		// Most hours are this one. Saying so every time would be
		// twenty-three messages a day about nothing happening.
		r.Logger.Info("no import this hour", "reason", out.Reason)
		r.warnIfStale(ctx)
		return true
	}
	r.alertedStale = false
	r.Logger.Info("import published",
		"titles", out.Counts.Titles,
		"names", out.Counts.Names,
		"principals", out.Counts.Principals,
		"directors", out.Counts.Directors,
		"ratings", out.Counts.Ratings,
		"integrity", out.Integrity,
		"took", out.Took.Round(time.Second))
	report(r.Notify, notify.JobImport, notify.Published, fmt.Sprintf("%s titles and %s names, in %s",
		count(out.Counts.Titles), count(out.Counts.Names), rough(out.Took)))
	if n, err := r.Store.ForgetUnknownPosters(ctx); err != nil {
		r.Logger.Warn("forget withdrawn posters", "err", err)
	} else if n > 0 {
		r.Logger.Info("forgot posters for withdrawn titles", "rows", n)
	}
	return true
}

// warnIfStale says so when the published catalog is old. It is a log
// line and an alert, never a health check: a stale catalog serves
// perfectly well, and failing a health check on it would turn a late
// upstream publish into a failed deploy.
func (r *Runner) warnIfStale(ctx context.Context) {
	stale, age, err := r.Store.Stale(ctx, time.Now())
	if err != nil {
		r.Logger.Warn("read generation", "err", err)
		return
	}
	if !stale {
		r.alertedStale = false
		return
	}
	r.Logger.Warn("catalog is stale", "age", age.Round(time.Minute), "after", StaleAfter)
	if r.alertedStale {
		return
	}
	r.alertedStale = true
	text := "nothing has been published yet"
	if age > 0 {
		text = "last published " + rough(age) + " ago"
	}
	report(r.Notify, notify.JobImport, notify.Stale, text)
}

// PosterRest is how long the backfill waits after catching up, or after
// being told the key is spent, before looking for work again.
const PosterRest = 20 * time.Minute

// PosterWaitForCatalog is how often it looks while there is no catalog
// to fill in yet. On a first start the import is running and will finish
// in minutes; resting the full period would leave the backfill asleep
// for most of the time it could have been working.
const PosterWaitForCatalog = 15 * time.Second

// fillPosters keeps meta.posters filled for as long as the process runs.
// It is deliberately not part of an import: three-quarters of a million
// lookups take longer than the gap between generations, so tying the two
// together would leave the catalog permanently a day behind its own
// pictures.
func fillPosters(ctx context.Context, job *PosterJob, logger *slog.Logger, wakes *Wakes) {
	waited := false
	for {
		// Nothing to fill until a catalog has been published. On a first
		// start that is a few minutes away, so the wait is short.
		ready, err := job.Store.LiveReady(ctx)
		if err != nil {
			logger.Warn("poster backfill: readiness", "err", err)
		}
		wait := PosterRest
		switch {
		case err != nil || !ready:
			if !waited {
				logger.Info("poster backfill waiting for a catalog")
				waited = true
			}
			wait = PosterWaitForCatalog
		default:
			waited = false
			if err := job.Run(ctx, Live); err != nil {
				logger.Warn("poster backfill", "err", err)
				report(job.Notify, notify.JobPosters, notify.Failed, err.Error())
			}
		}
		if !waitFor(ctx, wakes.Published, wait) {
			return
		}
	}
}
