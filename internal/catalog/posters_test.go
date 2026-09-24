package catalog

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"cinedikt/internal/omdb"
)

// fakeOMDb answers from a table and records what it was asked for. The
// job runs several lookups at once, so this is behind a mutex.
type fakeOMDb struct {
	mu      sync.Mutex
	answers map[string]omdb.Title
	errs    map[string]error
	asked   []string
}

func (f *fakeOMDb) Lookup(_ context.Context, id string) (omdb.Title, error) {
	f.mu.Lock()
	f.asked = append(f.asked, id)
	err, failed := f.errs[id]
	got := f.answers[id]
	f.mu.Unlock()
	if failed {
		return omdb.Title{}, err
	}
	return got, nil
}

// askedFor is everything it was asked about, as a set.
func (f *fakeOMDb) askedFor() map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]bool, len(f.asked))
	for _, id := range f.asked {
		out[id] = true
	}
	return out
}

func (f *fakeOMDb) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.asked)
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPosterJobAsksForTheMostVotedFirst(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.posters`); err != nil {
		t.Fatal(err)
	}

	fake := &fakeOMDb{answers: map[string]omdb.Title{
		"tt0111161": {Poster: "https://x/shawshank.jpg", Released: time.Date(1994, 9, 23, 0, 0, 0, 0, time.UTC)},
		"tt0133093": {Poster: "https://x/matrix.jpg", Released: time.Date(1999, 3, 31, 0, 0, 0, 0, time.UTC)},
	}}
	// One worker, so the order it claims them in is the order it asks.
	// With several the claim order is still by votes; only the moment
	// each answer lands stops being deterministic.
	job := &PosterJob{Store: s, Client: fake, Logger: quietLogger(), Batch: 100, Workers: 1}
	if err := job.Run(ctx, Live); err != nil {
		t.Fatal(err)
	}

	// Shawshank has the most votes, then The Matrix, then Reloaded. The
	// films anyone searches get their posters in the first minutes.
	if fake.count() < 3 {
		t.Fatalf("asked for %v", fake.asked)
	}
	for i, want := range []string{"tt0111161", "tt0133093", "tt0234215"} {
		if fake.asked[i] != want {
			t.Errorf("ask %d = %s, want %s (order is by votes)", i, fake.asked[i], want)
		}
	}

	// And an adult title is never looked up: it is never shown.
	if fake.askedFor()["tt0000003"] {
		t.Error("an adult title was looked up")
	}
}

func TestPosterJobStillTakesTheMostVotedFirstWithWorkers(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.posters`); err != nil {
		t.Fatal(err)
	}
	fake := &fakeOMDb{answers: map[string]omdb.Title{}}
	// A batch smaller than the catalog, so the first round is the top
	// slice by votes and nothing else can have been claimed yet.
	job := &PosterJob{Store: s, Client: fake, Logger: quietLogger(), Batch: 2, Workers: 8}
	if err := job.Run(ctx, Live); err != nil {
		t.Fatal(err)
	}
	asked := fake.askedFor()
	for _, want := range []string{"tt0111161", "tt0133093"} {
		if !asked[want] {
			t.Errorf("%s was never asked about", want)
		}
	}
	if asked["tt0000003"] {
		t.Error("an adult title was looked up")
	}
}

func TestPosterJobStoresWhatItLearnsAndDoesNotAskTwice(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.posters`); err != nil {
		t.Fatal(err)
	}

	fake := &fakeOMDb{
		answers: map[string]omdb.Title{
			"tt0133093": {Poster: "https://x/matrix.jpg", Released: time.Date(1999, 3, 31, 0, 0, 0, 0, time.UTC)},
		},
		errs: map[string]error{
			// Answered, with nothing to give: that is still an answer.
			"tt0234215": omdb.ErrNotFound,
			// The lookup itself failed: worth asking again.
			"tt0000001": errors.New("dial tcp: connection refused"),
		},
	}
	job := &PosterJob{Store: s, Client: fake, Logger: quietLogger(), Batch: 100, Workers: 1}
	if err := job.Run(ctx, Live); err != nil {
		t.Fatal(err)
	}

	var url *string
	var released *time.Time
	var status string
	if err := s.pool.QueryRow(ctx,
		`SELECT poster_url, released, status FROM meta.posters WHERE tconst = 'tt0133093'`).
		Scan(&url, &released, &status); err != nil {
		t.Fatal(err)
	}
	if url == nil || *url != "https://x/matrix.jpg" || status != "ok" {
		t.Errorf("matrix poster = %v %q", url, status)
	}
	if released == nil || released.Format("2006-01-02") != "1999-03-31" {
		t.Errorf("matrix released = %v", released)
	}

	if err := s.pool.QueryRow(ctx,
		`SELECT status FROM meta.posters WHERE tconst = 'tt0234215'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "ok" {
		t.Errorf("a title OMDb answered about is %q, want ok so it is not asked again", status)
	}
	if err := s.pool.QueryRow(ctx,
		`SELECT status FROM meta.posters WHERE tconst = 'tt0000001'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "missing" {
		t.Errorf("a failed lookup is %q, want missing so it is retried", status)
	}

	// A second run asks only about the one that failed.
	fake.asked = nil
	fake.errs = nil
	//nolint:staticcheck // the job is not running; no lock needed here.
	fake.answers["tt0000001"] = omdb.Title{Poster: "https://x/late.jpg"}
	if err := job.Run(ctx, Live); err != nil {
		t.Fatal(err)
	}
	if fake.count() != 1 || fake.asked[0] != "tt0000001" {
		t.Errorf("second run asked for %v, want only the failed one", fake.asked)
	}
}

func TestPosterJobStopsOnQuotaAndOnCancel(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.posters`); err != nil {
		t.Fatal(err)
	}

	// The most voted is asked about first, and it answers "spent". With
	// one worker nothing else can already be in flight.
	quota := &fakeOMDb{errs: map[string]error{"tt0111161": omdb.ErrQuota}}
	job := &PosterJob{Store: s, Client: quota, Logger: quietLogger(), Batch: 100, Workers: 1}
	if err := job.Run(ctx, Live); err != nil {
		t.Errorf("a spent quota was reported as a failure: %v", err)
	}
	if quota.count() != 1 {
		t.Errorf("kept going after the quota was spent: %v", quota.asked)
	}
	var stored int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM meta.posters`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Errorf("a spent quota stored %d rows; nothing was learned", stored)
	}

	// A cancelled budget stops cleanly, and is not an error: the import
	// does not fail because the posters are not finished.
	done, cancel := context.WithCancel(ctx)
	cancel()
	if err := job.Run(done, Live); err != nil {
		t.Errorf("a cancelled job returned %v", err)
	}
}

func TestForgetUnknownPosters(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	// meta outlives every generation, so a real backfill's rows are
	// still here. This test is about the rule, not about them.
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.posters`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO meta.posters (tconst, poster_url, status, fetched_at)
		VALUES ('tt0133093','https://x/m.jpg','ok',now()), ('tt404','https://x/gone.jpg','ok',now())
		ON CONFLICT (tconst) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	n, err := s.ForgetUnknownPosters(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("forgot %d rows, want 1", n)
	}
	var still bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM meta.posters WHERE tconst = 'tt0133093')`).Scan(&still); err != nil {
		t.Fatal(err)
	}
	if !still {
		t.Error("a poster for a film still in the catalog was forgotten")
	}
}
