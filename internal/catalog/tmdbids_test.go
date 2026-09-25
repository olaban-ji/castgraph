package catalog

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"cinedikt/internal/tmdb"
)

func TestTMDbIDsAreMatchedBestKnownFirstAndOnlyOnce(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.tmdb`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.tmdb_queue`); err != nil {
		t.Fatal(err)
	}

	find := &fakeFinder{
		answers: map[string]tmdb.Found{
			"tt0111161": {ID: 278},
			"tt0133093": {ID: 603},
		},
		errs: map[string]error{
			"tt0000001": errors.New("tmdb down"),
		},
	}
	job := &TMDbIDJob{Store: s, Client: find, Logger: quietLogger(), Batch: 10}
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	asked := find.askedFor()
	// Shawshank, then The Matrix, then Reloaded. The unrated film is
	// last and fails, so it stays on the queue. A documentary and an
	// adult title are never a search hit, so they are never asked.
	if len(asked) != 4 || asked[0] != "tt0111161" || asked[1] != "tt0133093" || asked[2] != "tt0234215" || asked[3] != "tt0000001" {
		t.Fatalf("asked %v", asked)
	}
	if id := tmdbID(t, s, "tt0111161"); id != 278 {
		t.Errorf("shawshank tmdb id = %d", id)
	}
	if id := tmdbID(t, s, "tt0133093"); id != 603 {
		t.Errorf("matrix tmdb id = %d", id)
	}
	if id, ok := tmdbRow(t, s, "tt0234215"); !ok || id != 0 {
		t.Errorf("reloaded stored (%d, asked %v), want asked with no id", id, ok)
	}
	if _, asked := tmdbRow(t, s, "tt0000001"); asked {
		t.Error("a failed lookup was stamped; it will not be retried")
	}

	find.errs = nil
	find.answers["tt0000001"] = tmdb.Found{ID: 1}
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	again := find.askedFor()
	if len(again) != 5 || again[4] != "tt0000001" {
		t.Fatalf("second pass asked %v", again)
	}
	if id := tmdbID(t, s, "tt0000001"); id != 1 {
		t.Errorf("unrated tmdb id = %d", id)
	}

	// Caught up: nothing left to spend a request on.
	if err := job.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if more := find.askedFor(); len(more) != len(again) {
		t.Fatalf("caught up, but asked %v", more)
	}
}

func tmdbID(t *testing.T, s *Store, tconst string) int {
	t.Helper()
	id, _ := tmdbRow(t, s, tconst)
	return id
}

func tmdbRow(t *testing.T, s *Store, tconst string) (int, bool) {
	t.Helper()
	var id *int
	err := s.pool.QueryRow(context.Background(), `
		SELECT tmdb_id FROM meta.tmdb WHERE tconst = $1`, tconst).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false
	}
	if err != nil {
		t.Fatal(err)
	}
	if id == nil {
		return 0, true
	}
	return *id, true
}
