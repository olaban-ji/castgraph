package graph

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"testing"
	"time"
)

// Integration test against a live Neo4j. Set NEO4J_TEST_URI (and optionally
// NEO4J_TEST_USER / NEO4J_TEST_PASSWORD) to run it. Fixture ids start at
// testIDBase so they never collide with real TMDb ids.
const testIDBase = 900_000_000

func openTestStore(t *testing.T) *Store {
	t.Helper()
	uri := os.Getenv("NEO4J_TEST_URI")
	if uri == "" {
		t.Skip("NEO4J_TEST_URI not set")
	}
	user := os.Getenv("NEO4J_TEST_USER")
	if user == "" {
		user = "neo4j"
	}
	ctx := context.Background()
	s, err := Open(ctx, uri, user, os.Getenv("NEO4J_TEST_PASSWORD"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatalf("EnsureSchema: %v", err)
	}
	cleanup := func() {
		_, err := s.run(ctx, `MATCH (n) WHERE n.id >= $base DETACH DELETE n`, map[string]any{"base": testIDBase})
		if err != nil {
			t.Errorf("cleanup: %v", err)
		}
	}
	cleanup()
	t.Cleanup(func() { cleanup(); s.Close(ctx) })
	return s
}

// Fixture: A (1999) and B (2003) share actor X; B and C (2010) share actor Y.
// D is disconnected.
func writeFixture(t *testing.T, s *Store) {
	t.Helper()
	ctx := context.Background()
	movieA := Movie{ID: testIDBase + 1, Title: "A", ReleaseDate: "1999-03-31", PosterPath: "/a.jpg", BackdropPath: "/a-wide.jpg", Rating: 8.2, VoteCount: 1234, IMDbID: "tt0133093", IMDbRating: 8.7, IMDbVotes: 2081234}
	movieB := Movie{ID: testIDBase + 2, Title: "B", ReleaseDate: "2003-05-15", PosterPath: "/b.jpg", Rating: 7.0, VoteCount: 500}
	movieC := Movie{ID: testIDBase + 3, Title: "C", ReleaseDate: "2010-07-16"}
	movieD := Movie{ID: testIDBase + 4, Title: "D", ReleaseDate: ""}
	x := Person{ID: testIDBase + 11, Name: "X", Popularity: 40}
	y := Person{ID: testIDBase + 12, Name: "Y", Popularity: 20}
	z := Person{ID: testIDBase + 13, Name: "Z", Popularity: 1}

	if err := s.WriteMovieCast(ctx, movieA, []CastEntry{
		{Person: x, Character: "Hero", Order: 0},
		{Person: z, Character: "Extra", Order: 30},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, x, []FilmCredit{
		{Movie: movieA, Character: "Hero", Order: 0},
		{Movie: movieB, Character: "Villain", Order: 1},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, y, []FilmCredit{
		{Movie: movieB, Character: "Sidekick", Order: 2},
		{Movie: movieC, Character: "Lead", Order: 0},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteMovieCast(ctx, movieD, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWritesAreIdempotent(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	writeFixture(t, s)

	ctx := context.Background()
	records, err := s.run(ctx, `
		MATCH (n) WHERE n.id >= $base
		WITH count(n) AS nodes
		MATCH ()-[r:ACTED_IN]->(m:Movie) WHERE m.id >= $base
		RETURN nodes, count(r) AS rels`, map[string]any{"base": testIDBase})
	if err != nil {
		t.Fatal(err)
	}
	nodes, _ := records[0].Get("nodes")
	rels, _ := records[0].Get("rels")
	// 4 movies + 3 people; X->A is written by both calls and merges into one edge.
	if nodes != int64(7) || rels != int64(5) {
		t.Errorf("after two identical writes: %v nodes, %v rels; want 7 and 5", nodes, rels)
	}
}

func TestIMDbRatingSurvivesWriteWithoutOne(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()
	// A later crawl with OMDb unavailable must not blank the stored rating.
	if err := s.WriteMovieCast(ctx, Movie{ID: testIDBase + 1, Title: "A", IMDbID: "tt0133093"}, nil, nil); err != nil {
		t.Fatal(err)
	}
	n, err := s.movie(ctx, testIDBase+1)
	if err != nil {
		t.Fatal(err)
	}
	if n.IMDbRating != 8.7 || n.IMDbVotes != 2081234 {
		t.Errorf("after rating-less write, node = %+v", n)
	}
}

func TestWriteIMDbRating(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()
	if err := s.WriteIMDbRating(ctx, testIDBase+2, 7.9, 4321); err != nil {
		t.Fatal(err)
	}
	n, err := s.movie(ctx, testIDBase+2)
	if err != nil {
		t.Fatal(err)
	}
	if n.IMDbRating != 7.9 || n.IMDbVotes != 4321 {
		t.Errorf("node after rating write = %+v", n)
	}
}

func TestMovieCrawled(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()
	tests := []struct {
		name string
		id   int
		want bool
	}{
		{"written with cast", testIDBase + 1, true},
		{"written with empty cast", testIDBase + 4, true},
		{"known only from a filmography", testIDBase + 2, false},
		{"missing", testIDBase + 99, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.MovieCrawled(ctx, tt.id)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("MovieCrawled(%d) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

func TestMovieCrawledNeedsDirectorBackfill(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()
	// A crawl from before directors were stored: cast is present, the
	// flag is not, and no DIRECTED edge exists.
	if _, err := s.run(ctx, `MATCH (m:Movie {id: $id}) REMOVE m.directors_crawled`, map[string]any{"id": testIDBase + 1}); err != nil {
		t.Fatal(err)
	}
	got, err := s.MovieCrawled(ctx, testIDBase+1)
	if err != nil {
		t.Fatal(err)
	}
	if got {
		t.Error("MovieCrawled = true, want false so the next request backfills directors")
	}
}

func TestYearOf(t *testing.T) {
	for in, want := range map[string]int{"1999-03-31": 1999, "2026": 2026, "": 0, "abcd-01-01": 0} {
		if got := YearOf(in); got != want {
			t.Errorf("YearOf(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestPathways(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()

	// B's cast is X (order 1) and Y (order 2); each has one other dated film.
	pw, err := s.Pathways(ctx, testIDBase+2, 5, 5, PathwayFilter{})
	if err != nil {
		t.Fatalf("Pathways: %v", err)
	}
	if pw.Movie.ID != "m:900000002" || len(pw.Cast) != 2 {
		t.Fatalf("pathways = %+v", pw)
	}
	if pw.Cast[0].Person.ID != "p:900000011" || pw.Cast[0].Role != "Villain" || len(pw.Cast[0].Films) != 1 || pw.Cast[0].Films[0].ID != "m:900000001" {
		t.Errorf("first pathway = %+v", pw.Cast[0])
	}
	if pw.Cast[0].Person.Popularity != 40 {
		t.Errorf("X popularity = %v, want 40", pw.Cast[0].Person.Popularity)
	}
	// The connecting actor's role in the film they lead to comes along.
	if f := pw.Cast[0].Films[0]; f.Role != "Hero" || f.Order != 0 {
		t.Errorf("X's film A credit = %+v, want Hero/0", f)
	}
	if pw.Cast[1].Person.ID != "p:900000012" || pw.Cast[1].Films[0].ID != "m:900000003" {
		t.Errorf("second pathway = %+v", pw.Cast[1])
	}

	// A's cast is X and Z; Z has no other film, so only X leads anywhere.
	pw, err = s.Pathways(ctx, testIDBase+1, 5, 5, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 1 || pw.Cast[0].Person.ID != "p:900000011" {
		t.Errorf("A pathways = %+v", pw.Cast)
	}

	// Limits apply.
	pw, err = s.Pathways(ctx, testIDBase+2, 1, 5, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 1 {
		t.Errorf("costars=1 gave %d pathways", len(pw.Cast))
	}

	// Billing gate: Y is billed 2nd in B and leads (0th) in C; X is 1st in
	// B and 0th in A. With MaxBilling 1, Y is out; with 2, Y is in.
	pw, err = s.Pathways(ctx, testIDBase+2, 5, 5, PathwayFilter{MaxBilling: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 1 || pw.Cast[0].Person.ID != "p:900000011" {
		t.Errorf("billing<=1 pathways = %+v", pw.Cast)
	}
	// Votes gate: A has 1234 votes, C has none recorded.
	pw, err = s.Pathways(ctx, testIDBase+2, 5, 5, PathwayFilter{MinVotes: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 1 || pw.Cast[0].Films[0].ID != "m:900000001" {
		t.Errorf("minVotes pathways = %+v", pw.Cast)
	}

	if _, err := s.Pathways(ctx, testIDBase+99, 5, 5, PathwayFilter{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("Pathways(missing) error = %v, want ErrNotFound", err)
	}
}

func TestPathwaysIncludesDirector(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()
	d := Person{ID: testIDBase + 14, Name: "D", Popularity: 8}
	movieE := Movie{ID: testIDBase + 5, Title: "E", ReleaseDate: "1994-06-01", VoteCount: 800}
	if err := s.WriteMovieCast(ctx, Movie{ID: testIDBase + 1, Title: "A", ReleaseDate: "1999-03-31", VoteCount: 1234}, nil, []Person{d}); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, d, []FilmCredit{
		{Movie: Movie{ID: testIDBase + 1, Title: "A", ReleaseDate: "1999-03-31", VoteCount: 1234}, Job: JobDirector},
		{Movie: movieE, Job: JobDirector},
	}); err != nil {
		t.Fatal(err)
	}

	pw, err := s.Pathways(ctx, testIDBase+1, 5, 5, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 2 {
		t.Fatalf("A pathways = %d, want lead + director", len(pw.Cast))
	}
	if pw.Cast[0].Person.ID != "p:900000011" {
		t.Errorf("lead = %s, want actor X first in the payload", pw.Cast[0].Person.ID)
	}
	if pw.Cast[1].Person.ID != "p:900000014" || pw.Cast[1].Role != JobDirector {
		t.Errorf("director pathway = %+v", pw.Cast[1])
	}
	if len(pw.Cast[1].Films) != 1 || pw.Cast[1].Films[0].ID != "m:900000005" || pw.Cast[1].Films[0].Role != JobDirector {
		t.Errorf("director films = %+v, want E", pw.Cast[1].Films)
	}

	// Billing does not drop the director.
	pw, err = s.Pathways(ctx, testIDBase+1, 5, 5, PathwayFilter{MaxBilling: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 2 || pw.Cast[1].Role != JobDirector {
		t.Errorf("billing<=1 still includes director: %+v", pw.Cast)
	}
}

func TestSpliceDirectors(t *testing.T) {
	lead := Pathway{Person: Node{ID: "p:1"}, Role: "Hero"}
	other := Pathway{Person: Node{ID: "p:2"}, Role: "Sidekick"}
	dir := Pathway{Person: Node{ID: "p:9"}, Role: JobDirector}
	got := spliceDirectors([]Pathway{lead, other}, []Pathway{dir})
	if len(got) != 3 || got[0].Person.ID != "p:1" || got[1].Person.ID != "p:9" || got[2].Person.ID != "p:2" {
		t.Errorf("spliceDirectors = %+v", got)
	}
	if got := spliceDirectors(nil, []Pathway{dir}); len(got) != 1 || got[0].Person.ID != "p:9" {
		t.Errorf("actors empty: %+v", got)
	}
	if got := spliceDirectors([]Pathway{lead}, nil); len(got) != 1 || got[0].Person.ID != "p:1" {
		t.Errorf("directors empty: %+v", got)
	}
}

func TestRecentFrom(t *testing.T) {
	got := recentFrom(time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC))
	if got != 2024 {
		t.Errorf("recentFrom(2026) = %d, want 2024", got)
	}
}

// A vote count is accumulated attention, so it also measures age: without
// a slot of their own, a star's new film is ranked off the map behind
// their back catalogue. The slot is extra, so nothing else is displaced.
func TestPathwaysKeepsASlotForRecentFilms(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seed := Movie{ID: testIDBase + 21, Title: "Seed", ReleaseDate: "2010-07-16", VoteCount: 40000}
	classic := Movie{ID: testIDBase + 22, Title: "Classic", ReleaseDate: "1997-12-19", VoteCount: 27000}
	midTier := Movie{ID: testIDBase + 25, Title: "MidTier", ReleaseDate: "2002-06-01", VoteCount: 12000}
	fresh := Movie{ID: testIDBase + 23, Title: "Fresh", ReleaseDate: "2025-09-23", VoteCount: 4000}
	star := Person{ID: testIDBase + 24, Name: "Star", Popularity: 9}

	if err := s.WriteMovieCast(ctx, seed, []CastEntry{{Person: star, Character: "Lead", Order: 0}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, star, []FilmCredit{
		{Movie: seed, Character: "Lead", Order: 0},
		{Movie: classic, Character: "Lead", Order: 0},
		{Movie: midTier, Character: "Lead", Order: 0},
		{Movie: fresh, Character: "Lead", Order: 0},
	}); err != nil {
		t.Fatal(err)
	}
	titles := func(pw *Pathways) []string {
		if len(pw.Cast) != 1 {
			t.Fatalf("pathways = %+v, want one person", pw.Cast)
		}
		var out []string
		for _, f := range pw.Cast[0].Films {
			out = append(out, f.Label)
		}
		sort.Strings(out)
		return out
	}

	// Asking for two films gives the two most voted, and the newest beside
	// them: the slot is extra, so MidTier keeps its place.
	s.clock = func() time.Time { return time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC) }
	pw, err := s.Pathways(ctx, seed.ID, 5, 2, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(pw); !slices.Equal(got, []string{"Classic", "Fresh", "MidTier"}) {
		t.Errorf("films in 2026 = %v, want Classic, Fresh, MidTier", got)
	}

	// Once it ages out of the window it competes on votes like anything
	// else, and two films means two films again.
	s.clock = func() time.Time { return time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC) }
	pw, err = s.Pathways(ctx, seed.ID, 5, 2, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(pw); !slices.Equal(got, []string{"Classic", "MidTier"}) {
		t.Errorf("films in 2030 = %v, want Classic, MidTier", got)
	}

	// The slot is not a way round the vote floor.
	s.clock = func() time.Time { return time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC) }
	pw, err = s.Pathways(ctx, seed.ID, 5, 2, PathwayFilter{MinVotes: 10000})
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(pw); !slices.Equal(got, []string{"Classic", "MidTier"}) {
		t.Errorf("films above the vote floor = %v, want Classic, MidTier", got)
	}

	// A film already among the most voted does not also take the slot.
	s.clock = func() time.Time { return time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC) }
	pw, err = s.Pathways(ctx, seed.ID, 5, 5, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(pw); !slices.Equal(got, []string{"Classic", "Fresh", "MidTier"}) {
		t.Errorf("films with room for all = %v, want each once", got)
	}
}

// The slots are a fixed few, so one prolific year cannot swamp a seed.
func TestPathwaysCapsTheRecentSlots(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seed := Movie{ID: testIDBase + 31, Title: "Seed", ReleaseDate: "2010-07-16", VoteCount: 40000}
	classic := Movie{ID: testIDBase + 32, Title: "Classic", ReleaseDate: "1997-12-19", VoteCount: 27000}
	busy := Person{ID: testIDBase + 33, Name: "Busy", Popularity: 9}

	credits := []FilmCredit{
		{Movie: seed, Character: "Lead", Order: 0},
		{Movie: classic, Character: "Lead", Order: 0},
	}
	// Five recent films, most voted first.
	for i := range 5 {
		credits = append(credits, FilmCredit{
			Movie:     Movie{ID: testIDBase + 40 + i, Title: fmt.Sprintf("New%d", i), ReleaseDate: "2025-09-23", VoteCount: 900 - i*100},
			Character: "Lead",
			Order:     0,
		})
	}
	if err := s.WriteMovieCast(ctx, seed, []CastEntry{{Person: busy, Character: "Lead", Order: 0}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, busy, credits); err != nil {
		t.Fatal(err)
	}

	s.clock = func() time.Time { return time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC) }
	pw, err := s.Pathways(ctx, seed.ID, 5, 1, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 1 {
		t.Fatalf("pathways = %+v, want one person", pw.Cast)
	}
	var got []string
	for _, f := range pw.Cast[0].Films {
		got = append(got, f.Label)
	}
	sort.Strings(got)
	// One film by votes, and the three most voted of the new ones.
	if !slices.Equal(got, []string{"Classic", "New0", "New1", "New2"}) {
		t.Errorf("films = %v, want Classic and the top %d new ones", got, recentSlots)
	}
}

// Filtering to a person is a request to see that career, so the query
// answers with it rather than with the slice of it a map has grown.
func TestPathwaysNarrowsToOnePerson(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()

	// B's cast is X and Y; asking for X alone leaves Y out.
	pw, err := s.Pathways(ctx, testIDBase+2, 5, 5, PathwayFilter{PersonID: testIDBase + 11})
	if err != nil {
		t.Fatalf("Pathways: %v", err)
	}
	if len(pw.Cast) != 1 || pw.Cast[0].Person.ID != "p:900000011" {
		t.Fatalf("pathways for X = %+v, want X alone", pw.Cast)
	}
	if len(pw.Cast[0].Films) != 1 || pw.Cast[0].Films[0].ID != "m:900000001" {
		t.Errorf("X's films = %+v, want A", pw.Cast[0].Films)
	}

	// Someone not in this film answers with nothing rather than everyone.
	pw, err = s.Pathways(ctx, testIDBase+2, 5, 5, PathwayFilter{PersonID: testIDBase + 13})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 0 {
		t.Errorf("pathways for someone not in the film = %+v, want none", pw.Cast)
	}

	// Zero still means everyone.
	pw, err = s.Pathways(ctx, testIDBase+2, 5, 5, PathwayFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pw.Cast) != 2 {
		t.Errorf("unfiltered pathways = %d people, want 2", len(pw.Cast))
	}
}
