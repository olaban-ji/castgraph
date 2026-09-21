package graph

import (
	"context"
	"errors"
	"os"
	"testing"
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
	g, err := s.Network(ctx, testIDBase+1, 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if n := g.Nodes[0]; n.IMDbRating != 8.7 || n.IMDbVotes != 2081234 {
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
	g, err := s.Network(ctx, testIDBase+2, 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if n := g.Nodes[0]; n.IMDbRating != 7.9 || n.IMDbVotes != 4321 {
		t.Errorf("node after rating write = %+v", n)
	}
}

func TestNetwork(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()

	g, err := s.Network(ctx, testIDBase+1, 1, 100)
	if err != nil {
		t.Fatalf("Network depth 1: %v", err)
	}
	// Depth 1 from A: X and Z in the cast, plus X's other movie B. C is two
	// movie-hops away and must not appear.
	assertNodes(t, g, "m:900000001", "m:900000002", "p:900000011", "p:900000013")
	if len(g.Edges) != 3 {
		t.Errorf("depth 1 edges = %d, want 3: %+v", len(g.Edges), g.Edges)
	}
	// The seed's own cast comes before further hops, top billing first.
	if e := g.Edges[0]; e.Source != "p:900000011" || e.Target != "m:900000001" || e.Role != "Hero" {
		t.Errorf("first edge = %+v, want X->A as Hero", e)
	}
	for _, n := range g.Nodes {
		switch n.ID {
		case "m:900000001":
			want := Node{ID: n.ID, Type: KindMovie, Label: "A", TMDBID: testIDBase + 1, Year: 1999,
				Poster: PosterBaseURL + "/a.jpg", Backdrop: BackdropBaseURL + "/a-wide.jpg",
				Rating: 8.2, Votes: 1234, IMDbID: "tt0133093", IMDbRating: 8.7, IMDbVotes: 2081234}
			if n != want {
				t.Errorf("seed node = %+v, want %+v", n, want)
			}
		case "m:900000002":
			// Known only from a filmography: poster and rating still land, no IMDb id.
			if n.Poster != PosterBaseURL+"/b.jpg" || n.Rating != 7.0 || n.Votes != 500 || n.IMDbID != "" {
				t.Errorf("filmography-only node = %+v", n)
			}
		}
	}

	g, err = s.Network(ctx, testIDBase+1, 2, 100)
	if err != nil {
		t.Fatalf("Network depth 2: %v", err)
	}
	assertNodes(t, g, "m:900000001", "m:900000002", "m:900000003", "p:900000011", "p:900000012", "p:900000013")

	g, err = s.Network(ctx, testIDBase+1, 2, 1)
	if err != nil {
		t.Fatalf("Network limit 1: %v", err)
	}
	if len(g.Edges) != 1 {
		t.Errorf("limit 1 edges = %d, want 1", len(g.Edges))
	}

	// A movie with no cast is still returned as a lone node.
	g, err = s.Network(ctx, testIDBase+4, 1, 100)
	if err != nil {
		t.Fatalf("Network of lone movie: %v", err)
	}
	if len(g.Nodes) != 1 || len(g.Edges) != 0 || g.Nodes[0].Year != 0 {
		t.Errorf("lone movie graph = %+v", g)
	}

	if _, err := s.Network(ctx, testIDBase+99, 1, 100); !errors.Is(err, ErrNotFound) {
		t.Errorf("Network(missing) error = %v, want ErrNotFound", err)
	}
	if _, err := s.Network(ctx, testIDBase+1, MaxNetworkDepth+1, 100); err == nil {
		t.Error("Network(depth too deep): want error")
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

func TestNeighbors(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()

	g, err := s.Neighbors(ctx, "m:900000002", 100)
	if err != nil {
		t.Fatalf("Neighbors(movie): %v", err)
	}
	assertNodes(t, g, "m:900000002", "p:900000011", "p:900000012")

	g, err = s.Neighbors(ctx, "p:900000012", 100)
	if err != nil {
		t.Fatalf("Neighbors(person): %v", err)
	}
	assertNodes(t, g, "p:900000012", "m:900000002", "m:900000003")
	if g.Edges[0].Target != "m:900000002" {
		t.Errorf("person's movies not ordered by year: %+v", g.Edges)
	}

	if _, err := s.Neighbors(ctx, "p:900000099", 100); !errors.Is(err, ErrNotFound) {
		t.Errorf("Neighbors(missing) error = %v, want ErrNotFound", err)
	}
	if _, err := s.Neighbors(ctx, "bogus", 100); err == nil {
		t.Error("Neighbors(bad id): want error")
	}
}

func TestShortestPath(t *testing.T) {
	s := openTestStore(t)
	writeFixture(t, s)
	ctx := context.Background()

	g, err := s.ShortestPath(ctx, testIDBase+1, testIDBase+3)
	if err != nil {
		t.Fatalf("ShortestPath: %v", err)
	}
	// A -X- B -Y- C: four relationships, five nodes.
	if len(g.Edges) != 4 || len(g.Nodes) != 5 {
		t.Errorf("path = %d edges, %d nodes; want 4 and 5", len(g.Edges), len(g.Nodes))
	}

	if _, err := s.ShortestPath(ctx, testIDBase+1, testIDBase+4); !errors.Is(err, ErrNotFound) {
		t.Errorf("ShortestPath(disconnected) error = %v, want ErrNotFound", err)
	}
	if _, err := s.ShortestPath(ctx, testIDBase+1, testIDBase+99); !errors.Is(err, ErrNotFound) {
		t.Errorf("ShortestPath(missing) error = %v, want ErrNotFound", err)
	}
}

func TestParseNodeID(t *testing.T) {
	tests := []struct {
		in       string
		wantKind string
		wantID   int
		wantErr  bool
	}{
		{"m:603", KindMovie, 603, false},
		{"p:6384", KindPerson, 6384, false},
		{"603", "", 0, true},
		{"x:603", "", 0, true},
		{"m:abc", "", 0, true},
		{"m:-1", "", 0, true},
	}
	for _, tt := range tests {
		kind, id, err := ParseNodeID(tt.in)
		if (err != nil) != tt.wantErr || kind != tt.wantKind || id != tt.wantID {
			t.Errorf("ParseNodeID(%q) = %q, %d, %v; want %q, %d, err=%v", tt.in, kind, id, err, tt.wantKind, tt.wantID, tt.wantErr)
		}
	}
}

func TestYearOf(t *testing.T) {
	for in, want := range map[string]int{"1999-03-31": 1999, "2026": 2026, "": 0, "abcd-01-01": 0} {
		if got := YearOf(in); got != want {
			t.Errorf("YearOf(%q) = %d, want %d", in, got, want)
		}
	}
}

func assertNodes(t *testing.T, g *Graph, want ...string) {
	t.Helper()
	got := map[string]bool{}
	for _, n := range g.Nodes {
		got[n.ID] = true
	}
	if len(got) != len(want) {
		t.Errorf("nodes = %v, want %v", keys(got), want)
		return
	}
	for _, id := range want {
		if !got[id] {
			t.Errorf("nodes = %v, missing %s", keys(got), id)
		}
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
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
