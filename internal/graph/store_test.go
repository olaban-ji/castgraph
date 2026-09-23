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

// A missing extra does not hold the first screen. The film is written
// once its own cast and directors are; the rest of the careers arrive
// behind that answer.
func TestUnexpandedCastIsThePeopleStillToFetch(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	m := Movie{ID: testIDBase + 200, Title: "M", ReleaseDate: "1999-01-01"}
	seen := Person{ID: testIDBase + 201, Name: "Seen"}
	unseen := Person{ID: testIDBase + 202, Name: "Unseen"}
	if err := s.WriteMovieCast(ctx, m, []CastEntry{
		{Person: seen, Character: "A", Order: 0},
		{Person: unseen, Character: "B", Order: 1},
	}, []Person{{ID: testIDBase + 203, Name: "Helm"}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.MovieCrawled(ctx, m.ID); !got {
		t.Error("the film is written, so the first screen can answer")
	}
	pending, err := s.UnexpandedCast(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) < 2 {
		t.Fatalf("pending = %v, want the people nobody has fetched", pending)
	}
	if err := s.WriteFilmography(ctx, seen, []FilmCredit{
		{Movie: Movie{ID: testIDBase + 204, Title: "Other", ReleaseDate: "2001-01-01"}, Order: 0},
	}); err != nil {
		t.Fatal(err)
	}
	ready, err := s.GridReady(ctx, m.ID, 1)
	if err != nil || !ready {
		t.Errorf("GridReady = %v (%v), want true once someone has been looked at", ready, err)
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

// The grid is the whole map for one film, so the query has to answer with
// the people it is built from and every film those people made.
func TestGrid(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchor := Movie{ID: testIDBase + 50, Title: "Anchor", ReleaseDate: "1999-03-31", Rating: 8.2, VoteCount: 900, PosterPath: "/a.jpg"}
	lead := Person{ID: testIDBase + 51, Name: "Lead"}
	third := Person{ID: testIDBase + 52, Name: "Third"}
	helm := Person{ID: testIDBase + 53, Name: "Helm"}
	other := Movie{ID: testIDBase + 54, Title: "Other", ReleaseDate: "2005-01-01", Rating: 7}
	doc := Movie{ID: testIDBase + 55, Title: "Doc", ReleaseDate: "2010-01-01", Rating: 6, Genres: []int{99}}
	undated := Movie{ID: testIDBase + 56, Title: "Undated", ReleaseDate: ""}
	future := Movie{ID: testIDBase + 58, Title: "Future", ReleaseDate: "2999-01-01"}
	helmed := Movie{ID: testIDBase + 57, Title: "Helmed", ReleaseDate: "1990-01-01", Rating: 7.5}

	if err := s.WriteMovieCast(ctx, anchor, []CastEntry{
		{Person: lead, Character: "Neo", Order: 0},
		{Person: third, Character: "Extra", Order: 2},
	}, []Person{helm}); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, lead, []FilmCredit{
		{Movie: anchor, Character: "Neo", Order: 0},
		{Movie: other, Character: "Someone", Order: 1},
		{Movie: doc, Character: "Self", Order: 0},
		{Movie: undated, Character: "Ghost", Order: 0},
		{Movie: future, Character: "Someday", Order: 0},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, third, []FilmCredit{{Movie: other, Character: "Other", Order: 3}}); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFilmography(ctx, helm, []FilmCredit{
		{Movie: anchor, Job: JobDirector},
		{Movie: helmed, Job: JobDirector},
	}); err != nil {
		t.Fatal(err)
	}

	g, err := s.Grid(ctx, anchor.ID, GridQuery{CastLimit: AllCast, Limit: 40})
	if err != nil {
		t.Fatalf("Grid: %v", err)
	}

	if g.Anchor.ID != anchor.ID || !g.Anchor.IsAnchor || g.Anchor.Year != 1999 {
		t.Errorf("anchor = %+v", g.Anchor)
	}
	// Directors first, then cast by billing.
	var names []string
	for _, p := range g.People {
		names = append(names, p.Name+":"+p.Role)
	}
	if !slices.Equal(names, []string{"Helm:director", "Lead:cast", "Third:cast"}) {
		t.Errorf("people = %v", names)
	}

	byTitle := map[string]GridFilm{}
	for _, f := range g.Films {
		byTitle[f.Title] = f
	}
	if _, ok := byTitle["Doc"]; ok {
		t.Error("a documentary is a credit, not a film the grid should place")
	}
	if _, ok := byTitle["Undated"]; ok {
		t.Error("a film with no year has nowhere to sit on the grid")
	}
	if _, ok := byTitle["Future"]; ok {
		t.Error("an unreleased film has no rating to place it by and nobody has seen it")
	}
	if _, ok := byTitle["Helmed"]; !ok {
		t.Error("a director's own films are missing")
	}
	if got := byTitle["Other"]; len(got.People) != 2 {
		t.Errorf("Other's people = %v, want both actors", got.People)
	}
	// The searched film is a card, and everyone is on it.
	if got := byTitle["Anchor"]; !got.IsAnchor || len(got.People) != 3 {
		t.Errorf("anchor card = %+v, want all three people", got)
	}
	if got := byTitle["Other"].Rating; got == nil || *got != 7 {
		t.Errorf("Other rating = %v, want 7", got)
	}
	if got := byTitle["Anchor"].Poster; got == "" {
		t.Error("the card has no poster to show")
	}
}

// The grid takes the whole cast, so a seventh-billed actor with a long
// career is not cut to keep a fifth-billed one with a short one.
func TestGridTakesEveryCastMember(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchor := Movie{ID: testIDBase + 90, Title: "Anchor", ReleaseDate: "1999-03-31"}
	var cast []CastEntry
	for i := range 9 {
		cast = append(cast, CastEntry{
			Person:    Person{ID: testIDBase + 91 + i, Name: fmt.Sprintf("P%d", i)},
			Character: "C",
			Order:     i,
		})
	}
	if err := s.WriteMovieCast(ctx, anchor, cast, nil); err != nil {
		t.Fatal(err)
	}
	for i, c := range cast {
		if err := s.WriteFilmography(ctx, c.Person, []FilmCredit{
			{Movie: Movie{ID: testIDBase + 110 + i, Title: fmt.Sprintf("F%d", i), ReleaseDate: "2001-01-01"}, Order: 0},
		}); err != nil {
			t.Fatal(err)
		}
	}
	g, err := s.Grid(ctx, anchor.ID, GridQuery{CastLimit: AllCast, Limit: 40})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.People) != 9 {
		t.Fatalf("people = %d, want all nine", len(g.People))
	}
	// Still in billing order, so the chips read as the credits do.
	for i, p := range g.People {
		if p.Name != fmt.Sprintf("P%d", i) {
			t.Errorf("person %d = %s, want P%d", i, p.Name, i)
		}
	}
}

func TestGridCastLimit(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchor := Movie{ID: testIDBase + 60, Title: "Anchor", ReleaseDate: "1999-03-31"}
	var cast []CastEntry
	for i := range 8 {
		p := Person{ID: testIDBase + 61 + i, Name: fmt.Sprintf("P%d", i)}
		cast = append(cast, CastEntry{Person: p, Character: "C", Order: i})
	}
	if err := s.WriteMovieCast(ctx, anchor, cast, nil); err != nil {
		t.Fatal(err)
	}
	for i, c := range cast {
		if err := s.WriteFilmography(ctx, c.Person, []FilmCredit{
			{Movie: Movie{ID: testIDBase + 80 + i, Title: fmt.Sprintf("F%d", i), ReleaseDate: "2001-01-01"}, Order: 0},
		}); err != nil {
			t.Fatal(err)
		}
	}
	g, err := s.Grid(ctx, anchor.ID, GridQuery{CastLimit: 3, Limit: 40})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.People) != 3 {
		t.Fatalf("people = %d, want the top 3 by billing", len(g.People))
	}
	for i, p := range g.People {
		if p.Name != fmt.Sprintf("P%d", i) {
			t.Errorf("person %d = %s, want P%d", i, p.Name, i)
		}
	}
}

// A screen asks for the films it can show. A busy year is not a unit:
// the other film from the anchor's own year comes back one card at a
// time, and the rest of the career waits.
func TestGridReturnsTheFilmsAScreenAskedFor(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchor := Movie{ID: testIDBase + 300, Title: "Anchor", ReleaseDate: "2000-01-01", Rating: 8}
	lead := Person{ID: testIDBase + 301, Name: "Lead"}
	if err := s.WriteMovieCast(ctx, anchor, []CastEntry{{Person: lead, Character: "A", Order: 0}}, nil); err != nil {
		t.Fatal(err)
	}
	var credits []FilmCredit
	for _, year := range []int{1990, 1995, 2000, 2005, 2010} {
		credits = append(credits, FilmCredit{
			Movie: Movie{ID: testIDBase + year, Title: fmt.Sprintf("Y%d", year), ReleaseDate: fmt.Sprintf("%d-01-01", year), Rating: 7},
			Order: 0,
		})
	}
	if err := s.WriteFilmography(ctx, lead, credits); err != nil {
		t.Fatal(err)
	}

	g, err := s.Grid(ctx, anchor.ID, GridQuery{CastLimit: AllCast, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Films) != 3 || !g.MoreBefore || !g.MoreAfter {
		t.Fatalf("screen = %d films, more=%v/%v, %+v", len(g.Films), g.MoreBefore, g.MoreAfter, g.Films)
	}
	var ids []int
	for _, f := range g.Films {
		ids = append(ids, f.ID)
		if f.Year == 1990 || f.Year == 2010 {
			t.Errorf("film %s %d is outside the three cards", f.Title, f.Year)
		}
	}
	if !slices.Contains(ids, anchor.ID) || !slices.Contains(ids, testIDBase+2000) {
		t.Errorf("films = %v, want the anchor and the other film from its year", ids)
	}
	if len(g.People) == 0 || g.People[0].Count < 5 {
		t.Errorf("count = %+v, want the whole career, not the screen", g.People)
	}

	older, err := s.Grid(ctx, anchor.ID, GridQuery{CastLimit: AllCast, Limit: 1, Before: testIDBase + 2000})
	if err != nil {
		t.Fatal(err)
	}
	if len(older.Films) != 1 || older.Films[0].Year != 1995 || !older.MoreBefore {
		t.Fatalf("older = %+v moreBefore=%v", older.Films, older.MoreBefore)
	}
}
