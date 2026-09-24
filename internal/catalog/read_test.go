package catalog

import (
	"context"
	"testing"
)

// publishFixture loads the fixture and makes it live, so the read
// queries have a catalog schema to read.
func publishFixture(t *testing.T, s *Store) {
	t.Helper()
	resetLive(t, s)
	counts := loadFixture(t, s)
	if err := s.Publish(context.Background(), genAt(at(24, 0, 42)), counts); err != nil {
		t.Fatal(err)
	}
}

func TestGridIsTheAnchorItsPeopleAndTheirFilms(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	g, err := s.Grid(ctx, "tt0133093")
	if err != nil {
		t.Fatal(err)
	}
	if g.Anchor.Title != "The Matrix" || g.Anchor.Year != 1999 || !g.Anchor.IsAnchor {
		t.Errorf("anchor = %+v", g.Anchor)
	}
	if g.Anchor.Rating == nil || *g.Anchor.Rating != 8.7 {
		t.Errorf("anchor rating = %v", g.Anchor.Rating)
	}

	// Three billed cast and both directors.
	byID := map[string]Person{}
	for _, p := range g.People {
		byID[p.ID] = p
	}
	if len(g.People) != 5 {
		t.Errorf("people = %d, want 5: %+v", len(g.People), g.People)
	}
	if got := byID["nm0000206"]; got.Role != "cast" || got.Character != "Neo" {
		t.Errorf("Keanu = %+v", got)
	}
	for _, id := range []string{"nm0905154", "nm0905152"} {
		if got := byID[id]; got.Role != "director" {
			t.Errorf("%s = %+v, want a director", id, got)
		}
	}

	// The spine holds both Matrix films: Reloaded is there through
	// Keanu and the Wachowskis. Shawshank is not, because nobody on
	// The Matrix worked on it.
	on := map[string]bool{}
	for _, f := range g.Films {
		on[f[0].(string)] = true
	}
	for _, want := range []string{"tt0133093", "tt0234215"} {
		if !on[want] {
			t.Errorf("%s is missing from the spine", want)
		}
	}
	if on["tt0111161"] {
		t.Error("Shawshank is on The Matrix's map")
	}
}

func TestSpineLeavesOutWhatAMapDoesNotHold(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	// Tim Robbins is on Shawshank and on the unrated 1930 film, so his
	// map shows what the film rules do and do not admit.
	g, err := s.Grid(ctx, "tt0111161")
	if err != nil {
		t.Fatal(err)
	}
	on := map[string]bool{}
	for _, f := range g.Films {
		on[f[0].(string)] = true
	}
	// An unrated film is placed: it sits in the unrated column rather
	// than being dropped.
	if !on["tt0000001"] {
		t.Error("the unrated film is missing; it belongs in the unrated column")
	}
	for _, f := range g.Films {
		if f[0].(string) == "tt0000001" && f[2] != nil {
			t.Errorf("the unrated film has a rating: %v", f[2])
		}
	}
	// A documentary and an adult title are stored but never mapped.
	if on["tt0000002"] || on["tt0000003"] {
		t.Error("a documentary or adult title reached a map")
	}
}

func TestGridRefusesWhatItCannotMap(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	if _, err := s.Grid(ctx, "tt9999999"); err == nil {
		t.Error("an unknown id built a map")
	}
	// Television never reached titles at all.
	if _, err := s.Grid(ctx, "tt9999001"); err == nil {
		t.Error("a television episode built a map")
	}
	// A movie with nobody billed has no map to draw.
	if _, err := s.Grid(ctx, "tt0000002"); err == nil {
		t.Error("a film with no people built a map")
	}
}

func TestFilmsSayWhoOfTheAnchorsPeopleIsOnThem(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	publishFixture(t, s)

	got, err := s.Films(ctx, "tt0133093", []string{"tt0133093", "tt0234215"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("films = %d", len(got))
	}
	by := map[string]Movie{}
	for _, m := range got {
		by[m.ID] = m
	}
	if !by["tt0133093"].IsAnchor || by["tt0234215"].IsAnchor {
		t.Error("the anchor flag is on the wrong card")
	}
	// Reloaded carries Keanu and both Wachowskis, who are the anchor's
	// people; nobody else on it is a marker.
	people := by["tt0234215"].People
	if len(people) != 3 {
		t.Errorf("Reloaded's markers = %v, want three of The Matrix's people", people)
	}
	if by["tt0234215"].Title != "The Matrix Reloaded" {
		t.Errorf("title = %q", by["tt0234215"].Title)
	}
}
