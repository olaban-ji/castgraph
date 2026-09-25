package catalog

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"cinedikt/internal/notify"
)

// importLockKey is the advisory lock the whole attempt is held under.
// Two importers must not run: they would write the same staging schema.
// The loser exits rather than waiting, because the winner is about to do
// the work anyway.
const importLockKey int64 = 0x6369_6e65 // "cine"

// Importer runs one generation from the dataset host into the catalog.
type Importer struct {
	Store  *Store
	Client *http.Client
	Dir    string
	Logger *slog.Logger

	// Keep leaves the downloaded files on disk. For development: a
	// gigabyte and a half per attempt is a long wait for a bug three
	// lines into the load.
	Keep bool

	// Notify hears the start and each phase. Nil means the log is the
	// only record, which is every run that has no chat configured.
	Notify notify.Sink
}

// Outcome says what an attempt did, for the log and for the alert.
type Outcome struct {
	Ran       bool
	Reason    string
	Counts    Counts
	Integrity float64
	Took      time.Duration
}

// RunOnce is one hour's attempt. It reads the five stamps, and runs a
// whole import only when all five have moved past what was published.
//
// Every way of stopping leaves the live catalog exactly as it was.
func (im *Importer) RunOnce(ctx context.Context) (Outcome, error) {
	started := time.Now()

	// The lock is taken before the HEADs so two importers do not both
	// spend a request deciding the same thing.
	conn, err := im.Store.pool.Acquire(ctx)
	if err != nil {
		return Outcome{}, fmt.Errorf("catalog: acquire connection: %w", err)
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, importLockKey).Scan(&got); err != nil {
		return Outcome{}, fmt.Errorf("catalog: take import lock: %w", err)
	}
	if !got {
		return Outcome{Reason: "another importer is running"}, nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, importLockKey)
	}()

	published, _, err := im.Store.Published(ctx)
	if err != nil {
		return Outcome{}, err
	}
	opened, err := Head(ctx, im.Client, Files)
	if err != nil {
		// A HEAD that failed is not a reason to guess. The hour is
		// skipped and the alert is the caller's to raise.
		return Outcome{}, err
	}
	if ready, why := Ready(published, opened, Files); !ready {
		im.note(ctx, opened, why)
		return Outcome{Reason: why}, nil
	}

	im.Logger.Info("import starting", "files", len(Files), "step", "1/4 download")
	report(im.Notify, notify.JobImport, notify.Started, "downloading the IMDb files")

	// Last generation's schema goes now rather than at the end of the
	// run that made it, so its readers had the whole gap to finish.
	if err := im.Store.DropRetired(ctx); err != nil {
		return Outcome{}, err
	}

	paths, err := Download(ctx, im.Client, im.Dir, Files, im.Logger, func(text string) {
		report(im.Notify, notify.JobImport, notify.Working, text)
	})
	if err != nil {
		return Outcome{}, err
	}
	if !im.Keep {
		defer Discard(paths)
	}

	// The set is read again now everything is on disk. If anything moved
	// while it was being fetched, what we hold is a mixture.
	after, err := Head(ctx, im.Client, Files)
	if err != nil {
		return Outcome{}, err
	}
	if same, which := Same(opened, after, Files); !same {
		why := fmt.Sprintf("%s moved while the set was being fetched", which)
		im.note(ctx, opened, why)
		return Outcome{Reason: why}, nil
	}

	im.Logger.Info("download complete", "step", "2/4 load")
	report(im.Notify, notify.JobImport, notify.Working, "loading the files")
	counts, integrity, err := im.load(ctx, paths)
	if err != nil {
		return Outcome{}, err
	}

	if err := im.Store.Publish(ctx, opened, counts); err != nil {
		return Outcome{}, err
	}
	im.note(ctx, opened, "published")
	return Outcome{
		Ran: true, Reason: "published", Counts: counts,
		Integrity: integrity, Took: time.Since(started),
	}, nil
}

// note records what this attempt saw. It never fails the attempt: the
// row is for someone looking at the catalog, not for the gate.
func (im *Importer) note(ctx context.Context, gen Generation, outcome string) {
	if err := im.Store.RecordCheck(ctx, gen, outcome); err != nil {
		im.Logger.Warn("record check", "err", err)
	}
}

// load reads the five files into the staging schema, in the order the
// filtering needs: titles first for the allow-list, names last because
// only then is it known who was credited.
func (im *Importer) load(ctx context.Context, paths map[File]string) (Counts, float64, error) {
	if err := im.Store.ResetStaging(ctx); err != nil {
		return Counts{}, 0, err
	}

	report(im.Notify, notify.JobImport, notify.Working, "loading the titles")
	titles, err := OpenFile(paths[TitleBasics])
	if err != nil {
		return Counts{}, 0, err
	}
	kept, n, err := im.Store.LoadTitles(ctx, im.Logger, titles)
	titles.Close()
	if err != nil {
		return Counts{}, 0, err
	}
	im.Logger.Info("loaded titles", "movies", n)
	report(im.Notify, notify.JobImport, notify.Working, "loaded "+count(n)+" titles")

	credited := make(NConsts, 1<<20)

	report(im.Notify, notify.JobImport, notify.Working, "loading the credits")
	principals, err := OpenFile(paths[TitlePrincipals])
	if err != nil {
		return Counts{}, 0, err
	}
	n, err = im.Store.LoadPrincipals(ctx, im.Logger, principals, kept, credited)
	principals.Close()
	if err != nil {
		return Counts{}, 0, err
	}
	im.Logger.Info("loaded principals", "credits", n)
	report(im.Notify, notify.JobImport, notify.Working, "loaded "+count(n)+" credits")

	report(im.Notify, notify.JobImport, notify.Working, "loading the directors")
	crew, err := OpenFile(paths[TitleCrew])
	if err != nil {
		return Counts{}, 0, err
	}
	n, err = im.Store.LoadDirectors(ctx, im.Logger, crew, kept, credited)
	crew.Close()
	if err != nil {
		return Counts{}, 0, err
	}
	im.Logger.Info("loaded directors", "credits", n)
	report(im.Notify, notify.JobImport, notify.Working, "loaded "+count(n)+" director credits")

	report(im.Notify, notify.JobImport, notify.Working, "loading the ratings")
	ratings, err := OpenFile(paths[TitleRatings])
	if err != nil {
		return Counts{}, 0, err
	}
	n, err = im.Store.LoadRatings(ctx, im.Logger, ratings, kept)
	ratings.Close()
	if err != nil {
		return Counts{}, 0, err
	}
	im.Logger.Info("loaded ratings", "rated", n)
	report(im.Notify, notify.JobImport, notify.Working, "loaded "+count(n)+" ratings")

	report(im.Notify, notify.JobImport, notify.Working, "loading the names")
	names, err := OpenFile(paths[NameBasics])
	if err != nil {
		return Counts{}, 0, err
	}
	n, err = im.Store.LoadNames(ctx, im.Logger, names, credited)
	names.Close()
	if err != nil {
		return Counts{}, 0, err
	}
	im.Logger.Info("loaded names", "people", n)
	report(im.Notify, notify.JobImport, notify.Working, "loaded "+count(n)+" people")

	im.Logger.Info("building indexes and making the tables durable",
		"step", "3/4 finish", "note", "this takes a minute or two and logs nothing until it is done")
	report(im.Notify, notify.JobImport, notify.Working, "building the indexes")
	if err := im.Store.Finish(ctx, im.Logger); err != nil {
		return Counts{}, 0, err
	}
	counts, err := im.Store.CountStaging(ctx)
	if err != nil {
		return Counts{}, 0, err
	}
	integrity, err := im.Store.Check(ctx, counts)
	if err != nil {
		return counts, integrity, err
	}
	im.Logger.Info("load checked", "step", "4/4 publish", "integrity", fmt.Sprintf("%.4f", integrity))
	report(im.Notify, notify.JobImport, notify.Working, "publishing the catalog")
	return counts, integrity, nil
}

// Posters are not filled in here. They are learned from an API a title
// at a time, and there are more titles than a generation's gap is long,
// so the job runs continuously beside the importer instead — see
// PosterJob. `meta` outlives every swap, so what it learns is kept.

// StaleAfter is when a catalog is old enough to be worth an alert. IMDb
// publishes daily, so this is a day and a half of slack.
//
// It is deliberately not part of the health check: a stale catalog still
// serves perfectly well, and failing a health check on it would turn a
// late upstream publish into a failed deploy.
const StaleAfter = 36 * time.Hour

// Stale reports whether the published catalog is old enough to alert on.
func (s *Store) Stale(ctx context.Context, now time.Time) (bool, time.Duration, error) {
	_, at, err := s.Published(ctx)
	if err != nil {
		return false, 0, err
	}
	if at.IsZero() {
		return true, 0, nil
	}
	age := now.Sub(at)
	return age > StaleAfter, age, nil
}
