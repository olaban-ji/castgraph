package catalog

import (
	"context"
	"testing"
)

func TestSearchPutsTheOneTheyMeantFirst(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	// "matrix" matches both Matrix films. The one with the votes wins,
	// which is the whole reason ranking is done here rather than taken
	// from whatever order a title match happens to return.
	got, err := s.Search(ctx, "matrix", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("hits = %d: %+v", len(got), got)
	}
	if got[0].ID != "tt0133093" {
		t.Errorf("first hit = %s (%s), want The Matrix", got[0].ID, got[0].Title)
	}
	if got[0].Votes <= got[1].Votes {
		t.Errorf("hits are not in vote order: %d then %d", got[0].Votes, got[1].Votes)
	}
}

func TestSearchPrefersAWholeTitleOverAMentionOfIt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	// Shawshank has far more votes, so only the exact-title rule can
	// put a smaller film above it.
	got, err := s.Search(ctx, "the matrix", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[0].Title != "The Matrix" {
		t.Errorf("first hit = %+v, want the exact title", got)
	}
}

func TestSearchOffersOnlyWhatOpens(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	// A documentary and an adult title are in the catalog and are never
	// mapped, so offering either would be a dead end.
	for _, q := range []string{"documentary", "adult"} {
		got, err := s.Search(ctx, q, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Errorf("%q offered %+v", q, got)
		}
	}
	// And a film with nobody billed has no map to draw.
	for _, h := range mustSearch(t, s, "a ") {
		if h.ID == "tt0000002" {
			t.Error("a film with no people was offered")
		}
	}
}

func TestSearchIgnoresAQueryTooShortToMeanAnything(t *testing.T) {
	s := testStore(t)
	got, err := s.Search(context.Background(), "a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Errorf("a one-character query returned %+v", got)
	}
}

func mustSearch(t *testing.T, s *Store, q string) []Hit {
	t.Helper()
	got, err := s.Search(context.Background(), q, 20)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// assumePostersShow keeps a first-run test off the network. The
// fixture's addresses are not real pictures.
func assumePostersShow(t *testing.T) {
	t.Helper()
	prev := posterMissing
	posterMissing = func(context.Context, string) bool { return false }
	t.Cleanup(func() { posterMissing = prev })
}

func TestFirstRunOffersOneMovieAnEra(t *testing.T) {
	s := testStore(t)
	assumePostersShow(t)
	ctx := context.Background()
	publishFixture(t, s)

	// The fixture's movies need a poster before the cold screen will
	// offer them: a tile with no picture is a grey box.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO meta.posters (tconst, poster_url, status, fetched_at)
		SELECT tconst, 'https://m.media-amazon.com/images/M/x.jpg', 'ok', now()
		FROM catalog.titles
		ON CONFLICT (tconst) DO UPDATE SET poster_url = EXCLUDED.poster_url`); err != nil {
		t.Fatal(err)
	}

	got, err := s.FirstRun(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("the cold screen was offered nothing")
	}
	// One per era, so no era is represented twice and no movie repeats.
	seen := map[string]bool{}
	for _, h := range got {
		if seen[h.ID] {
			t.Errorf("%s was offered twice", h.ID)
		}
		seen[h.ID] = true
		if h.Poster == "" {
			t.Errorf("%s was offered with no poster", h.ID)
		}
	}
	if len(got) > FirstRunCount {
		t.Errorf("offered %d, want at most %d", len(got), FirstRunCount)
	}
}

func TestFirstRunOffersNothingBeforeThePostersArrive(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)
	if _, err := s.pool.Exec(ctx, `DELETE FROM meta.posters`); err != nil {
		t.Fatal(err)
	}
	got, err := s.FirstRun(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	// An empty screen, not eight grey boxes.
	if len(got) != 0 {
		t.Errorf("offered %+v before any poster was known", got)
	}
}

func TestFirstRunSkipsABlankOrMissingPoster(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	prev := posterMissing
	posterMissing = func(_ context.Context, raw string) bool {
		return raw == "https://img.test/gone.jpg"
	}
	t.Cleanup(func() { posterMissing = prev })

	// Reloaded is the only picture in its era that still exists. The
	// Matrix has an empty address, and Shawshank's address 404s. Neither
	// should be offered, and the era should not come up empty while a
	// later candidate is fine.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO meta.posters (tconst, poster_url, status, fetched_at)
		SELECT tconst,
		       CASE tconst
		           WHEN 'tt0234215' THEN 'https://img.test/live.jpg'
		           WHEN 'tt0133093' THEN ''
		           ELSE 'https://img.test/gone.jpg'
		       END,
		       'ok', now()
		FROM catalog.titles
		ON CONFLICT (tconst) DO UPDATE SET poster_url = EXCLUDED.poster_url`); err != nil {
		t.Fatal(err)
	}

	got, err := s.FirstRun(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "tt0234215" {
		t.Fatalf("got %+v, want only the film whose poster still exists", got)
	}
}
